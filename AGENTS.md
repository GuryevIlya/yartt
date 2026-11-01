# yartt

A task tracker without projects, subtasks or assignments. Documentation is
in `docs/` (index: `docs/README.md`): product in `docs/product/` (start with
`vision.md`), engineering in `docs/engineering/`, installation for a company
in `docs/admin/` — keep it in step with configuration changes. The plan is in
`docs/product/roadmap.md`: keep it current — tick a task when it is done
and verified, add one when it is decided. The whole domain,
access rules and invariants are described in `db.sql` (COMMENT ON) — it is
the specification; read it before any work.

## Language

- Everything is in English: code, comments, `db.sql`, documentation,
  commit messages.
- The only exception is user-facing translations: `shared/i18n/<locale>.ts`.
- Russian user-facing text is written, not translated from the English
  docs: follow `.claude/skills/russian-texts/SKILL.md` and its proofreading
  pass before every commit that touches it.

## Delivery

- One installation = one company. No multi-tenancy.
- The company deploys the system itself: one Docker image, PostgreSQL is
  external (`DATABASE_URL`). No docker-compose.
- Express serves both the API and the built client (static files) — no nginx.
- On startup: the schema (under an advisory lock), then the first employee
  from `.env` (`FIRST_EMPLOYEE_*`) if `employee` is empty — or, with
  `DEMO_DATA`, the demo company installed and seeded afresh, never migrated
  (only into an empty database or one marked as a demo; real data is
  refused); the worker reseeds it every night. Docker takes its settings
  from `prod.env` or `demo.env` (`*.env.example`); SMTP is required in
  production. There are no
  roles and no admins: the first employee is an ordinary employee. Rights
  come from relationships (owner, observer, direct manager).

## Stack

- One `package.json` at the root, npm. Folders `server/`, `client/`, `shared/`.
  `dependencies` — only what the server needs at runtime (the image runs
  `npm ci --omit=dev`); the client and tooling — `devDependencies`.
- `shared/` is plain code without its own dependencies. Imports across
  folders use subpath imports from `package.json`: `#shared/errors.ts`,
  `#client/hooks/trpc.ts`. Node, tsc and Vite all understand them. Within
  a folder — relative imports.
- The client imports only `#shared/*`, never the server. The tRPC router
  type comes from `#shared/types.ts` (a type-only re-export).
- server: Node.js, TypeScript, Express, tRPC, zod, superjson, date-fns +
  @date-fns/tz. Node reads `.env` itself (`--env-file-if-exists`), no dotenv.
- Database: PostgreSQL through the `postgres` library (porsager), queries
  are `sql```. No ORM: the logic lives in triggers, functions, partial
  indexes and EXCLUDE constraints.
- client: React, Vite, React Query (through tRPC), Zustand, MUI; rich text
  (comments, task context) — mui-tiptap (Tiptap 3).
- Localization from day one: UI texts go through keys, the server returns
  error codes, never texts. The employee's language is `employee.locale`.
- Major versions are pinned deliberately: TypeScript 5, Vite 7, MUI 7,
  React Router 7, Vitest 3, nodemailer 10. Moving to the next majors is a
  separate task.
- The server is not built: Node 24 runs TypeScript directly. Hence only
  erasable syntax (`erasableSyntaxOnly`: no enum, namespace, parameter
  properties) and relative imports with the `.ts` extension.

## Structure

