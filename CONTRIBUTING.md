# Contributing to labMail

Thanks for taking the time to contribute.

## Getting started

```bash
git clone <your-fork>
cd labMail
npm install
cp .env.example .env
echo "ADMIN_PASSWORD=$(openssl rand -base64 24)" >> .env
npm run dev
```

The app comes up at <http://localhost:8000>. Sign in with the credentials from
`.env`, then use `npm run seed:demo -- admin` to populate a mailbox so you can
work on the interface without connecting a real Google account.

Node 22 or newer is required. The project runs TypeScript directly through
Node's type stripping, so there is no build step in development.

## Before opening a pull request

```bash
npm run typecheck  # type check
npm test           # unit and integration tests
```

Both run in CI on every pull request, along with a Docker image build.

## Things worth knowing

**Type stripping, not compilation.** Node executes the `.ts` files as-is, which
rules out TypeScript syntax that cannot be erased: no `enum`, no `namespace`,
no parameter properties. `erasableSyntaxOnly` is enabled so `tsc` catches these
rather than the server failing to start. Import paths must include the `.ts`
extension.

**Access control lives in one place.** Every message a member can see is
reachable only by joining `message_owners` on their session alias. If you add a
query that reads messages, it must go through that join. There is no secondary
filter, no Gmail-side query scoping, and no default fallback scope — a missing
join is a data leak, not a bug that shows the wrong count.

**The `From` header is not client input.** Outgoing mail takes its sender from
the server-side session. Nothing in a request body may influence it.

**Anything reaching a mail header is validated, not trusted.** Recipient
addresses go through `isValidAddress` before a send proceeds, and `buildMime`
re-checks them. A CRLF in an address injects headers; treat that path with the
same care as the ownership join.

**Ownership resolution is correctness-critical.** `src/google/ownership.ts`
decides which member a message belongs to. It has dedicated tests in
`test/ownership.test.ts`; changes there should come with cases, especially for
BCC handling and for anything that could let a spoofed header assign ownership.

## Project layout

```
src/
  config.ts          Environment configuration
  core/              Domain logic: authentication, members, settings, i18n
  db/                SQLite schema and every query that reads mail
  google/            Gmail and Admin SDK integration, sync, ownership resolution
  web/               HTTP server, router, route modules, and the browser client
  scripts/           Operational entry points (migrate, sync, seed, provision, backup)
test/                Unit and integration tests
docs/                Configuration, deployment, security model, roadmap
```

## Commit messages

Write them in the imperative mood and explain why, not just what:

```
Refuse to send from an address with no send-as entry

Gmail rewrites From to the shared account when the entry is missing, so
the message would go out under the mailbox's name with no error shown.
```

## Style

There is no formatter config to fight with. Match the surrounding code:
two-space indentation, no semicolons, single quotes. Comments explain the
reasoning behind a decision — prefer none at all to one that restates the code.

Code, comments, and documentation are written in English.

**User-facing text is translated, never hardcoded.** Server messages live in
`src/core/i18n.ts` and are thrown as keys — `throw new HttpError(404,
'mailbox.messageNotFound')` — so translation happens once in the response
handler using the request locale. Browser strings live in the `STRINGS` catalog
in `src/web/app.html`, reached through `t('key')` in script and `data-i18n` in
markup. Adding a string means adding it to both `ko` and `en`; the type checker
catches a missing server key, and the catalogs must stay in step.

## Reporting security issues

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
