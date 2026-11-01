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
  what takes more than a few hundred milliseconds. Count the polling too:
  every open tab asks for 5–7 queries each 30 seconds, `MyDay.todo` with
  `at_risk()` among them (hidden tabs do not poll); if it weighs, a light
  "what changed since" query in place of re-reading, and `can_see()`
  as a join rather than a call per row. Before 1.0: a slow interface is
  what people leave Jira for.
- [ ] **The image scanned before it is published.** The release workflow
  builds the image and scans it (Trivy) for high and critical advisories
  of the base image and its packages, and stops the release on one. The
  action is pinned by the commit SHA of a checked version, not a tag:
  tags of popular actions have been moved to malicious code. Server
  dependencies are checked already, on every CI run (`npm audit`).
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

- [ ] **Deadlines in the calendar** (S). A personal secret link to an
  ICS feed of one's own deadlines and reminders, for Outlook, Google
  or any calendar: nothing to set up in yartt, the calendar asks it.
  The link can be replaced, like a bot's key.
- [ ] **Search that knows Russian word forms** (M). Search by text in
  contexts and comments (trigrams now) also matches other forms of the
  same word ("задача", "задачи", "задачу"): a `tsvector` with the
  dictionary of the text's language beside the trigrams.
- [ ] **Who opened and who was let in, for the security officer** (M).
  A task's history of access: who was added, removed, approved, made it
  public, and who opened it when (the visits are there already). For the
  companies that keep data on their own servers, the reason they chose
  yartt.
- [ ] **A first day that is not empty** (S). A new person's My day shows
  the first steps in place, from the guide, until they make their first
  task.
- [ ] **Push notifications from the installed app** (M). yartt installs
  as an app already and works offline; a push to it is a channel that
  needs no webhook receiver.
- [ ] **Logs a log system reads** (S). One JSON line per event with its
  level, instead of plain text, and the queue's length and the age of
  its oldest notification in them, so a monitoring system can raise an
  alarm.

### Separate projects, after 1.0

They live in repositories of their own, on the public API and the
webhook (docs/admin/api.md), so yartt stays one image with nothing to
configure.

- [ ] **Receivers of the webhook** (M each): Telegram, Mattermost,
  Slack, Pachca. Each a small image that takes the company's webhook,
  checks its signature and sends the message to a person by their email
  or their own link to the bot. Telegram first: the first market lives
  in it.
- [ ] **Bots, with examples** (M). A description of the API for bots
  (OpenAPI from the procedures) and a few working bots: CI reporting a
  failed build into its task, a reminder from a calendar, an import of
  emails as comments.

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