```
server/
  index.ts          — startup: schema, first employee, express (/api + client static), worker
  env.ts            — zod schema of the environment (a new variable goes here and to .env.example)
  pg.ts             — `sql` (the postgres library)
  ctx.ts            — tRPC context: the employee from the session cookie
  trpc.ts           — initTRPC: router, procedure, authedProcedure, error format
  api.ts            — mounts /api/trpc
  trpc/index.ts     — root router; keys are client namespaces (trpc.Employee.list)
  trpc/<Entity>.ts  — an entity router: procedure descriptions only
  services/<Entity>.ts — SQL and business logic
  errors.ts         — AppError, Postgres errors -> codes
  html.ts           — sanitizes rich text (comments, context) to an allow-list
  attachments.ts    — /api/attachments: raw upload and download, outside tRPC
  storage.ts        — files in an S3-compatible object storage (S3_BUCKET), else in PostgreSQL
  delivery.ts       — every outgoing message: email (mail.ts) and/or webhook (webhook.ts)
  services/Mail.ts  — renders an email in the recipient's language
  migrate.ts, migrations/, bootstrap.ts, worker.ts
  admin.ts          — installation administrator commands (dismiss with an heir), outside the API
  demo.ts, demoTexts.ts, demoImages.ts — the demo company (ru/en) and its avatars: `npm run seed`,
                    or every start with DEMO_DATA (no sign-in then: a person is picked)
shared/
  <entity>.ts       — zod schemas shared by the client and the server
  errors.ts         — error codes and the error.data shape
  notification.ts   — notification payloads by kind
  i18n/             — translations (ru.ts is the reference): UI, error messages, emails;
                      help/ — the in-app guide, written for each language (help/ru.ts is the reference)
  types.ts          — root router type for the client
client/
  main.tsx          — providers; errors of all queries -> showError
  theme.ts          — MUI theme
  hooks/trpc.ts     — useTRPC(); hooks/store.ts — zustand, showError/showInfo; hooks/me.ts — useMe()
  i18n/             — i18next setup, errors.ts — error texts
  components/App.tsx — My day and the pages that open over it by route; the layout
  components/App/   — the top line, notifications, profile and invite dialogs
  components/<Name>Page.tsx, components/<Name>Page/ — pages and their parts
                    (TaskPage, EmployeePage open over the sections by route)
  components/App/RichEditor.tsx, RichView.tsx — the mui-tiptap editor and viewer
tests/              — vitest against a real PostgreSQL
```

Adding an API: schemas — `shared/<entity>.ts`, SQL — `server/services/<Entity>.ts`,
procedures — `server/trpc/<Entity>.ts`, wire it in `server/trpc/index.ts`.
On the client: `useQuery(trpc.<Entity>.<procedure>.queryOptions(input))`.

Screens: there is one — My day (`/`); there are no tabs (decision 31).
Blocks below the tasks are folded until opened (decision 83); a person's
page shows their My day to a manager above through `ViewAs`
(`client/hooks/viewAs.ts`, `as` in the queries). A new place is first a
block of My day, a section of the profile dialog or something that opens
over My day by route, like a task (`/tasks/:id`) or a person
(`/employees/:id`): a component in `client/components/<Name>Page.tsx` and
a `matchPath` in `client/components/App.tsx`.

## Database

- `db.sql` always describes the whole current schema; its version
  (major.minor) is in `INSERT INTO schema_version`. A new installation
  applies `db.sql` in one step.
- The first schema version is 0.0. Before the first release the schema
  changes in `db.sql` only. After a release every change of the schema: a migration
  `server/migrations/<from>-<to>.sql` + a change in `db.sql` + a new version
  there. Minor — `X.Y-X.(Y+1)`, major — only from the last minor,
  `X.last-(X+1).0`. The version history (`schema_version`, entered_at /
  expired_at) is kept by the migrator; migration files never touch it.
  No downgrades. Patch releases never change the schema.
- The whole migration chain is one transaction with `lock_timeout` 30s.
  So migrations cannot use `CREATE INDEX CONCURRENTLY` or `VACUUM` (the
  migrator and the test reject them). A backup before an upgrade is the
  administrator's job, not the application's.
- A migration of an unreleased version is a draft and may be edited (local
  databases are recreated). Released migrations never change.
- `tests/schema.test.ts`: for every release tag (`1.2.3`), `db.sql` as it was
  at the tag, migrated with today's migrations, must give exactly the
  schema of a fresh `db.sql` (the same version means the same schema).
  Nothing is kept frozen by hand: the released schema is in git.
