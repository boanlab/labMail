# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/boanlab/labMail/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps but is not required. We will acknowledge receipt and keep you updated on
remediation.

## Supported versions

This project has not reached 1.0. Only the latest commit on the default branch
receives fixes.

## Threat model

### What labMail is

One Google Workspace mailbox, presented to several people as if each had their
own. Members authenticate to labMail — never to Google — and see only the mail
attributed to their alias.

### Isolation is enforced in application code

The Google account holds one undifferentiated mailbox. Separation between
members exists only because labMail's queries enforce it:

- Every read joins `message_owners` on the session alias. There is no second
  filter and no default scope.
- Search runs against the local mirror through that same join, so a crafted
  query cannot widen it.
- Outgoing `From` is set from the session, never from the request body.
- The mailbox name and filter in a request select from a fixed whitelist of SQL
  predicates rather than being interpolated.

A missing join is not a display bug: it exposes the whole mailbox.

Organizations requiring genuine per-user isolation — for regulatory reasons, or
because members are not mutually trusted — should provision real accounts.
labMail suits a mailbox with a legitimate reason to be shared.

### The shared account password must never be distributed

Members must not hold the Google credentials for the shared account. Anyone who
signs in to Gmail directly sees every message. This is an operational rule; no
application code can enforce it.

### The database is the sensitive artifact

`labmail.db` holds every mirrored message body and the Google refresh token in
the clear. Filesystem access to it is equivalent to mailbox access. It is also
the only thing that needs backing up.

### Transport is not secured by default

Session cookies are `HttpOnly` and `SameSite=Lax` but are not marked `Secure`,
because the default deployment is plain HTTP on a local network address. Before
exposing the service beyond a trusted network, terminate TLS in front of it and
set `PUBLIC_URL`.

### Composed HTML

Mail written in the composer is sanitized on the server before it is assembled,
from a tag and attribute allowlist. Entities are resolved before a URL is
judged, so encoded schemes cannot slip through, and attribute values are escaped
on output so an encoded quote cannot start a new attribute. The editor performs
the same cleaning on paste, but that copy is a convenience for the author; the
server pass is the control.

### Rendering untrusted mail

HTML message bodies are rendered in an iframe with an empty `sandbox` attribute:
no scripts, no forms, no top-level navigation, and a null origin, so a message
cannot reach labMail's cookies or DOM.

### OAuth scopes

labMail requests `gmail.modify` rather than full mail access, so a bug cannot
permanently delete mail — deletions move messages to Trash, where they remain
recoverable. It also requests `gmail.settings.sharing` and
`gmail.settings.basic` to register send-as aliases, and
`admin.directory.group` to create member addresses.
