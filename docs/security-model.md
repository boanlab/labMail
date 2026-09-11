# Security model

This document explains what LabMail protects, what it does not, and why.
[SECURITY.md](../SECURITY.md) covers vulnerability reporting.

## What LabMail is

One Google Workspace mailbox presented to several people as if each had their
own address. Members authenticate to LabMail, never to Google.

## Isolation is enforced in application code

The Google account holds one undifferentiated mailbox. Everything that separates
one member's view from another's is a query in this codebase.

Controls that make that hold:

- **One join, no alternatives.** Every read of a message joins `message_owners`
  on the session alias. There is no secondary filter and no default scope.
- **No user input in scoping.** Mailbox names and filters select from fixed
  whitelists of SQL predicates. Search binds its term as a parameter and escapes
  LIKE wildcards, so `%` cannot widen a query.
- **Ownership checked before side effects.** Label changes and attachment reads
  verify ownership before any Gmail call, so an unowned id returns 404 rather
  than acting on another member's mail.
- **`From` is server-side.** The compose payload cannot influence the sender.
- **Accounts without an address are refused, not defaulted.** The bootstrap
  admin has no alias until one is assigned; mail routes reject rather than
  falling back to an unscoped read.

Tests in `test/isolation.test.ts` assert these directly, including that knowing
another member's message id does not grant access.

### How ownership is decided

`src/google/ownership.ts` resolves it once, when a message arrives, from the
strongest evidence the message carries:

| Source | Why |
|---|---|
| `X-Gm-Original-To` | The envelope recipient, written by Workspace default routing. Survives BCC. |
| `X-BeenThere` | The address a Google Group received on. Every provisioned member address is a Group, so this is what names them; also survives BCC. |
| Sender | Google's send-as confirmations are routed to the operators whatever address they were sent to: they carry a code only an operator can act on. |
| `Delivered-To` | Present on some delivery paths. Names the shared account on group redistribution, so it rarely decides anything. |
| `To`, `Cc` | Ordinary addressing. |
| `From` | Only when the message carries the `SENT` label. |

Two properties matter. **`From` is gated on `SENT`**, because otherwise a
spoofed `From` header would let anyone push a message into a member's mailbox.
And **a message can have several owners**: mail addressed to two members
arrives as one Gmail message, since delivery into a single mailbox is
deduplicated, but belongs to both. Messages that resolve to nobody are left
unattributed and surfaced in an admin queue rather than guessed at.

The alternative — translating each mailbox into a Gmail search such as
`to:hong@example.com in:inbox` — fails badly. Query strings are built by
concatenation, so any path that lets request input reach the string, or that
omits a clause, returns another member's mail. Results come back either way;
they are simply the wrong ones.

### What belongs to a member rather than to the mailbox

Read, starred and archived live in `message_state`, keyed by member. Two
members can own the same message, so storing these on the shared Gmail labels
meant one member's actions were visible to the other. Inbox and Archive follow
from the member's own flag rather than from Gmail's `INBOX` label, because
removing that label would archive the message for everyone who owns it. Trash
and Spam stay on the label, since those really are states of the shared
mailbox.

The one label reflected back is `UNREAD`, and only once every owner of the
message has read it. Reading stays per member; this keeps the shared mailbox
from showing unread mail nobody is waiting on, and the label returns the moment
one owner marks it unread again.

Categories and rules are scoped the same way, by alias. Rule actions write only
these per-member tables, so one member's rules cannot move, hide or mark
another's mail. Gmail labels could not have provided this: one mailbox serves
everyone, so a label is visible to all of them.

### What is recorded

`audit_log` holds who opened which message, who sent what, and every
administrative decision — including reading the log itself. Since separation is
enforced here rather than by Google, this is the only way to answer afterwards
whether someone reached a colleague's mail. It stores message ids, never
subjects or bodies: a second copy of the mail under different access rules
would be a liability rather than a record.

### The consequence

A missing join is not a display bug. It exposes the entire mailbox.

If your organization needs genuine per-user isolation — regulatory requirements,
or members who are not mutually trusted — provision real Workspace accounts
instead. LabMail suits a mailbox that has a real reason to be shared, such as
continuity of correspondence when members join and leave.

## Operational rules that code cannot enforce

**Never distribute the shared account password.** Anyone who signs in to Gmail
directly sees everyone's mail. This is the most likely way a deployment leaks.

**Protect the database.** `labmail.db` holds every mirrored message body and the
Google refresh token in the clear. Filesystem access to it is equivalent to
mailbox access. It is also the only thing that needs backing up.

**Terminate TLS before exposing the service.** Session cookies are `HttpOnly`
and `SameSite=Lax` but not `Secure`, because the default deployment is plain
HTTP on a local address. Put a TLS proxy in front and set `PUBLIC_URL` before
the service is reachable from an untrusted network.

## Authentication

Passwords are hashed with scrypt and a per-password salt, compared in constant
time. Login verifies a password even when the username does not exist, so
response timing does not reveal which accounts are real.

Sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie,
stored server-side and resolved on every request. Deactivating an account
invalidates its sessions immediately, because the lookup joins on account
status rather than trusting the cookie alone.

## What a member is

A member is an address with a purpose — `support@`, `contact@`, `admin@` — and
a sign-in that reaches only the mail for it. Several can belong to one person;
that is the ordinary case, and the reason the split exists is to keep one queue
out of another rather than one person out of another's mail.

It is not a substitute for a Workspace account. Everyone who signs in is using
the Workspace service through the shared account, whatever the address is
called, and Workspace is licensed per person. The isolation here is also a
presentation layer rather than a boundary, as the rest of this document
explains, so an arrangement that needs one person kept out of another's mail
needs separate accounts.

## Signup and approval

Signup records the requested address and creates a pending account. The whole
address is the sign-in name, since the same local part under two domains is two
different people. It never reveals whether the deployment has been configured —
that check happens at approval, where the admin sees it.

Approval composes the address and creates the Group that delivers to it before
activating the account, so a member never holds an address that does not yet
receive.

Sending is a separate gate. The send-as entry cannot be created under user
OAuth, so it is added by hand and `provisioned` tracks whether it exists;
without it Gmail rewrites From to the shared account, and both send routes
answer 409 rather than let a message leave under the wrong identity. The flag is
reconciled on every sync tick, in both directions.

## Rendering untrusted content

HTML message bodies render in an iframe with an empty `sandbox` attribute: no
scripts, no forms, no top-level navigation, and a null origin. A message cannot
reach LabMail's cookies or DOM.

Display names and header values built from user input have CR and LF stripped
before they enter a MIME message, so a crafted name cannot inject headers such
as an extra `Bcc`.

## OAuth and credentials

LabMail requests `gmail.modify` rather than full mail access, so a bug cannot
permanently destroy mail — deletions move to Trash and remain recoverable.
`gmail.settings.basic` reads the send-as entries and `gmail.settings.sharing`
removes one when a member leaves; `admin.directory.group` creates member
addresses and `admin.directory.user` reads the directory to see whether an
address is already claimed.

The consent flow uses a single-use `state` parameter with a ten-minute lifetime,
held in memory so a restart invalidates an incomplete flow.

Secrets are stored in the database and never returned to the browser. The
settings API reports whether a secret is set, never its value.
