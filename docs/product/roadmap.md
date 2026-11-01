# Roadmap

What is ahead — and only that. What the product already does is in
[features](features.md), why it is so — in [decisions](decisions.md). A
task leaves this file when it is done and verified; a new one comes in when
it is decided. Proposals wait for a decision in their own section.

## Now — stage 6: ready for 1.0

- [ ] **Contributions with a signed assignment.** Once the repository is
  on GitHub: install CLA Assistant, give it [legal/CAA-individual.md](../../legal/CAA-individual.md)
  as the agreement and check on a test pull request that it blocks
  the merge until the author signs; a company signs
  [legal/CAA-entity.md](../../legal/CAA-entity.md) on paper, so keep the
  signed copies. Before the first outside pull request a lawyer in
  Kazakhstan checks both agreements, in particular that signing through
  GitHub counts as the written form (CONTRIBUTING.md).
- [ ] **Load check.** Generate a company of 300 people with tens of
  thousands of tasks, comments and time entries over two years; open My
  day, a person's page, My team and a task's feed as an owner, a manager
  at the top and a participant; read the plans of the slowest queries
  (`at_risk()`, `can_see()`, `mention_reaction()` called per row) and fix
  what takes more than a few hundred milliseconds. Before 1.0: a slow
  interface is what people leave Jira for.
- [ ] **Release 1.0.** The delivery check passed (2026-11-01: the image
  built from scratch, an empty PostgreSQL 17, sign-in through a test
  SMTP, emails in each recipient's language, every webhook signature
  verified on a receiver, a restart left the data alone). Tag `1.0.0` and push it —
  the release workflow publishes the image
  ([release.md](../engineering/release.md)). The schema is already
  frozen: 0.0.0, the first published image, released schema 0.0, so
  every change of it is a migration, checked against the tag.

## Next — approved features

In this order after stage 6 (S — a day, M — a few days, L — a week or more).

Nothing approved is waiting.

## Proposals

- **Shifts across midnight; scores and time entries by shift (L).** A
  shift may run past midnight and is shown in both days; the manager
  scores shifts, time entries belong to a shift, and the day is only
  how they are shown. Reverses decision 72, changes decision 6 (time
  is logged only within a shift). Waits for the answers on the limit of
  entries per shift, scoring several shifts of a day at once, the
  migration of entries on days without a shift, and the time zone the
  times are shown in.

## Decided against

- More tabs — reminders, a company org chart, "all tasks" (decision 31).
- A task without movement in TODO — a task may be put off on purpose.
- `@` and `#` while typing in a comment — the buttons are enough.
- Notification digests — notifications stay instant.
- A service desk built in — an employee who needs help makes a task of
  their own, stays its owner and invites those who can help; external
  clients are served by tools made for it, and what needs work becomes
  a task, or time on an open-ended task for client support.
- Import from other trackers — only if migration becomes the main
  obstacle to adoption.
- Everything in "Never" of [features](features.md).
- Team metrics that push people to game the tracker (decision 39): task
  flow (many small or few big tasks), deadline moves (often not the
  owner's doing), cycle time (discourages writing down tasks of unknown
  length), blocked tasks (discourages linking tasks).
- Transliteration tables for more alphabets — not until a company needs
  one.
- An assignee, or an author apart from the owner — the owner is whose
  initiative it is; the doer is a participant who plans their hours in
  the task, or makes a task of their own the task waits for (decisions
  76, 94).
- Hour budgets that refuse time over the limit — a line to keep to,
  with everyone's plans in the forecast (decisions 69, 91).
- Links between tasks other than "waits for" — tasks are related by
  their tags (decision 56).
- Scoring criteria built into the product, and metrics of estimate
  accuracy or priorities kept — a score is the manager's judgement;
  such metrics push people to game the tracker (decision 39).
