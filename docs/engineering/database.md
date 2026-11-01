# A guide to db.sql

`db.sql` is the specification: the whole domain, who may do what, and
every rule, in about five thousand lines. It is long because the rules
live in the database (triggers, functions, constraints), not because it
is tangled. This page is the map to read it by; it never repeats a rule,
it says where the rule is.

## How the file is laid out

| Part | What is there | Read it when |
|---|---|---|
| The header: `COMMENT ON SCHEMA public` | the philosophy, why the usual constructs are dropped, search, task numbers, sign-in, **operations** (what the application must be able to do), **access rules**, **invariants**, **cron jobs** | always first: it is the product in one place |
| Numbered sections `1.` to `16.` | one table each (or a pair): its columns, indexes, constraints, and a `COMMENT ON` for every one of them | you touch that table |
| `TRIGGERS` | rules that hold whatever writes the row: no deletion, the owner is an observer, managers observe their reports' tasks, no dependency cycles, who may comment or log time | a write is refused and you need the reason |
| `FUNCTIONS (API)` | the operations the application calls: sign-in, bots, dismissal, access to a task, deadlines, digests, reminders, files | you add or change an operation |

`\d+ <table>` in psql shows the same comments next to the live schema.

## The ideas everything rests on

- **A task is thin.** `task` holds the owner, tags, priority and context;
  what changes over time is a history table beside it: `finished_at`
  (deadlines), `estimate_minutes` (time left), `owner_change`. A row is
  closed (`expired_at`) and a new one opened, never edited, so "the data
  never lies".
- **Seeing is observing.** `observer` decides who sees the inside of a
  task; `can_see()` is the one rule every query uses. Managers are not
  checked up the chain at read time: a trigger adds the managers of each
  active observer as observers themselves, so a reorganisation moves
  rows, not rules. A task with no active observers is public.
- **Time is shifts.** `work` is a shift (it may run past midnight);
  `spent_minutes` is time on a task within a shift; `score` scores a
  shift. A day is only how shifts are shown (`shift_day`, `spent_day`).
- **Nothing is deleted.** Employees, tasks and comments refuse `DELETE`;
  a dismissed person keeps their history, a comment is answered, not
  edited.
- **Notifications are a queue**, not an inbox: `notify()` writes them,
  the worker sends them (`server/worker.ts`), a failure waits in
  `notification_failure`.

## Errors

A rule that refuses raises with a stable code in `HINT` and its
parameters as JSON in `DETAIL`:

```sql
RAISE EXCEPTION 'employee % is unknown', p_id USING HINT = 'not_found',
    DETAIL = json_build_object('employeeId', p_id)::text;
```

The code is listed in `shared/errors.ts` and translated in
`shared/i18n/*.ts`; the English text is for logs only. A constraint
violation maps to a code by the constraint's name in `server/errors.ts`.

## Changing it

1. Read the header's operations, access rules and invariants: the change
   may already be ruled out, or need one of them changed first.
2. Change `db.sql` as if writing it afresh: the table, its `COMMENT ON`,
   the function, the header if a rule changes. The comment is the
   specification, so it says why, not only what.
3. After a release every change is also a migration
   `server/migrations/<from>-<to>.sql` and a new version in
   `INSERT INTO schema_version`; the rules are in [AGENTS.md](../../AGENTS.md)
   (Database). `tests/schema.test.ts` checks that every released `db.sql`,
   migrated, equals today's, data included.
4. A rule gets a test in `tests/` (vitest against a real PostgreSQL);
   a new query that shows the inside of a task gets a line in
   `tests/access.test.ts` ([testing](testing.md)).

## Where to look for

| Question | Look at |
|---|---|
| Who sees a task | `can_see()`, `is_observer()`, `is_public()`, the trigger `observer_add_manager`, the header's access rules |
| Who may change it | `check_owner()`, the header's access rules, the functions under "task access" |
| Why a time entry is refused | `trg_spent_minutes_check()`, `check_shift_minutes()` |
| When a task is at risk | `at_risk()`, `deadline_risk()`, `dependency_risk()` |
| What the worker runs | the header's cron jobs; `server/worker.ts` |
| How sign-in works | section `2. auth`, `issue_token()`, `login()`, `authenticate()`, `sign_in_external()` |
| Where a file's content is | section `10a. attachment` (in PostgreSQL or the object storage) |
