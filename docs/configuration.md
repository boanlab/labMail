# Configuration

LabMail splits configuration in two, along one line: what must exist before
anyone can sign in goes in the environment; everything else is entered through
the admin UI and stored in the database.

That split is what lets you deploy the container before you have a Google Cloud
project.

## Environment variables

Set in `.env` (see `.env.example`). Read once at start.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ADMIN_PASSWORD` | yes | — | Bootstrap operator password. Minimum 12 characters; use a generated value. |
| `ADMIN_USERNAME` | no | `admin` | Bootstrap operator username. |
| `ADMIN_DISPLAY_NAME` | no | `Administrator` | Display name for that account. |
| `PORT` | no | `8000` | Listening port. Binds `0.0.0.0`, and Compose publishes the same number on the host. |
| `DATABASE_PATH` | no | `./data/labmail.db` | SQLite file. Set to `/app/data/labmail.db` in the image. |
| `PUBLIC_URL` | no | — | External origin. Only needed behind a proxy that rewrites `Host`. |
| `AUDIT_RETENTION_DAYS` | no | `365` | How long access records are kept. 0 keeps everything. |
| `SMTP_PORT` | no | `0` | SMTP submission port. 0 leaves it off. |
| `IMAP_PORT` | no | `0` | IMAP port. 0 leaves it off. |
| `SMTP_HOST` / `IMAP_HOST` | no | `127.0.0.1` | Interface they bind. `0.0.0.0` inside a container. |
| `SMTP_PROXY_PROTOCOL` / `IMAP_PROXY_PROTOCOL` | no | `false` | Expect a PROXY protocol header on every connection. |
| `MAIL_BIND` | no | `127.0.0.1` | Interface Compose publishes the plaintext mail ports on. Never one the internet can reach. |
| `MAIL_TRACE` | no | `false` | Log the IMAP and SMTP exchange, credentials redacted. |

The mail ports carry no TLS of their own. See
[mail-clients.md](mail-clients.md) for the proxy in front of them.

### About the bootstrap account

It is a seed, not a source of truth. On start, LabMail creates the account if it
is missing and ensures it is an active admin — but it never resets a password
that was changed afterward.

The account starts with no mail address, because the organization domain is not
known yet. Assign one in system settings once the domain is configured.

## Runtime settings

Entered at **시스템 설정** (System settings) and stored in the `settings` table.
Changes take effect immediately; no restart is needed.

| Setting | Purpose |
|---|---|
| Organization domain | Domains member addresses are built from, without `@`. Several are separated by commas; the first is the default. |
| Shared account address | The Workspace account all mail actually lands in. |
| OAuth client ID | From Google Cloud Console, type **Web application**. |
| OAuth client secret | Write-only. Blank leaves the stored value untouched. |
| Sync interval | Seconds between sync runs. Minimum 15, default 60. |
| Undo send window | Seconds a sent message can be recalled. 0 sends immediately, maximum 60, default 10. |
| Mail client server | Address a mail client connects to. The name of whatever terminates TLS, which may differ from the web address. |
| IMAP port / SMTP port | Ports that address opens. Default 993 and 465. |

The Google refresh token is also stored here, written by the OAuth callback
rather than typed in.

### Sending needs one manual step

A member's address is a Google Group delivering to the shared account, which
LabMail creates on approval. Sending as that address needs a matching send-as
entry, and `gmail.users.settings.sendAs.create` is restricted to service
accounts holding domain-wide authority -- it refuses a user token whatever
admin role stands behind it. An operator adds the entry once, by hand, under
the shared account's mail settings.

Until it exists, sending is refused rather than attempted: with no send-as
entry Gmail silently rewrites From to the shared account, so the recipient
would see the shared mailbox instead of the member. The composer, reply,
reply-all and forward are withheld, both routes that put mail on the wire
return 409, and the sync tick re-checks so the member's ability to send
returns on its own within a minute of the entry appearing.

### More than one domain

A Workspace can carry secondary domains, and member addresses may be issued
under any of them. List them in the organization domain setting:

```
example.com, second.example
```

The signup form then asks which one, and the same local part is free under each
— `hong@example.com` and `hong@second.example` are different people. A member's
sign-in name is their whole address for that reason.

Every domain needs its own routing rules and DKIM in the Admin console. Mail
arriving for a domain that has neither lands in the unassigned queue, or does
not arrive at all. See [deployment.md](deployment.md).

### Secrets are write-only

The settings API reports whether a secret is set, never its value. A blank
secret field in a form submission means "leave it alone", so saving other
settings does not disconnect a working integration.

### Where secrets live

In the database, unencrypted. This is deliberate rather than an oversight: the
same file already contains every mirrored message body, so encrypting the token
beside the data it protects would add ceremony without changing what an attacker
with file access can read. Protect the file. See
[security-model.md](security-model.md).

## Language and appearance

The interface ships in Korean and English, switchable from the toolbar. The choice
is stored in a `labmail_lang` cookie rather than on the account: it applies
before sign-in, belongs to the browser, and must be readable by the server when
it translates an error message.

With no cookie set, the server falls back to `Accept-Language`, then to Korean.
`POST /api/locale` with `{"locale":"en"}` sets it explicitly.

Light, dark and system appearance are a browser-only preference kept in local
storage; nothing about it reaches the server.

Each member sets their own display name and signature under the account menu at
the bottom of the sidebar. The name is what recipients see beside the address.

## Redirect URI

Built from the address the browser used, so access by host IP works with no
configuration:

```
http://10.0.0.5:8000/api/admin/oauth/callback
```

`PUBLIC_URL` overrides this. `X-Forwarded-Proto` and `X-Forwarded-Host` are
honored when it is unset. The current value is displayed in system settings —
copy it from there into Cloud Console rather than composing it by hand.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server with watch |
| `npm start` | Production server |
| `npm run typecheck` | Type check |
| `npm test` | Unit and integration tests |
| `npm run backup -- <dir> --verify --keep 14` | Verified backup, pruning older archives |
| `npm run diagnose:routing` | Whether the Admin console routing rules took effect |
| `npm run migrate` | Apply the schema (also happens on start) |
| `npm run sync -- --full` | Full backfill |
| `npm run sync -- --watch` | Standalone sync loop |
| `npm run provision -- <alias>` | Create or repair an address |
| `npm run admin -- <address>` | Promote an existing account to admin |
| `npm run seed:demo -- <address>` | Insert sample mail for interface work |
| `npm run seed:demo -- --clear` | Remove seeded sample mail |

`seed:demo` refuses to run while Google is connected, so it cannot mix
fabricated messages into a real mailbox.
