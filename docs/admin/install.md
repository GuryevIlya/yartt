# Installing yartt

yartt is installed by the company itself: one Docker image and an external
PostgreSQL. One installation is one company. There are no administrators
in the product: the first employee is created from the configuration, and
everyone else is invited by an employee.

## What you need

- PostgreSQL 16 or newer, a database and a user that owns it. On the first
  start yartt creates the extensions `citext`, `pgcrypto`, `btree_gist`,
  `pg_trgm`, `fuzzystrmatch` (all in PostgreSQL's standard contrib) — the
  user needs the right to do that (or create them first).
- A host for the container, reachable by employees over HTTPS (put any
  TLS-terminating proxy or load balancer in front: the container speaks
  plain HTTP).
- An SMTP server for emails: sign-in links, invites, notifications. The
  image does not start without it: nobody could sign in.

## Configuration

Everything is set with environment variables, from a file of its own for
each kind of installation: [prod.env.example](../../prod.env.example) for
work, [demo.env.example](../../demo.env.example) for a trial. Copy one to
`prod.env` or `demo.env` (git ignores them) and fill it in.

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:password@host:5432/yartt` |
| `PUBLIC_URL` | yes | the address employees open, e.g. `https://tasks.example.com`; used in links in emails |
| `PORT` | no | default `3000` |
| `ROLE` | no | `all` (default) — the API and the background worker in one process; `api` / `worker` to run them in separate containers |
| `SMTP_URL` | yes, but in the demo | `smtp://user:password@host:587` or `smtps://user:password@host:465` |
| `MAIL_FROM` | with `SMTP_URL` | e.g. `yartt <noreply@example.com>` |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | no | an extra channel (Telegram, Slack, …): every message is POSTed there as JSON, signed as a bot's webhook is ([api.md](api.md#its-webhook)): `X-Yartt-Timestamp` and `X-Yartt-Signature: sha256=<hex>`, HMAC-SHA256 of `<timestamp>.<body>` with the secret. A sign-in link in it works only in the browser that asked for it, so the receiver cannot sign in with one |
| `BOT_WEBHOOK_INTERNAL_HOSTS` | no | hosts inside the company's network that bots' own webhooks may reach, comma-separated (`ci.corp.local`). Any employee may set a bot's webhook, so by default it reaches only outside addresses: never this server, the private networks or the cloud's metadata service; the name is checked as it is resolved, at the connection |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | no | sign-in through the company's identity provider (OpenID Connect) — then the only way in ([below](#sign-in-through-the-companys-identity-provider)) |
| `OIDC_NAME` | no | the provider's name on the sign-in button, e.g. `Microsoft`; default `SSO` |
| `EMAIL_DOMAINS` | no | the company's mail domains, comma-separated (`corp.com,corp.kz`): no other address can be invited or set; someone who already has one signs in only to change it, and their mail gets that request instead of notifications, once a day. Exact domains, subdomains are not included. Empty — any address |
| `FILE_MAX_MB` | no | the largest file that can be attached, in MB; default `50` (the demo keeps 2) |
| `FILE_QUOTA_MB` | no | how much one person's files may take together, in MB; default `1024`. Over it an upload is refused, and the person deletes the content of files they no longer need in "My files" |
| `COOKIE_SECURE` | no | `true` (default) — keep it unless you test over plain HTTP |
| `FIRST_EMPLOYEE_EMAIL`, `FIRST_EMPLOYEE_NAME` | first start, without `OIDC_ISSUER` | the first employee, created only while there are no employees |
| `FIRST_EMPLOYEE_LOCALE`, `FIRST_EMPLOYEE_TIME_ZONE` | no | `ru` / `en`; an IANA zone such as `Europe/Moscow`. Invited employees inherit them from whoever invites |
| `DEMO_DATA` | only in the demo | `ru` / `en` — a trial: the demo company in that language, seeded afresh on every start, no sign-in ([below](#a-trial-with-demo-data)). Never for work |

In the demo, without `SMTP_URL`, messages are only written to the log.

## Start

```sh
cp prod.env.example prod.env   # fill it in
docker run -d --name yartt -p 3000:3000 --env-file prod.env yartt/public:<version>
```

On start the container installs or upgrades the schema (under a lock, so
several containers may start at once), creates the first employee if there
is none, and serves the application. The first employee gets an email
saying where to sign in (with SMTP set; otherwise it is in the log),
opens `PUBLIC_URL`, asks for a sign-in link with their email and invites
the others from the top line. Anyone added to the database outside the
interface is greeted the same way when given a `welcome` notification
(`SELECT notify(<id>, NULL, '{"kind":"welcome"}')`).

To run the worker apart from the API, start the same image twice with
`ROLE=api` and `ROLE=worker`; several workers are safe.

The image checks itself: `GET /api/health` answers 200 while the server
is up and the database answers, 503 otherwise, and Docker's
`HEALTHCHECK` calls it every 30 seconds — `docker ps` shows the container
healthy or unhealthy, and an orchestrator or a load balancer can use the
same address. A `ROLE=worker` container serves no HTTP and counts as
healthy while it runs.

## A trial with demo data

To look around before inviting anyone, start the image with
[demo.env.example](../../demo.env.example) against a database of its own:
a made-up company in English or Russian (`DEMO_DATA`) — managers, tasks,
comments, shifts, scores, avatars — written relative to today.

```sh
cp demo.env.example demo.env   # the database and the language
docker run -d --name yartt-demo -p 3000:3000 --env-file demo.env yartt/public:<version>
```

There is no sign-in: the first page lists the company's people, and you
pick whose eyes to see it through; the profile menu switches to someone
else at any moment, and "Demo" in the top line reminds everyone it is not
real. No SMTP or `FIRST_EMPLOYEE_*` is needed: its people are made up, so
the demo sends nothing — notifications still come to the bell in the
interface.

Every start and every night (after 03:00 in the demo company's time zone)
seed the demo afresh, so its days stay around today; it is never
migrated — a new image simply installs its schema anew. That is safe for
real data by design: the demo's schema version is `demo` (`SELECT * FROM
schema_version`), and only such a database is wiped. A database with
tables at any other version is refused — the container stops with
"DEMO_DATA is set, but the database holds real data" — and nothing in it
is touched; the other way round, an installation started without
`DEMO_DATA` refuses a demo database rather than migrate it. Still, keep
the demo on a database of its own, and never set `DEMO_DATA` for work.

### A public demo

The same container can be the demo you link to from a website, open to
anyone. Put it behind HTTPS like a working installation, set `PUBLIC_URL`
to its address and drop `COOKIE_SECURE=false` from `demo.env`. The demo
keeps visitors in check by itself: the first page and the top line say
the company is made up, everything written there is visible to any
visitor and starts afresh every night; files are limited to 2 MB, so
nobody fills the database; and its pages ask search engines not to index
them (`X-Robots-Tag: noindex`).

## Sign-in through the company's identity provider

With `OIDC_ISSUER` set, people sign in only with their company account —
any provider that speaks OpenID Connect: Microsoft Entra ID, Google
Workspace, Okta, Keycloak, Authentik. Register yartt there as a web
application (a confidential client) with the redirect URI
`<PUBLIC_URL>/api/sso/callback`, and give yartt its issuer URL, client ID
and secret. Then:

- **Who comes in is the provider's decision.** Assign the application to
  the people or groups who should use yartt. Someone it lets in for the
  first time is found by the email it vouches for (`email_verified`,
  inside `EMAIL_DOMAINS`) — whoever is here with that address, added
  before the provider was set — or created with it. A provider that
  vouches for no address (Entra does not) makes them type their work
  email and open the link sent to it in the same browser, so mail must
  work (`SMTP_URL`). From then on the provider's id knows them, whatever
  their address there; their email is theirs to change in the profile.
  Invites and sign-in links are off. `FIRST_EMPLOYEE_*` is not needed: the first
  person to sign in is the first employee.
- **A session lasts a day from sign-in**, so someone the provider stops
  letting in is out by the next day.
- **Every day yartt asks the provider** whether each person may still
  sign in, with the refresh token of their last sign-in (the
  `offline_access` scope, or Google's offline access — asked for
  automatically). A refusal ends their sessions and stops their bots; My
  team marks them and their manager's Monday email names them, to dismiss
  — a refusal is not a dismissal. A provider that gives no refresh tokens
  is not asked: then only the day-long session protects.
- **`EMAIL_DOMAINS` applies too**: an account with an address outside them
  is refused.
- **An outage of the provider**: unset `OIDC_ISSUER` and restart — people
  sign in by email links again, the data does not change; set it back
  when the provider is up. People the provider refused stay refused.

The provider's own setup — Entra, Google, Keycloak, and LDAP or SAML
through Keycloak — is in [identity providers](sso.md).

## Dismissing someone who will not hand over

In the product only a manager dismisses, so nobody can dismiss the person
at the top, and someone may refuse to hand over. The administrator of the
installation does it from the running container, naming the heir:

```sh
docker exec yartt node server/admin.ts dismiss ceo@example.com --heir marina@example.com
```

The heir becomes their manager and dismisses them: the tasks and the whole
team, dismissed people included, go to the heir — the only one who can
bring the person back. If the heir is in the person's own team, they first
leave it for the person's place (under the person's manager, or at the
top). Everyone affected is notified as usual.

## Notifications that did not go

A notification the mail server refuses (a deleted mailbox, a full one) or
the webhook does not take waits aside for another attempt, after 1, 5 and
15 minutes, then every hour, while the others go on. After three days it
is given up; the log says so each time. To see what did not go, with the
last error:

```sh
docker exec yartt node server/admin.ts deliveries
```

Once the cause is fixed (the mail server is back, the address is
corrected), try them all again at once:

```sh
docker exec yartt node server/admin.ts deliveries --retry
```

## Upgrades

Replace the container with one from the new image. Schema migrations run on start, all of
them in one transaction — if one fails, the database stays on the old
version and the container exits with the reason in the log. Take a backup
of PostgreSQL before an upgrade: that is the administrator's job, the
application does not do it. There are no downgrades.

## Data and backups

Everything is in PostgreSQL, files included (attachments and avatars are
stored in the database). A regular `pg_dump` is a complete backup. The
worker removes on its own: sign-in tokens after an hour (email-change
ones after two days), sessions after 30 days of inactivity (a day from
sign-in with the identity provider), bot activity after a year, notifications and visits after a year, files no
comment or task refers to after a day.
