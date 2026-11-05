# yartt

A task tracker built around responsibility and security: every task has
exactly one owner, only the people invited to it see it, and every
manager sees what is really going on — without configuring anything.
Installed by a company on its own server.

Instead of projects, titles, subtasks, assignees, statuses and admins —
mechanisms that bend further: tasks are named by tags, linked by
dependencies, owned by whoever started them and closed by deadlines;
access is by invitation and follows the org chart. The timesheet, time
entries and scores of the day make work transparent, and are optional.

## Product

- [Vision and positioning](docs/product/vision.md) — the problem, the bet,
  who it is for, design principles, non-goals.
- [Personas and roles](docs/product/personas.md) — whom we design for and
  where rights come from.
- [Features](docs/product/features.md) — what is in stage one, stage two
  and never.
- [Interface](docs/product/interface.md) — the five places of the product
  and the interaction rules.
- [Decisions](docs/product/decisions.md) — risky product questions and
  what we chose.
- [db.sql](db.sql) — the domain model and every business rule, in comments.

## Installation

You need Docker and PostgreSQL 15+ (external). The database user must own
the database: the first start creates the extensions `citext`, `pgcrypto`,
`btree_gist`, `pg_trgm`.

The image is on Docker Hub: `yartt/public:<version>`. A working
installation and a trial take different settings, each from its own file:

```sh
cp prod.env.example prod.env   # fill in: database, address, SMTP, first employee
docker run -d --name yartt -p 3000:3000 --env-file prod.env yartt/public:<version>
```

[prod.env.example](prod.env.example) lists them. Required:

- `DATABASE_URL`, `PUBLIC_URL`;
- `SMTP_URL` and `MAIL_FROM` — sign-in links, invites and notifications are
  sent by email in each employee's language; the image does not start
  without them;
- `FIRST_EMPLOYEE_EMAIL`, `FIRST_EMPLOYEE_NAME` — the first start creates
  the schema and this employee. Everyone else is invited from the
  interface.

For a trial, [demo.env.example](demo.env.example) on a database of its own:
a made-up company in English or Russian, no sign-in — you pick whose eyes
to see it through — and seeded afresh on every start
([install guide](docs/admin/install.md#a-trial-with-demo-data)).

Note: the SMTP host is resolved through DNS, so use an IP address or a
real host name rather than `localhost`.

### Upgrading

1. Back up the database. Downgrades are not supported, and only a backup
   can undo a mistake in a migration's logic.
2. Stop all instances of the old version.
3. Start the new image — it upgrades the schema itself.

The upgrade runs in one transaction: if anything goes wrong, the database
stays at the old version, the new instance exits with an error in the log,
and the old image can be started again. If a migration cannot get a lock
within 30 seconds (for example, an old instance is still running), it is
rolled back too.

A new major version can be reached only from the last minor one: for
example, 1.2 → 1.4 → 2.0 (upgrade to the latest 1.x first). The schema
version history is in the `schema_version` table.

### Webhooks (optional)

A person sends their notifications to another program by themselves: a
receiver for Telegram, say, gives them an address, and they paste it under
**Profile → Webhooks**, choosing how much goes there for each group of events.
Emails keep coming. `WEBHOOK_ALLOWED_URLS` says where webhooks may go; empty,
anywhere outside the company's network. Details: [docs/admin/api.md](docs/admin/api.md).

### Scaling

`ROLE=all` (default) runs the API and background jobs in one process. They
can be split across containers of the same image: `ROLE=api` and
`ROLE=worker`. Several instances run safely.

## Development

Node 24+, PostgreSQL.

```sh
npm install
cp .env.example .env   # set DATABASE_URL
npm run dev            # server :3000 + client :5173
```

Without `SMTP_URL` messages are written to the server
log — take the sign-in link from there. Or `npm run seed -- --reset` and
`DEMO_DATA=ru` (or `en`) in `.env`: the demo company, and no sign-in.

```sh
npm run typecheck
TEST_DATABASE_URL=postgres://<user>:<password>@localhost:5432/postgres npm test
```

Tests create and drop their own database on the given server.

## License

[FSL-1.1-ALv2](LICENSE.md) (Functional Source License). Any company may
install yartt, change it and use it for its own work, free of charge. What
is not allowed is selling it or offering it as a service that competes with
yartt. Two years after each release, that release becomes Apache 2.0.

The right to sell yartt, host it for others or build it into a product is
granted separately by the copyright holder.

All copyright in yartt belongs to one person, so contributions are
accepted with a copyright assignment: see [CONTRIBUTING.md](CONTRIBUTING.md).
