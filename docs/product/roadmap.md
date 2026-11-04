# Roadmap

What is ahead — and only that. What the product already does is in
[features](features.md), why it is so — in [decisions](decisions.md). A
task leaves this file when it is done and verified; a new one comes in when
it is decided. Proposals wait for a decision in their own section.

## Now — version 0.7.0

Decided after the first team's meeting about moving in (2026-11-03), all
in one version, before stage 6 goes on.

- [ ] **A "Related" block of a task.** Waiting stops when a task waited
  for is closed, so it moves from "Waits for" to "Related" and comes back
  when reopened. A closed task is shown by nobody as waiting. Tasks
  mentioned by `#` in comments and the context are there too, with a link
  to the mention; nothing is added by hand. The owner of a task hears when
  what waited for it closes first.
- [ ] **A request right in the new task form.** "What is needed from them"
  makes the first comment, with mentions, together with the task.
- [ ] **The editor.** Headings, links, code blocks, tables and alignment;
  no colours or sizes. A task is picked by `#` in the context too. A
  Markdown mode, since that is what language models write.
- [ ] **Webhooks of a person's own.** Anyone adds a URL (a Telegram bot
  gives one) and chooses for each event what goes there: nothing, the event
  with a link, the title, the whole text. Email is always sent. The
  company's `WEBHOOK_URL` goes away: one address getting everyone's
  messages is the worst place for them. A list of URL prefixes set by the
  administrator says where webhooks may go; without it, only outside
  addresses. Sign-in links go by email only.
- [ ] **A public API of its own, with personal keys.** `/api/v1` takes keys
  only, `/api/trpc` sessions only. A person has keys with rights and an
  expiry, gone on dismissal; a bot keeps its one key and permissions.
  Shifts, time entries and scores are read only, under a right of their
  own. The reference is generated from the schemas; Markdown is accepted
  for comments and the context.
- [ ] **Descriptions of tags.** Anyone describes a tag for themselves and
  the people below them. A task shows the descriptions of its tags along
  its owner's chain, from the top down, the same for everyone in it. One
  tag each; replacing a tag across tasks is left out.
- [ ] **The guide.** How a task is run when one owner holds it and others
  do the work: what the doer answers for, whose problem it is, the
  reviewer, rework, a big task, the context as notes on the state, one on
  one with the manager. Answers about what was rejected and why. Webhooks,
  bots and keys as three separate how-tos.

## Then — stage 6: ready for 1.0

- [ ] **Contributions with a signed assignment.** Once the repository is
  on GitHub: install CLA Assistant, give it [legal/CAA-individual.md](../../legal/CAA-individual.md)
  as the agreement and check on a test pull request that it blocks
  the merge until the author signs; a company signs
  [legal/CAA-entity.md](../../legal/CAA-entity.md) on paper, so keep the
  signed copies. Before the first outside pull request a lawyer in
  Kazakhstan checks both agreements, in particular that signing through
  GitHub counts as the written form (CONTRIBUTING.md).
- [ ] **The image scanned before it is published.** The release workflow
  builds the image and scans it (Trivy) for high and critical advisories
  of the base image and its packages, and stops the release on one. The
  action is pinned by the commit SHA of a checked version, not a tag:
  tags of popular actions have been moved to malicious code. Server
  dependencies are checked already, on every CI run (`npm audit`).
- [ ] **Release 1.0.** The delivery check passed (2026-11-01: the image
  built from scratch, an empty PostgreSQL 17, sign-in through a test
  SMTP, emails in each recipient's language, every webhook signature
  verified on a receiver, a restart left the data alone). Since then the
  signature covers a timestamp, a sign-in link works only in the browser
  that asked for it, and files may go to an object storage: check again
  the webhook signature on a receiver, a sign-in link through a real
  mail server and a corporate mail scanner, and the move of files to a
  real bucket (Yandex Object Storage or MinIO). Tag `1.0.0` and push it —
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
- [ ] **A year of summaries for hundreds of people in under a second** (M).
  The load check (docs/engineering/testing.md) leaves the slowest at a
  year seen from the top of a 300-person company: 1.5 s for the tags,
  2.5 s for the team, mostly each person's backlog day by day and the
  reaction time of every mention. Daily figures kept by the worker
  overnight would make any range a sum of days, with today counted live.
  Past days change too: a shift corrected or added, time logged into a
  past shift, a score set or withdrawn, a task's tags, a mention answered
  late. So whatever changes a day's source marks that day stale, and a
  report counts the stale days live until the worker redoes them: figures
  are never older than the data. Who sees what is still checked at every
  request, never stored in the figures.
- [ ] **Reports kept as of a moment: to weigh at the next load check** (?).
  Not needed now: nothing takes over 3 s (2026-11-02). If the next load
  check after 1.0 finds daily figures are not enough, a heavy report could
  be kept with the time it was counted and a button to count it again.
  Against it: a report is its viewer's own (person, range, filter, page),
  so it is rarely reused, and one kept after someone lost access to a task
  would still show its figures.

### Separate projects, after 1.0

They live in repositories of their own, on the public API and the
webhook (docs/admin/api.md), so yartt stays one image with nothing to
configure.

- [ ] **Receivers of webhooks** (M each): Telegram, Mattermost, Slack,
  Pachca. Each a small image: a person writes to its bot, gets a URL with
  their id in it and adds it to their webhooks in yartt. Telegram first:
  the first market lives in it.
- [ ] **Bots, with examples** (M). A few working bots on the public API:
  an agent taking part in a task as a virtual employee, a commit with `#12`
  leaving a comment in its task, CI reporting a failed build, a reminder
  from a calendar.

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
- Links between tasks made by hand other than "waits for" — a link
  without words explains nothing half a year later; tasks are related by
  their tags and by being mentioned where the reason is written.
- Scoring criteria built into the product, and metrics of estimate
  accuracy or priorities kept — a score is the manager's judgement;
  such metrics push people to game the tracker (decision 39).
