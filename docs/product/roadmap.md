# Roadmap

What is ahead — and only that. What the product already does is in
[features](features.md), why it is so — in [decisions](decisions.md). A
task leaves this file when it is done and verified; a new one comes in when
it is decided. Proposals wait for a decision in their own section.

## Now — stage 6: ready for 1.0

- [ ] **A manual pass in English** and a check that every error code
  reachable from the interface shows its message.
- [ ] **Contributions with a signed assignment.** Once the repository is
  on GitHub: install CLA Assistant, give it [legal/CAA-individual.md](../../legal/CAA-individual.md)
  as the agreement and check on a test pull request that it blocks
  the merge until the author signs; a company signs
  [legal/CAA-entity.md](../../legal/CAA-entity.md) on paper, so keep the
  signed copies. Before the first outside pull request a lawyer in
  Kazakhstan checks both agreements, in particular that signing through
  GitHub counts as the written form (CONTRIBUTING.md).
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

## Decided against

- More tabs — reminders, a company org chart, "all tasks" (decision 31).
- A task without movement in TODO — a task may be put off on purpose.
- `@` and `#` while typing in a comment — the buttons are enough.
- Notification digests — notifications stay instant.
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