- Data migrates too, so it is checked too: `tests/fixtures/data.sql` is the
  test data of the current version (the demo data dumped). For every
  release tag, its data, migrated, must equal today's data — except what
  only appeared later, which `tests/fixtures/<from>-<to>.sql` adds with
  explicit values for every column. Before a release, after a schema
  change: `npm run fixture`; after a release, with a migration:
  `npm run fixture -- --migrate`, then review the diff.
- Business rules live in the database (triggers, functions). A rule error:
  `RAISE EXCEPTION '<message for logs>' USING HINT = '<code>'
  [, DETAIL = json_build_object(...)::text]`. The code is added to
  `shared/errors.ts` and to the translations `shared/i18n/*.ts`;
  DETAIL carries the parameters for the message template.
  Constraint violations map to a code by constraint name in `server/errors.ts`.
- `postgres` converts columns to camelCase: snake_case in SQL, camelCase
  in TS. `DATE` comes as a `YYYY-MM-DD` string, `BIGINT` as a string.

## Contracts and data

- Procedure inputs and outputs are zod schemas in `shared/`; types are
  inferred from them (`z.infer`), never duplicated by hand. A schema and
  its type share a name: `Employee` is both.
- Every procedure has `.input()` (if it takes input) and `.output()`.
- Everything that comes from the database is parsed with a zod schema
  right at the query: `Employee.array().parse(await sql\`...\`)`. No
  helpers and no `sql<T>` — that is an unchecked type cast.
- superjson: a `Date` from the database reaches the client as a `Date`.
- Every procedure has JSDoc: what it does, who may call it,
  `@throws <code>`. It shows up in client-side hints.

## Errors and localization

- The server never builds a message. An error carries a code
  (`message` and `data.appCode`), parameters (`data.params`) and, for
  validation, zod issues without text (`data.issues`).
- The message template depends on the locale and is applied on the client:
  - business errors — `errors.<code>` in `shared/i18n/*.ts`, parameters
    substituted as `{{taskId}}`;
  - field errors — zod's built-in locales (`zod/locales`), `fieldErrors()`.
- The English text of `RAISE EXCEPTION` is for server logs and psql only;
  users never see it.
- Errors of all queries are shown in a snackbar automatically; forms
  additionally highlight fields.
- Translations are TS objects in `shared/i18n/` (`ru.ts` is the reference,
  `en.ts` is typed by it), so a missing key is a compile error. The client
  feeds them to i18next; the server renders emails from the `mail` section.
- Notification payloads are camelCase JSON, one zod schema per kind in
  `shared/notification.ts`; the worker parses them and skips (and logs) a
  payload that does not parse, so it cannot block the queue.

## Code style

- React components — `export default function (p: {...})`.
- Styling — MUI only: `sx`, `styled()`, the theme. No CSS files.

## Processes

- The API (Express + tRPC) and the worker come from one code base and one
  image. `ROLE=all` (default) — both in one process; `ROLE=api` /
  `ROLE=worker` — to split them across containers.
- The worker: notification delivery and the cron jobs from `db.sql`
  (CRON section). Safe with several instances: the queue uses
  `FOR UPDATE SKIP LOCKED`, every cron job runs under an advisory lock.
- Every outgoing message (notifications, sign-in links, invites) goes
  through `deliver()`: an email in the recipient's language (`SMTP_URL`,
  `MAIL_FROM`) and/or the webhook for other channels (`WEBHOOK_URL`, body
  signed with HMAC-SHA256). Sign-in links bypass the queue.
- Visits (a task, "My day") are logged through `Visit.log` (`useVisit`):
  on opening and on returning to a tab hidden for 10+ minutes, throttled to
  one per 10 minutes in the database; they feed "who looked at my task" and shift
  suggestions.
- UI updates — polling through React Query; WebSocket only if ever needed.

## Interface

