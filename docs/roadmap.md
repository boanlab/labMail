# Roadmap

What is left to do, and why it is not done yet. Anything already working is
described in the other documents rather than here.

## Blocked by a Google constraint

**Send-as entries cannot be created automatically.**
`gmail.users.settings.sendAs.create` is restricted to service accounts holding
domain-wide delegation, so it fails under the user OAuth flow labMail uses no
matter what admin role the account is given. An operator adds each member's
send address by hand, once; labMail refuses to send until it appears, and
notices it on the next sync tick.

Automating it means a service account with domain-wide delegation, whose key
could impersonate any user in the domain within the scopes it is granted. That
trades a per-member manual step for domain-wide reach from a key a web
application stores, which is not a trade this deployment wants to make.

**Permanent deletion is not possible.** `users.messages.delete` needs the
`https://mail.google.com/` scope — unrestricted access to the mailbox — which
labMail deliberately does not request. Deleting from the Trash removes the
message from that member's view; Gmail empties its own Trash on schedule.

## Operational

**No redundancy.** One container, SQLite on one volume, sync in-process. A
restart pauses sync for as long as it takes to come back. Adequate for a team,
not for an SLA.

**Backups are not offsite.** `npm run backup` writes verified archives into the
same volume it is protecting. Copying them to another machine is left to
whoever deploys it.

**Nothing watches `/healthz`.** It reports sync staleness and the last error,
but connecting that to an alert is the deployment's job.

## Latency and scale

**Sync polls.** `users.watch` with Pub/Sub push would cut the delay between
arrival and delivery from up to the sync interval down to seconds. The sync
functions themselves would not change — only what triggers them.

**Quota is shared.** One Workspace account's daily recipient cap and Gmail API
rate limit are divided among every member. Ten members on a 2,000/day limit
have 200 each.

**Storage is shared.** Large attachments accumulate against one quota.

## Smaller

**Two locales, maintained by hand.** Korean and English catalogs are kept in
step by a test that fails on asymmetry, but adding a third means writing every
string again.

**The audit log has no export.** It is readable in the admin UI and queryable
in SQLite; there is no CSV or retention policy beyond `AUDIT_RETENTION_DAYS`.

**Rules run on arrival and on demand.** A rule added later does not apply to
mail already read unless "apply to existing mail" is pressed.
