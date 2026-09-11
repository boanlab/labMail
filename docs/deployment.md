# Deployment

## Requirements

- Docker with Compose, or Node 22+ for a local run
- A Google Workspace domain **where you have admin console access**

That second requirement is not optional. LabMail needs default routing, the
`X-Gm-Original-To` header, and DKIM configured at the domain level. If your
domain is administered by a central IT department that will not grant these,
the usual answer is a small separate Workspace tenant for your own domain.

## Bring the service up

```bash
cp .env.example .env
echo "ADMIN_PASSWORD=$(openssl rand -base64 24)" >> .env
docker compose up -d --build
```

Open `http://<host-ip>:8000` and sign in with the credentials from `.env`.

Nothing about Google goes in `.env`. Those are runtime settings entered in the
admin UI, so the container can be deployed before a Google Cloud project exists.

## Connect Google

Sign in as the admin and open **System settings**.

1. **Copy the redirect URI** shown at the top. It follows whatever address the
   browser used, so reaching the service by host IP works with no extra
   configuration.
2. **In Google Cloud Console**: create a project, enable the **Gmail API**, the
   **Admin SDK API** and the **Google Drive API**, then create an OAuth client
   of type **Web application** and register the redirect URI from step 1.
3. **Fill in and save**: organization domain, shared account address, client ID,
   client secret.
4. **Connect Google account.** Sign in as the **shared account**, not as
   yourself. This token is the identity all mail access flows through.
5. **Sync now** for the initial backfill.

After that, sync runs on an interval inside the container.

## Google Admin console

Three separate settings, all under **Apps → Google Workspace → Gmail** at
<https://admin.google.com>. They are easy to conflate — the envelope rewrite and
the header are two different rules on the same page — and each one's absence
produces the same symptom: mail that arrives in Gmail but never reaches a
member in LabMail.

Before any of them, **the shared account must exist**: the mailbox all mail
actually lands in, and the account you connect in system settings.

### 1. Default routing — deliver domain mail to the shared account

**Routing → Default routing → Add setting** (or Configure).

| Field | Value |
|---|---|
| Envelope recipients to match | **All recipients** |
| Action | **Change envelope recipient** → replace with the shared account, e.g. `crew@example.com` |

This is what lets a member address receive mail without existing as an account
first. Approved members are Google Groups and would be delivered anyway, but
anyone not yet approved — and the operator account's own address, which is not
provisioned as a group — depends entirely on this rule.

### 2. Routing — add the `X-Gm-Original-To` header

**Routing → Routing → Add setting.** A *different* rule from the one above.
Do not try to do both in one setting.

| Section | What to check |
|---|---|
| 1. Messages to affect | **Inbound** and **Internal - receiving**. Leave both sending options unchecked — outbound mail does not need the header. |
| 2. Also apply to all account types | **All three**: Users, Groups, and unrecognized / catch-all accounts. |
| Headers | **Add X-Gm-Original-To header** |

**Checking "Groups" is not optional.** LabMail creates each member address as a
Google Group with the shared mailbox as its only member (see
`src/google/provisioning.ts`), so every approved member's mail arrives as group
mail. Leaving that box unchecked means the header lands on everything *except*
the mail that needed it.

Leave subject rewriting and envelope-recipient changes alone in this rule; the
envelope belongs to setting 1.

Why it matters: ownership is resolved from headers in the order
`x-gm-original-to` → `x-beenthere` → `delivered-to` → `to` → `cc` (see
`src/google/ownership.ts`). Ordinary mail resolves from `to` alone. **BCC does
not** — the recipient appears in no header at all, so without the envelope
recipient there is nothing to attribute it to.

Note which of the two supplies it. A provisioned member address is a Google
Group with the shared mailbox as its only member, so their mail arrives as a
group redistribution: `Delivered-To` names the shared account and this rule's
header does not survive the second hop. What names the member is the group's
own `X-BeenThere`, which is present regardless. The routing rule matters for
addresses that exist only as routing targets — a member approved but not yet
provisioned, or an operator account's own address.

### 3. DKIM

**Authenticate email → Generate new record**, add the TXT record it shows to
your domain's DNS, then **Start authentication**.

Required for member mail to pass DMARC at the recipient. Without it, mail sent
from a member address is liable to be filtered on the far end.

### Verifying

Send a message from an outside mailbox to a member address, wait for a sync
tick, and check that it was attributed rather than left unassigned:

```bash
docker exec labmail node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database(process.env.DATABASE_PATH, { readonly: true });
for (const m of db.prepare('SELECT id, subject, routing_headers FROM messages ORDER BY id DESC LIMIT 5').all()) {
  console.log(m.id, m.subject, m.routing_headers);
}
console.log('owners:', db.prepare('SELECT * FROM message_owners').all());
"
```

`routing_headers` should contain an `x-gm-original-to` entry. If it does not,
setting 2 is missing or does not cover that account type.

Adding Drive later means the stored token lacks the new scope: reconnect from
system settings to consent again.

### Each domain separately

The three settings above are per domain. A secondary domain carrying member
addresses needs its own default routing rule, its own `X-Gm-Original-To` rule
and its own DKIM key, or mail for it arrives unattributed — or not at all.

## Adding members

Members sign up through the web UI. Signup records only the requested local
part; the address is composed when an admin approves, which is also when the
Group that delivers to it is created.

## Behind a reverse proxy

Set `PUBLIC_URL` to the externally visible origin and register the matching
redirect URI in Cloud Console:

```
PUBLIC_URL=https://mail.example.com
```

The proxy should forward `X-Forwarded-Proto` and `X-Forwarded-Host`. Terminate
TLS there — session cookies are not marked `Secure`, so plain HTTP beyond a
trusted network exposes them.

That covers the web interface. SMTP and IMAP need a TCP proxy rather than an
HTTP one, and are described in [mail-clients.md](mail-clients.md).

## Backups

Everything lives in the `labmail-data` volume: mirrored mail, member accounts,
and the Google refresh token.

```bash
docker compose exec labmail \
  node --experimental-strip-types src/scripts/backup.ts /app/data/backups --verify --keep 14
```

This copies through SQLite's own backup API rather than `cp`. The database runs
in WAL mode, so a plain file copy taken mid-write yields a torn snapshot that
only fails later, when it is needed. The script then runs `integrity_check` on
the copy, gzips it, and — with `--verify` — decompresses the archive it just
wrote and opens *that*, comparing row counts against the source. A backup nobody
has restored is a guess.

`--keep N` prunes older archives. Put it on a timer:

```
0 3 * * *  docker compose -f /path/docker-compose.yml exec -T labmail \
             node --experimental-strip-types src/scripts/backup.ts \
             /app/data/backups --verify --keep 14
```

The archives sit inside the same volume, which protects against corruption but
not against losing the host. Copy them off the machine as well.

Treat every archive as sensitive: it contains message bodies in the clear, and
the Google refresh token.

## Monitoring

`GET /healthz` is liveness plus sync detail:

```json
{ "ok": true, "connected": true,
  "sync": { "ok": true, "staleSeconds": 41, "consecutiveFailures": 0, "lastError": null } }
```

It always returns 200 while the process is serving. A Google outage must not
make the container look dead and invite a restart that cannot help, so the
decision about what matters is left to whatever is watching. Alert on:

- `connected: false` — Google was never configured, or the token was revoked
- `sync.staleSeconds` beyond a few multiples of the sync interval
- `sync.consecutiveFailures` climbing

`sync.lastError` carries the reason verbatim; it is the same text the operator
sees in system settings. The log records the first failure loudly and then every
tenth, so a persistent outage stays visible without burying everything else.

## Checking the routing rules took effect

Default routing and the `X-Gm-Original-To` header cannot be read back from
Google, so they are inferred from mail that actually arrived:

```bash
docker compose exec labmail \
  node --experimental-strip-types src/scripts/diagnose-routing.ts
```

It reports what proportion of externally sent mail carried the envelope
recipient, what the receiving side concluded about DKIM, and how much mail is
sitting unattributed. Run it after sending one message from an outside mailbox
to a member address.

## Operating notes

- **Sending is capped per account, not per member.** One Workspace account's
  daily recipient limit is divided among everyone. Ten members on a 2,000/day
  limit is 200 each.
- **Storage is shared.** Large attachments accumulate against one quota.
- **Check the unassigned queue** occasionally. Messages whose recipient could
  not be resolved wait there for an admin to route.
- **Deactivate departing members rather than deleting them.** Deactivation stops
  login and sending, but mail to their address still arrives and stays
  attributed to them — which is the point of a shared mailbox.

## Upgrading

```bash
git pull
docker compose up -d --build
```

The schema applies itself on start. Check [CHANGELOG.md](../CHANGELOG.md) for
anything requiring manual action.