- The interface and the product docs say "participant" for what the code,
  the API and `db.sql` call an observer (decision 63): the names inside
  stay, so bots' API and the schema do not change.
- Hours of a task or a tag add up: they measure the work, which barely
  depends on who of those fit for it does it (decision 68). People and
  teams are never compared by hours — by shares of each one's own time,
  averages over people, scores and counts; "at risk" is each person's
  plan against their own time.
- Comments are never edited. After "Send" a comment stays in the
  interface for a few seconds with a "Back to editing" button and only
  then goes to the server.
- Offline a mutation succeeds with no result: it waits in the outbox
  (decision 43). A screen that uses a mutation's result handles it being
  `undefined`; a mutation that must not wait is excluded in
  `client/hooks/offline.ts`.
- Anything typed and not yet saved (a comment, a form, an edit in place)
  goes through `useDraft` (`client/hooks/drafts.ts`), so leaving the page
  does not lose it; it is cleared on save and on cancel.

## Commands

- `npm run dev` — server (:3000, `node --watch`) and client (:5173, proxy `/api`).
- `npm run typecheck` — `tsconfig.json` (server + shared + tests + scripts + e2e) and `client/tsconfig.json`.
- `TEST_DATABASE_URL=… npm run fixture` — the test data of the current schema version
  (`-- --migrate`: the last release's data through the migrations).
- `DATABASE_URL=… npm run load -- generate | measure` — the load check: a company of 300 over two years
  in an empty database, and how long each query of the interface takes in it (`docs/engineering/testing.md`).
- `npm run seed -- --reset [--lang en]` — wipes the database in `DATABASE_URL` and fills it with demo data that
  touches every screen (`server/demo.ts`; in the image — every start and every night with `DEMO_DATA=ru|en`).
  Keep it in step with new features, in both languages (`server/demoTexts.ts`).
- The in-app guide (`shared/i18n/help/`, "?" in the top line) — what yartt is, how-tos
  and why the unusual rules are so: keep it in step with features, in every language.
- `TEST_DATABASE_URL=postgres://<user>:<password>@localhost:5432/postgres npm test`
- `TEST_DATABASE_URL=… npm run e2e` — end-to-end tests in Chrome over the demo data
  (`e2e/`, Playwright). How the suites divide the work: `docs/engineering/testing.md`.

## Tests

- vitest against a real PostgreSQL: business rules live in triggers, mocks
  would not check them. A run creates its own database and drops it after.
- Procedures are tested through `createCaller` (`tests/helpers.ts`),
  outgoing messages through `vi.mock('../server/delivery.ts')`. The HTTP
  error format — `tests/errors.test.ts`.

## Commits

The history is the changelog: someone reading `git log` learns what the
product gained and why. Always, without being asked:

- **One commit per feature or fix.** Everything that belongs to it goes
  together — code, schema (`db.sql`), translations, tests, demo data
  (`scripts/seed.ts`), docs and the roadmap tick. Unrelated changes (a
  stray fix, a refactoring, docs about something else) are separate
  commits. Commit when a feature is done and verified, before starting the
  next one; push only when asked.
- **Every commit builds and passes the tests**: `npm run typecheck`,
  `npm test`, and `npm run e2e` when the interface changed.
- **The message** is in English:
  - the first line — what changed, as a changelog entry a user would
    understand ("Team summary in My day for managers"), up to ~72
    characters, no trailing period;
  - an empty line, then the body: the motivation — the problem or the
    persona goal (docs/product/personas.md); what it does for people;
    notable decisions (with their number in decisions.md) and what is
    deliberately left out. Wrap at 72 characters. Not a list of files.

## Scope

- Stage one: sign-in by link, employees and invites, tasks with tags and
  search, deadlines, observers and requests, comments with attachments and
  mentions, timesheet, time entries, scores, notification delivery to the
  webhook.
- Stage two: dependencies, reminders, avatars and tag colors.
- No import from other trackers for now.
