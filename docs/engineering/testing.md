# Testing

How the product is checked, from the database rules up to a real browser.
Run both suites before calling a change done.

## Layers

| Layer | What it proves | Where | Command |
|---|---|---|---|
| Types | contracts between client, server and shared schemas | `tsconfig.json`, `client/tsconfig.json` | `npm run typecheck` |
| API + database | business rules in triggers and functions, access, procedures, emails | `tests/*.test.ts` (vitest, real PostgreSQL, `createCaller`; HTTP for files and avatars) | `TEST_DATABASE_URL=… npm test` |
| End-to-end | the built client against the real server, as a person uses it | `e2e/*.spec.ts` (Playwright, installed Chrome) | `TEST_DATABASE_URL=… npm run e2e` |
| Dependencies | what the image runs has no known high or critical advisory (CI) | `package-lock.json` | `npm audit --omit=dev --audit-level=high` |

`TEST_DATABASE_URL` is an admin connection: each suite creates its own
database (vitest — a temporary one; end-to-end — `yartt_e2e`, filled by
`scripts/seed.ts` and then run as a real installation with sign-in, and
`yartt_e2e_demo`, the demo itself with `DEMO_DATA=en` for `demo.spec.ts`)
and never touches the one in `.env`.

The end-to-end run builds the client (`npm run build`), starts
`e2e/serve.ts` on port 3100 — a fresh database with the demo data, then the
real server like in production — and drives Chrome in Russian, Moscow
time. Tests run one at a time: they share the data. The report with
traces and screenshots of failures is in `e2e-report/`
(`npx playwright show-report e2e-report`).

## What the end-to-end tests cover

| Area | Spec | Scenarios |
|---|---|---|
| Sign-in | `auth` | requesting a link without telling whether the email exists; the link signs in once; log out; a dismissed employee gets no link; a link switches to its person when someone else is signed in |
| My day | `my-day` | TODO: approve a request, "Done" only after a reply made right there, pronoun forms and a bot's neutral ones; current tasks: tabs, pages, state kept after a task (the logo leads home); history: start a shift from an arrival and close it, confirm a suggested one, a shift for activity after a written one (a visit outside it can become a shift, the log under "Details" once none is left), add/correct/delete a shift of a past day, log time to an opened task; a task hovered shows its context and everyone's time; Waiting for others: my request, withdrawn from there |
| Task | `task` | created in the form; priority, deadline, context in place; a comment held with "Back to editing", `c` focuses the composer; a mention makes an observer and says why; reply and cancel; a reply in its thread and its line in the feed; time logged and planned, both as feed events; observers added and hidden; public and private again; a dependency added and removed; a reminder; finish; hand-over; no access → request → withdraw |
| Search | `search` | in My day: `/` focuses from a task too; a tag narrows both tabs; typos and the other layout, words as a set of tags; only existing tags, Enter takes the best; "New task" takes the picked tags; a taken title is off and links to its task |
| New task | `newTask` | from "My open": tags as the title, a new tag created only on saving, priority; from "Waited on by": the new task waits for this one |
| Drafts | `drafts` | a comment, a context being edited and a new task survive going elsewhere; "Cancel" forgets |
| Top line | `topLine` | how much waits for me, from a task; "I'll be away" set and cleared; an open shift with its time, closed from there |
| Hints | `hints` | "My open" and the deadline explain themselves; a task at risk says whose plan and whom it delays |
| Offline | `offline` | a comment written offline waits in the outbox, survives a reload, goes out when online |
| My team, employee page | `team` | all my team on top, me and my reports, a report's team folded and unfolded, the four columns, a row's details (a person's, a team's), ticks and a whole team in one tick, the delay of a late timesheet, a manager inside their team's line, a dismissed person hidden for a range before the dismissal, the folded list of my dismissed and bringing back, dismissing from the details; payroll export as Excel and CSV; away and dismissed marks; no block without reports; the employee page with a range and a chart; scoring, a correction, a reason for a low score; a manager higher up only looks; a stranger is refused |
| Profile | `profile` | an API token issued, shown once, revoked; avatar upload and removal; language switches the interface and the name (яртт / yartt); pronoun |
| My tags | `tags` | in the profile: a personal color shows on the chip; weight; a tag closes the profile and opens the search |
| Interface walk-through | `interface` | docs/product/interface.md item by item: Invite; no raw translation keys on any screen in Russian and English; "No intervention needed" after the table of new comments and a warning; history pages, deleting a time entry and the open shift, a shift at another time; tags edited in place; clearing a deadline; a latest deadline the other task misses puts both at risk, said on the line and the mark; "Back to editing" restores the text, Ctrl+Enter, a file and an image (opens in full); made private again → "Bring back all"; an observer leaves; time for a past day lands on that day; no score without a closed timesheet; profile saved, manager applied at once, log out everywhere |
| Tags | `tagStats` | the "?" hints; a start day; columns sorted by the arrow; a line unfolds into time and plan charts and its people, bots left out; picked tags add all and any; CSV |
| Hour budgets | `tagLimits` | spent of the limit and the forecast; a change is a new version in the history; the task shows its budgets |
| Guide | `help` | opens from the top line, in the person's language |
| Demo | `demo` | pick a person, switch from the menu, kept out of search engines |
| Layout | `layout` | no horizontal scroll at phone width on My day with the team table (its details open too), a task, an employee page, the guide |

## Migrations: the schema and the data

`tests/schema.test.ts` takes every release tag (`1.2.3`) from git:

- `db.sql` at the tag, migrated with today's migrations, must give exactly
  the schema of today's `db.sql` (the same version means the same schema);
- the test data at the tag (`tests/fixtures/data.sql`), loaded as it was
  (triggers off), migrated, must equal today's test data. What only
  appeared in a later version — a new feature's rows the old data could
  not have — is added by that step's asymmetry script
  `tests/fixtures/<from>-<to>.sql` (explicit values for every column);
  everything else must come through the migration. A step may read the
  clock (a deadline passed or not), so both here and in `npm run fixture
  -- --migrate` each step runs with `now()` pinned to the moment of the
  release it starts from — the commit of tag `X.Y.0` (`pinClock()` in
  `scripts/data.ts`): the check gives the same answer on any later day.

Today's test data is made by `npm run fixture`: from scratch (the demo
data, dumped — for the first version), or with `-- --migrate` from the
last release through the migrations and asymmetry scripts — then the
diff is reviewed: it is what the migration does to real data. The data
also has to load into today's `db.sql` and dump back unchanged.

## On GitHub

`.github/workflows/ci.yml` runs all three layers on every push to
`master` and every pull request, against PostgreSQL 17 in a service
container, and attaches the end-to-end report when it fails
([release.md](release.md)).

## What is checked by hand

- Emails as received (subjects, line breaks, links) through a real SMTP.
- The webhook signature on a real receiver.
- The Docker image from scratch against an empty PostgreSQL.
- Reading everything in English once per release.

## Adding a feature

1. Rules in the database → a vitest test in `tests/` for every rule and
   every error code the feature adds.
2. A new screen or action → a scenario in `e2e/`, using the demo data
   (extend `server/demo.ts`, in both languages of `server/demoTexts.ts`, so the feature shows up there too).
3. Prefer roles and visible texts in selectors (`getByRole`, `getByLabel`):
   a test that cannot find a control by its name is usually an
   accessibility bug in the interface, not in the test.
