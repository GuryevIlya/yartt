# Product decisions

Decisions on questions that looked risky from the users' side. Each records
what we chose and why, so the reasoning is not lost. New questions go to
the end under "Open".

## Decided

### 1. Only the direct manager dismisses

Any employee could dismiss anyone; one careless person could lock out a
colleague. Now only the direct manager can dismiss an employee or bring
them back. Tasks and reports of the dismissed employee move to that
manager. An employee without a manager cannot be dismissed. The right
comes from the org chart, not from a role.

*Implemented:* `dismiss_employee()`, `restore_employee()` in `db.sql`.

### 2. A passed deadline closes the task — on purpose — reversed by 93

A task whose deadline passes is closed automatically, even if the work is
not finished. This is a feature: it makes whoever started the task
answer for its deadline — set a sensible one and watch it, move it in
time, or explain why the task is closed but not done. Current tasks in
**My day** are sorted by deadline, so the nearest ones are always on top.
A closed task is not singled out — automatic and manual closing look the
same, and reopening a task closed by mistake is the owner's job. Nothing forbids
the move; a waiting task that needs this one earlier is then at risk
(decision 66), and its owner is told.

### 3. Email is built in

Without email nobody could sign in until someone wrote a webhook
receiver. Email is now built in: `SMTP_URL` and `MAIL_FROM` are passed like
the first employee's data. Sign-in links, invites and notifications are
sent in each employee's language. The webhook stays as an optional extra
channel.

*Implemented:* `server/delivery.ts`, `server/mail.ts`, templates in
`shared/i18n/<locale>.ts` (`mail`).

### 4. Tags as the title, ordered per person

A task has no title; its unique set of tags is its name. Tags are stored
sorted by id (for uniqueness) but shown in each employee's own order:
heavier tags first (the weight is a personal setting next to the tag
color); on a tie, the tag the employee meets in more of their tasks comes
first.

*Implemented:* `user_tag (color, weight)`, `ordered_tags()` in `db.sql`.

### 5. Visits are logged

Opening a task and opening **My day** are logged. The owner sees in the
task who looked at it; the history of a day (My day, the employee page)
shows which tasks were opened and when the person came in; and the shift
can be suggested from the first and last activity of the day instead of
being typed in.

*Implemented:* `visit`, `log_visit()` in `db.sql`; `Visit.log`.

### 6. Scores and time entries are optional — changed by 100

The manager decides whether to score days and which ones, and whether the
team keeps a timesheet and logs time. Nothing in the product requires
them. Averages are computed over scored days only and always shown with
the number of days behind them.

### 7. A new manager is told

An employee chooses their own manager without approval, and the manager
gets a notification (`new_report`). The inviter is not made the manager by
default: invitations are often sent by someone from support or HR.

*Implemented:* the trigger on `employee.manager_id`.

### 8. My day shows every task I see, mine apart from the others

Every manager up the chain observes all tasks of their reports, and the
database does not remember why someone became an observer — that history
is not needed. So Current tasks in My day lists every open task I see, in
two tabs: **My open** — the ones I own — and **Other open**, the rest.
My own tasks never get lost among the subtree; the rest is a reference,
not a to-do list — TODO is built only from my tasks and open mentions of
me.

### 8a. Scores live on the employee's page

Days waiting for a score are not put in TODO: scoring is optional, and a
reminder would turn it into a duty. From Team the manager opens a
person's page and sees their days; only the direct manager scores, the
managers above only look.

### 9. A mention is closed only explicitly — changed by 95

A reply to the comment does not close the mention: answering is not the
same as doing what was asked. The mentioned employee presses "Done" —
and only after replying to that comment: a reply is an answer to this
request, a comment elsewhere in the task is not. The replies show inside
the mention, all of them, so the request and its answers read together. An
open mention is also the only way a task one merely observes reaches their
TODO — the rest of its comments stay quiet, so Marina's sixty observed
tasks do not flood her day.

### 10. Finishing a task is setting its deadline to now — reworked by 93

There is no "done" status and no separate field: "Finish" sets finished_at
to the current moment and the task is closed. A manual close and a passed
deadline look the same — on purpose (decision 2).

### 11. An ownerless task is not singled out

A task loses its owner only when a dismissed employee had no manager — a
rare case. It is not shown anywhere special: an observer who needs it takes
it.

### 12. Managers see the visits too — on purpose

The employee page shows the manager everything My day shows the employee,
visits included: which tasks were opened and when the person came in. For
someone who fills in the timesheet honestly this adds nothing new, so it
does not hurt them — it helps them: the manager sees how the work really
goes and can trust them more. For someone tempted to pad the timesheet,
look busy only on paper, or let an agent work in their place, it removes
the reason to try. Transparency is the same for everyone in the chain.

### 13. The context, the owner, priority and tags keep no history

The context follows from the comments: why it changed is said there. The
owner is the task's state, not its story — it almost never changes, and
when a dismissal moves the task, the old owner is no longer relevant. Only
the deadline (what was promised and when it moved) and the observers (who
had access) keep their history.

### 14. A task with no observers is public

Some tasks concern everyone (an office move, a shared service). The owner
makes such a task public, and it has no observers at all: anyone sees it,
comments and logs time. There should be few of them, so a public task
simply appears in everyone's "others" in My day — no special filtering.

A mention in a public task adds no observer: one would make it private.
Making it private again leaves the owner, the managers above (as with any
private task) and everyone with an open mention (decision 15); the people
who commented are offered back with one click, the rest get "access
closed". A new task is private.

*Implemented:* `is_public()`, `can_see()`, `make_public()`, `make_private()`
in `db.sql`.

### 15. Observers comment and log their own time; access belongs to the owner

An observer sees everything the owner sees but changes only their own
things: writes comments, logs time, sets their own time left, closes their
own mentions, leaves the task. Adding and hiding observers, approving
requests, making the task public or private — the owner only.

*Changed by 64:* a mention no longer brings anyone in — only the owner
adds participants. Access opened or closed — added, mentioned, request approved
or rejected, hidden, task made private — is always notified, so nobody
discovers a task appearing or vanishing by accident.

*Implemented:* `add_observer()`, `remove_observer()`, `approve_access()`,
`reject_access()`, `withdraw_access()`, `make_public()`, `make_private()`,
`trg_mention_check()` in `db.sql`; notifications `access_opened`,
`access_closed`.

### 16. "No intervention needed", not "Seen"

reviewed_at is the owner's statement that nothing in the task waits for
their decision — not a read receipt. The button says so: "No
intervention needed", next to a line with what came in since the last
check (how many comments, from whom). The new comments are marked in the
feed. Until the owner says it, the task stays in their TODO. An access
request waiting for an answer is something that needs the owner, so the
button is disabled until the request is approved or rejected.

*Implemented:* `mark_reviewed()` in `db.sql` (code `pending_requests`).

### 17. The estimate is the time left

estimate_minutes is how much more time a person plans to spend, not the
total; the person updates it as the work goes. Spent + left is the
current forecast; the history of "left" shows how the forecast changed.

The task page has no time table and no totals: a sum over observers means
nothing (a manager's half hour of reading is not the task's cost). Each
person in the observer list has a clock icon if they logged time and an
hourglass if they gave their time left, the numbers in tooltips. My own
time and its buttons sit above the list. In a private task the list is
the observers; in a public one — everyone who opened it.

### 18. Navigation: tabs instead of "Back" — superseded by 31

### 19. Tags, priority and deadline are visible to everyone

Only the context, the feed and the people are private. The tags, the
priority and the deadline of any task are seen by every employee: without
them a person cannot tell whether to request access, a dependency on a
task one does not observe would be a blank line, and search by tags could
not say that such a task exists. The tags are a name, not a secret; what
is sensitive goes into the context and the comments.

*Implemented:* `can_see()` in `db.sql`; `Task.get` returns the header to
everyone and `details` only to those who see the task; search by tags finds
any task, search by text only the visible ones.

## Open

Taken while building, to be approved or changed.

### 20. TODO counts only comments by others

The "needs attention" rule in `db.sql` also counts a task never reviewed
(`reviewed_at IS NULL`). TODO takes only comments by others since the last
review, as the interface describes: otherwise every new task would sit in
its owner's TODO until they pressed a button about nothing. Access
requests come first in TODO: they have no time of their own and they block
"No intervention needed".

### 21. My day: the shift starts from the first activity

*Changed by decision 54: a shift starts now, with a button.*

Today offers "Start the shift at <first activity>" in one click (another
time through the pencil). A past day without a shift offers the one its
first and last activity suggest, confirmed in one click. Closing a shift
always opens a dialog with "what was done": a closed shift is final, so
it is the moment to think (the timesheet only moves forward).

### 22. A score is corrected; its history lives in the employee's mail

The direct manager scores a day in a small dialog (below 60% a reason is
required) and may correct the score later. The interface shows only the
current value. Every version — the value, the reason, the moment and, for
a correction, the previous value — is emailed to the employee, so in a
dispute they have the record in their mail. A score is never deleted; the
day's timesheet and time entries are frozen while a score stands — it can
be withdrawn (decision 37).

### 23. Metrics for any range, with a chart

Workload (timesheet hours and days), time logged to tasks and the score
weighted by the hours of the scored days, with the number of scored days
next to it (decision 6). Quick ranges — the last 7, 30, 90 days — or any
dates up to a year, in the employee's own days. The chart shows hours as
bars and the score as a line on its own axis; ranges over two months go
by weeks. Team shows every report's last 30 days.

### 24. Handing a task over tells the previous owner too

The owner or their direct manager hands a task over to any active
employee. The new owner gets `owner_change`; when the manager acts, the
previous owner gets `owner_handed` ("Marina hands your task over to
Ivan") — nothing about one's own work changes silently. An ownerless
task is taken by anyone who sees it, without notifications.

### 25. The employee page is a route, not a section

`/employees/<id>` opens over the sections like a task. Team lists people
with their metrics and links to their pages; My day links to one's own
("Metrics"). The page shows the same History, read-only.

### 26. One line per observer, with the reason

Observation periods are rows of `observer`; the list shows a person once,
every period in the tooltip. Someone who observes without having been
added by hand says why: the task owner, the manager of a report who
observes, or an open mention (which also keeps them when the task is made
private again).

### 27. A visit is an arrival, not a page view

A visit is logged on opening a screen and on coming back to a tab that
was hidden for 10 minutes or more; the database ignores repeats within 10
minutes. Sitting on a page all day is one visit. Every screen counts — a
task with its number, any other (My day, someone's days, a new task)
without one: someone who spent the day in History was here too.

### 28. The feed is the whole story of a task

Besides comments and deadline moves, "All events" shows a comment of
another task attaching this one, time logged and time left set or
cleared. The separate "Mentioned in" panel is gone. Daily time entries
would flood it, so one person's entries in a row — nothing else between
them — are one line with the total, the days on a click; the feed pages
count these lines, so a run is never split by a page.

### 29. Pronouns instead of "(а)"

An employee may say he or she in the profile; verb forms follow
("упомянул" / "упомянула"). Not given — a bot, or someone who prefers not
to — keeps both endings ("упомянул(а)"). Emails are written in the present
tense ("Марина оценивает…") and need no forms.

### 30. The name follows the language

The product is "yartt" in English and "яртт" in Russian: the window title,
emails and a quiet footer at the bottom of My day with the release and ©.
Next to the mark in the top line is not the product name but the name of
the only screen — Мой день / My day: the logo leads there, and people
already know which product they have opened. The mark is a tag with a
check: tasks are named by tags, and each has one owner who sees it done.
The tag takes off like a rocket: done tasks are how a product gets built
and shipped.

### 31. One screen, no tabs

Of the candidate sections none earned a tab: Team is a block of My day for
someone with reports, the tags live in the profile (they are personal
settings), reminders are on the task, a company org chart and "all tasks"
are not needed (search and Current tasks cover them). With one screen
left, tabs would be a bar with a single item — so there are none. The
logo is the way home; a task and a person's page open over My day by
route and My day keeps its state underneath.

### 32. Closed by hand or automatically — reworked by 93

A task is closed one way — its deadline comes (decision 10). The team
summary tells the two cases apart by the current deadline row: set at the
moment it took effect ("Finish", or a deadline moved to the past) — closed
by hand; set in advance (more than a minute before) and then reached —
closed automatically: the owner neither finished the task nor moved the
deadline. Nothing new is stored. The word is neutral on purpose: an
automatic close may be fine (the work was done on time), the manager
looks into it.

### 33. Tags forgive how they are typed

Tags are the title, so a misspelled tag is a second name for the same
thing and search splits in two. Tags are lower case only ("Склад" and
"склад" are one tag), and suggestions forgive typos ("инвентризация"),
transliteration ("sklad") and the wrong keyboard layout ("crkfl"): each
tag keeps its name in Latin letters, and the typed text and the same keys
read with each other layout of the person are compared with it by
Levenshtein distance and trigrams. The layouts are the person's, chosen
in the profile, not derived from the interface language: a Russian
interface says nothing about the keyboards someone switches between, and
with many languages one fixed pair would be wrong for most. Until chosen
— the interface language's layout and the US one. Layouts are tables in
the application (a new one is a line of code); transliteration stays one
for everybody, since it depends on how tags are written, not on who
types — another alphabet is a line in `translit()`. Only spaces part
words: "," and ";" are "б" and "ж" in the other layout. Comparing in Latin also keeps it working on a database with
the C locale. Several typed words are read as a set of tags: words that
match existing tags become those tags, the words around them are offered
as new ones, and a few such readings are suggested, best first — a
reading is never applied silently. A tag is created only when a task is
saved with it — while a title is typed its tags keep changing; a tag no
task carries any more is removed after a day so abandoned spellings do
not come back as suggestions.

*Implemented:* `translit()`, `tag.latin`, `employee.keyboards`, the
`tag_cleanup` cron job in `db.sql`; `shared/keyboards.ts`;
`Tags.suggest`.

### 34. A task is created in a form

*Changed by decision 55: "+" in the search opens the form with the title typed.*

The search used to be the only way to create a task: a set of tags, then
"Create", and everything else filled in on the task page. That hid
creation inside finding, and a task meant to unblock another had to be
created and then linked by its number. Now a form opens over My day from
**New task** in my tasks, or from a task's dependencies already tied to
it (a task this one waits for, or one that waits for it). The title
field works like the search (decision 33); priority, deadline, context
and the dependency are saved with the task in one transaction, under the
same rules as changing them later.

*Implemented:* `NewTaskPage`, `TagInput`; `Task.create` takes the
optional fields.

### 35. The search lives in My day and filters Current tasks

The search sat in the top line and showed its results in a dropdown —
a second list of tasks next to Current tasks, with its own look and
without pages. Now it is the input on top of Current tasks: picked tags
and typed text narrow both tabs, so there is one list of tasks and it
is filtered in place. With a filter the tabs hold any task with those
tags, closed and not visible ones included, as the old search did. "/"
from any page brings My day back with the input focused. Creating moved
out of the search (decision 34), and the search finds by tags only: text
in contexts and comments mixed tasks with a word into the list of tasks
with a tag, and a tag that does not exist finds nothing, so there is
nothing to create there. Enter takes the best suggestion. "New task"
takes the picked tags. The top line is left with the logo, Invite and
the avatar.

*Implemented:* `CurrentTasks`, `Task.search` with tabs and counts.

### 36. Typed is kept until saved or cancelled

A task page unmounts when another page opens, and with it went a half
written comment, a context being edited, a new task being filled in.
Following a link to check something should not cost the text. What is
typed and not saved — a comment, the new-task form, the tags, context or
a dependency being edited — is a draft: it stays when the person goes
elsewhere and is there when they come back, until it is sent, saved or
cancelled. Drafts live in the browser tab (they survive a reload, not a
new tab), under the employee, so a sign-in link for someone else in the
same tab never shows them; logging out clears them. The server stores
nothing. My day keeps its own state anyway (the search included): it
stays mounted under a task.

*Implemented:* `client/hooks/drafts.ts` (`useDraft`).

### 37. The timesheet is the employee's until the day is scored — changed by 100

The timesheet only moved forward: a closed shift could be neither
corrected nor deleted, a second shift was offered only for a past day
without any, and a scored day was frozen for good. A wrong end typed at
night stayed wrong, and the manager had no way to let it be fixed.

Now every shift of a day without a standing score — open or closed — can
be added, corrected and deleted, and any day may have several. The score
is what freezes the day. The direct manager can withdraw a score
(the value goes, the reason stays): the employee corrects the timesheet
and time entries, and the day is scored again, with the old reason
offered in the dialog; scoring a withdrawn day checks it like a first
score. A withdrawal is mailed like every version, so the history in the
employee's mail stays whole; a withdrawn score counts nowhere — not in
scored days, not in the weighted score, and the day waits for a score
again.

*Implemented:* `score.value` NULL, `trg_work_check()`,
`trg_spent_minutes_check()`, `trg_score_check()` in `db.sql`;
`Work.update`, `Work.remove`, `Team.unscore`.

### 38. Hours of different people are never added up — changed by 68

An hour of one person is not an hour of another: what each hour is worth
— pay, grade, contract — differs, and the company keeps it to itself, so
the product cannot store the weights and must not pretend hours are
interchangeable. A sum of the team's hours, or a score weighted by hours
across people, is therefore meaningless and is not shown anywhere.

Each person's hours stay theirs: their timesheet, and their score
weighted by their own hours. Across people only what does not depend on
the weight is combined: time in tasks as a share of each person's own
timesheet, averaged over people; the score averaged over people; counts
of days and tasks. Settled — not to be revisited without a way to know
the weights, which the product deliberately does not have.

*Implemented:* `MyDayPage/Team.tsx` (the team line), `Team.summary`.

### 39. Signals of how a team works, not only how much

Hours and scores say how much and how well, but not whether the team's
habits hold or where the work is heading. My team adds signals that come
from data already kept and that cannot be gamed by working worse:

- **How late the timesheet is written** — the median between a shift's
  end and its record: a timesheet written days later is a
  reconstruction, and a score built on it is weaker.
- **Reaction to mentions** — the median of the person's *working* time
  (their shifts, `working_minutes()`) from a mention to their first
  reply to it, and the mentions left unanswered. Time off is not theirs to
  answer for: a mention a minute after the shift, answered as the next
  shift began, took 0. Without a timesheet there is nothing to measure
  against, so no value.
- **How long days wait for a score** — on a manager's row: the median
  from the end of a report's day to the manager's score.
- **Backlog** — the person's planned work in hours (their "time left"
  estimates on open tasks, `backlog_minutes()`), its growth over the
  range and its sparkline: is planned work piling up faster than it is
  done.

Medians, so one outlier does not color a month. Across people they are
averaged, and hours — the backlog included — are never added up
(decision 38). Deliberately not measured: task flow (many small tasks or
a few big ones say nothing), deadline moves (often not the owner's
doing), cycle time (it discourages writing down tasks of unknown length)
and blocked tasks (it discourages linking tasks) — each would push people
to game the tracker instead of doing the work.

*Implemented:* `working_minutes()`, `backlog_minutes()` in `db.sql`;
`Team.summary`; the charts in `client/components/MyDayPage/TeamDetails.tsx`.

### 40. A deadline at risk is one person's plan against their own time

An open task is at risk when someone's "time left" on it does not fit
their working time before the deadline: their usual minutes per day
(the last 28 days of their timesheet, or a 40-hour week without one)
times the days left. The task line and card say "At risk" with whose
plan and by how much; My team counts such tasks per owner. The plans of
different people are never added up (decision 38) — each is measured
against their own time — and other tasks competing for the same hours
are deliberately left out: the signal is early and simple, not a
schedule.

*Implemented:* `deadline_risk()` in `db.sql`; `TaskHeader.risk`,
`Member.atRisk`; `RiskChip`.

### 41. A bot is an employee with a token

*Replaced by decision 49: a bot is a kind of employee with one key.*

CI and monitoring need to write into tasks — a failed build as a comment
that mentions whoever must react. Rather than a separate kind of account
with its own rights, a bot is an ordinary employee (invited, without a
pronoun) and a program acts as it with an API token: the same rights, the
same visibility, the same history. The bot cannot sign in, so its direct
manager issues and revokes its tokens; anyone can issue tokens for
themselves. A token is shown once and kept only as a hash; dismissal
revokes them all. The API is the one the interface uses — tRPC over HTTP
with `Authorization: Bearer` — documented for administrators in
`docs/admin/api.md`.

*Implemented:* `api_token`, `issue_api_token()`, `authenticate_token()`,
`revoke_api_token()` in `db.sql`; `server/ctx.ts`; `ApiToken` router;
`ApiTokens` in the profile and on the employee page.

### 42. Monday's email says what waits, or nothing

A manager starts the week with an email — Monday from 09:00 in their own
time zone — that says what waits for them in their team: days of direct
reports waiting for a score, tasks of the subtree closed automatically
last week, tasks at risk now, with a link to My day. Only the lines that
are there; a quiet week sends nothing, so the email stays worth opening.
It goes once a week (`weekly_digest_on`), is not copied to anyone while
the manager is away (it is about their own team), and reaches the
webhook like every notification.

*Implemented:* `send_weekly_digests()`, `employee.weekly_digest_on` in
`db.sql`; the `weekly_digests` cron job; `weekly_digest` notifications.

### 43. Offline, a change is accepted and sent later

yartt installs on a phone and keeps working without a connection — in a
train, in a basement. A change made offline is accepted at once: the
screen moves on as if it was sent, and the change waits in an outbox
kept in the browser, to go out in order at the first chance (when the
connection is back, and every 30 seconds while anything waits). The
server stays the judge: a change it refuses when it finally arrives is
dropped with its reason shown; anything short of the server's answer is
tried again, never dropped. What was last loaded is saved too and comes
back when the app starts without a connection (online, fresh data is
used — a saved state might be someone else's on a shared computer); a
service worker serves the app itself. With several tabs open, one sends
the outbox at a time, so no change goes out twice.

Deliberately not queued: signing in and out, a token shown once, and
visits (sent later, they would be logged at the wrong time). A queued
change has no result yet — a new task has no number until it is sent —
so screens that use a result handle its absence. There is no merging:
a change applies as of when it arrives, like one made a moment late.
Logging out with unsent changes asks first; another person signing in
on the same browser starts with an empty outbox.

*Implemented:* `client/hooks/offline.ts` (the offline link, the outbox,
the saved cache), `client/public/sw.js`, `manifest.webmanifest`.

### 44. My team: a narrow table of what compares, teams fold, details on a click

The first My team was a wide table: thirteen columns, sparklines under the
numbers, a horizontal scroll that hid the actions, managers who unfolded
into their reports. Managers read it as a wall: which number matters, what
a dotted sparkline says, where to bring back a dismissed person.

Now the table has only what compares across rows — time in tasks, score,
tasks, delay — and everything else goes to the details under a line, with
real charts (axes, a legend, the day in a tooltip) instead of sparklines.
Tasks closed by hand and automatically, open, at risk and the backlog are
one column; the three delays are one column showing the delay furthest
past its limit (a day for the timesheet, a working day for a reply, three
days for a score) and naming it. Teams fold, not managers: a manager is
a person in the list, and their team is a line of its own under them; my
own team is never folded, its total on top. A manager is part of their
team: its line includes them, and it unfolds into them first.

A team's score is its manager's score: how well the team works is what its
manager answers for, and an average or an hours-weighted mix of its
people's scores would either repeat the people's own lines or add up
hours of different people (decision 38). For the same reason a team has
no backlog — a dash, not a sum of hours. A person shows only for ranges
they were there in: invited before the range ended, dismissed on or after
its first day (`employee.created_at`, `dismissed_at`). Bringing someone
back is a separate, folded list under the table: the viewer's own
dismissed reports, whatever the range (decision 45).

*Implemented:* `client/components/MyDayPage/Team.tsx`, `TeamDetails.tsx`,
`TeamChart.tsx`, `teamMetrics.ts`; `employee.dismissed_at`;
`Member.days` with the delays of each day.

### 45. A dismissed employee always has a manager who can bring them back

Nobody dismisses themselves: to leave, you need a manager, who dismisses
you and gets your team — your dismissed reports too. Only that manager
brings you back, and under themselves: moving on to another manager is
then your own choice (`manager_id` is yours to set), never the manager's
— nobody hands people around. A dismissed employee without a manager
could never return, so the database keeps that from happening
(`chk_employee_dismissed_manager`): nobody is dismissed without a
manager, and when a manager is dismissed their reports, the dismissed
included, move to the manager above.

Someone at the top has no manager and cannot be dismissed. They leave
through their own people, each acting for themselves: the leaver picks
the successor as their manager — a ring for a moment (decision 90) — and
the successor dismisses them, getting the team. No special "hand
over" operation: it would have the leaver move the successor, and a
manager does not move people. Deliberately not added: a manager moving a
report, dismissed or brought back, to another manager.

Someone who will not hand over — at the top, nobody in the product can
dismiss them — is dismissed by the installation administrator with an
heir (`node server/admin.ts dismiss <email> --heir <email>`): the heir
becomes their manager and dismisses them, getting the tasks and the team;
an heir from their own team first leaves it for their place. It is a
command, not a button: the product has no admins, and whoever runs the
installation already holds its database.

*Implemented:* `restore_employee()`, `dismiss_with_heir()`,
`chk_employee_dismissed_manager` in `db.sql`; `server/admin.ts`; the
"My dismissed" list and the restore dialog in `client/components/MyDayPage/`.

### 46. Replies live in threads; the feed keeps a line at their moment

A flat feed scattered the answers to a request among later comments,
each with a quote of its parent, and "open mentions" showed the request
without what was answered. Now a reply lives under the first comment of
its thread — replies to replies too, one level deep, oldest first — so a
request and its answers read together, in "open mentions" as well.

The feed is newest first, so a fresh reply to an old comment would sink
with its thread; instead the feed keeps a grey line at the moment of the
reply ("Pavel → Marina: «…»") that unfolds the thread in place. Anyone
may reply, but a mention counts as answered only by a reply of the person
mentioned, to the comment that mentions them: a word elsewhere in the
task, or someone answering for them, does not let them press "Done"
(decision 9) and does not count in My team's reaction to mentions.

*Implemented:* `Comment.replies`, `ReplyEvent` in `shared/comment.ts`;
`threads()` in `server/services/Comment.ts`; `trg_mention_close_check()`;
`client/components/TaskPage/CommentItem.tsx`, `Feed.tsx`.


### 47. The demo has no sign-in, and never touches real data

Someone weighing yartt wants to see it lived in, through the eyes of a
CEO, a manager and the people under them — not to set up mail and sign
in to an empty screen. With `DEMO_DATA=en|ru` the image is a made-up
company in that language, drawn avatars included: the first page lists
its people, a click shows the interface as that person, and the profile
menu switches to another; "Demo" in the top line says it is not real.
Every start and every night seed it afresh, because its days are
relative to the day it was seeded and a week-old demo shows an empty
today; it is never migrated — a new image installs its schema anew. Open
to anyone, it says that whatever is written there any visitor reads and
the night erases, takes files of 2 MB at most and keeps out of search
engines.

No sign-in is safe only on made-up data, so the database says whether it
is a demo: its schema version is `demo`, a version of its own that is
never migrated. Only such a database is wiped, and one with tables at any
other version stops the start with nothing touched — a mistaken
`DEMO_DATA` neither erases a company nor opens it to everyone; the
migrator, the other way, refuses a demo database. The other
way, the image refuses to start for work without SMTP: no email, no
sign-in links.

*Implemented:* `schema_version` demo (migration `0.0-0.1`), `seedDemo()`,
`refreshDemo()` in `server/demo.ts` (nightly from `server/worker.ts`), `demoTexts.ts`, `demoImages.ts`;
`Auth.demo`, `Auth.demoSignIn`; `client/components/App/DemoPeople.tsx`;
`prod.env.example`, `demo.env.example`.

### 48. Dismissal is a date, not a missing email

A dismissal used to erase the email, so "working" meant "has an email":
bringing someone back meant typing their address again, and nobody could
work without one — a bot needed a made-up mailbox. Now whether someone
works is `dismissed_at` alone. A dismissed employee keeps their email,
and the manager brings them back without typing it; the address is not
held, though: one working employee per email, so someone new may get the
address of someone who left, and the one coming back then takes another.
An employee may have no email at all: no emails and no sign-in link, but
the bell, mentions and everything else work.

*Implemented:* `employee.dismissed_at`, `uq_employee_email`,
`restore_employee()` (migration `0.1-0.2`); `Employee.restore` with an
optional email; `server/delivery.ts` sends mail only to an address.

### 49. A bot is a kind of employee, with one key and narrow permissions

A bot used to be an invited person with an API token, and anyone could
issue tokens for themselves: a bot needed a made-up mailbox, kept a
timesheet it never wrote and showed in My team with empty metrics, and a
person's token outlived their leaving. Now an employee is a person or a
bot. `employee` keeps what both have — a name, a manager, tasks,
comments, mentions, notifications; `human` and `bot` hold the rest, and
what only people have (timesheet, time, scores, sessions, reminders,
visits, managing) refers to `human`, so the database itself keeps bots
out of it. The email stays in `employee`: one working account per address
needs it next to `dismissed_at`.

A bot has one key, without expiry: its manager replaces it when it may
have leaked. Handing the bot over and dismissing its manager replace the
key with one nobody knows, because the previous manager knew it. People
have no keys at all. A bot reads what an employee in its place would
see, and changes only what its permissions allow — its tasks, handing
them over, comments, observers: they narrow its relationships, never
widen them, so no role appears. Anyone creates a bot under themselves;
only its direct manager runs it and hands it over, at once, like tasks of
someone dismissed. Its notifications go to its own webhook as signed
JSON, with its own secret so one bot cannot forge another's; a webhook
that is down gets one attempt and never holds people's notifications.

A bot made as a person before stays a person: its manager creates a bot
and dismisses the old one, handing its tasks over by hand.

A bot has no timesheet or score, but a manager still needs to know it
works: Bots under My team show, from any day to today, its tasks, comments
and mentions, its API calls with a sparkline by day and the share
refused, the share of webhook deliveries that got through, the quiet ones
first; its settings chart calls and refusals by day. Calls are counted per bot and day in
the database, after each call and outside its transaction, so a refused
one counts too. What it created or handed over is not shown: task
creation and owner history are not kept (decision on `created_by`). A
key a year old is told to its manager once a year, without stopping it.

*Implemented:* `employee.kind`, `human`, `bot`, `bot_permission`,
`create_bot()`, `reset_bot_key()`, `transfer_bot()`,
`authenticate_bot()`, `employee_kind_row`, `bot_usage`,
`send_bot_key_reminders()` (migration `0.1-0.2`); `Bot`
router, `Meta.bot`, the check and `countBot` in `server/trpc.ts`; bot webhooks in
`server/worker.ts`, `server/webhook.ts`; `client/components/MyDayPage/Bots.tsx`,
`BotDialog.tsx`; `docs/admin/api.md`.

### 50. The unseen come first, without an alarm

A person who left the company without being dismissed in yartt — their
provider account disabled, their mailbox closed — stays in the team with
their tasks until someone notices. An alert after N days without a visit
was the first idea, but weekends and holidays make any N wrong: every
Monday it would cry about half the team. Instead My team shows, next to
everyone, when they were last seen — a visit or a session, whatever the
range — and puts the longest unseen first in each level. People away are
not spared: an absence may be on paper only, and their return date is
right next to them.

*Implemented:* `Member.lastSeenAt` in `shared/team.ts`, `summary()` in
`server/services/Team.ts`; the order and the line in
`client/components/MyDayPage/Team.tsx`.

### 51. A new email is confirmed by a link sent there

The profile changed the sign-in email at once, so a typo locked the
person out for good: the next sign-in link went to an address nobody
reads, and only a manager could help. Now "Change" sends a link to the
new address, and the email changes only when it is followed, within a
day; the old address gets a word, in case it was not them. The link goes
by email only, never to the webhook: following it is what proves the
mailbox is theirs. It signs nobody in, and following one drops the other
pending changes. An invite and bringing someone back still set the email
directly: the manager typing it answers for it.

*Implemented:* `token.email`, `request_email_change()`,
`confirm_email_change()` (migration `0.1-0.2`); `Employee.requestEmailChange`,
`Auth.confirmEmail`; the mail-only kinds in `server/delivery.ts`;
`client/components/EmailConfirmPage.tsx`, the email field in the profile.

### 52. Only the company's mail domains, and a way out for the rest

A company wants its tracker on its own addresses: a personal mailbox
outlives the job, and an address with a typo invites a stranger. With
`EMAIL_DOMAINS` set, no other address is written anywhere — an invite, a
change of one's email, bringing someone back (with their old address
too). It is configuration, like SMTP, so it lives in the environment, not
the database; exact domains only, so a subdomain is one more entry.

Someone who already has another address is not locked out: they sign in
as before, but the server refuses them everything except changing their
email (and logging out), and the interface shows only that. Their
notifications still reach the bell and the webhook; their mail gets a
request to change the address instead, at most once a day. Turning the
setting on is therefore safe on a working installation: people move to
the company's addresses on their own.

*Implemented:* `EMAIL_DOMAINS` in `server/env.ts`, `server/domains.ts`;
`Meta.outsideDomains` and the check in `server/trpc.ts`; `Auth.me`
(`Me`); `human.outside_domains_told_at` (migration `0.1-0.2`) and the
request in `server/worker.ts`; `client/components/OutsideDomainsPage.tsx`.

### 53. With the company's identity provider, it is the only way in

A company with Entra, Google Workspace or Keycloak wants one account for
everything and one switch to cut someone off. With `OIDC_ISSUER` set,
yartt signs people in only through it (OpenID Connect, the authorization
code with PKCE): no sign-in links, no invites, no changing one's email —
the provider decides who comes in and what their address is. Someone
new is created on their first sign-in, known afterwards by the
provider's id, not the email, which may change there; someone invited
before is found once by an email the provider vouches for; a dismissed
person is refused — only their manager brings them back.

Cutting someone off must reach yartt without a person remembering to,
yet a manager's decisions stay theirs. So a session lasts a day from
sign-in, active or not, and every day the worker asks the provider, with
the refresh token of the person's last sign-in, whether they may still
sign in. A refusal ends their sessions and links and stops their bots —
whoever runs a bot must be someone the company still lets in — and shows
in My team and in their manager's Monday email; dismissing them, with
their tasks and people, stays the manager's act. LDAP is not spoken
directly, so yartt never sees a password: Keycloak or Authentik bridges
LDAP and SAML to OIDC. An outage of the provider is handled by turning
the setting off: sign-in links work again on the same data.

*Changed by 86:* the email no longer follows the provider's — it is the
person's to change; an address the provider does not vouch for is
confirmed by a link on the first sign-in.

*Implemented:* `server/sso.ts` (openid-client); `sign_in_external()`,
`start_session()`, `idp_refused()`, `authenticate(p_lifetime)`,
`human.external_id`, `idp_*`, `session.created_at` (migration
`0.1-0.2`); the `idp_check` cron; `Auth.config`; the login page;
`docs/admin/install.md`.

### 54. My day keeps two days; a day is a ribbon

History in My day grew long: seven days a page, every task of a day up
to three times — logged, opened at 0, and once per visit in the log under
the shifts. Now My day keeps today and the last day before it with
activity — what was I doing? — and "History" leads to all of them, the
employee's own page, two weeks a page. A day lists every task once, with
the time logged to it; tasks opened and not logged are folded under one
line, the visits one by one under another.

Transparency stays in one line: the ribbon of the day, the shifts as
bars, every visit as a tick — faint inside a shift, marked outside one —
and what was done, a comment or time logged, as a dot. It shows at a
glance when someone was here and whether that agrees with the shifts. A
visit proves little — clicking around is easy — but a shift without a
single mark inside, or work outside any shift, stands out, and a comment
is harder to fake than a visit; that is why they are marked apart.

A shift starts now, with "Start the shift" in today's header or the icon
in the top line, and finishes now with "Finish", which still asks what
was done (decision 21). Starting from a visit is gone: an earlier start
is a correction of the shift, or a shift added by hand afterwards.

*Implemented:* `DayHistory.actions`, `HistoryInput.size` in
`shared/myDay.ts`; `client/components/MyDayPage/Day.tsx`, `DayRibbon.tsx`,
`History.tsx`; the start icon in `client/components/App/TopStatus.tsx`.

### 55. One title field everywhere; a tag is never made by accident

People did not get how tags make a title. Enter turned whatever was typed
into a new tag, so a typo became a tag; the search could not create, the
form could not tell that a title was taken until it was saved, the title
on a task page was changed in a bare field without suggestions, and a
dependency was linked by a number one had to look up.

Now one field does it all — the search of Current tasks, the new task,
changing a title, finding a task to link. Enter takes only a tag spelled
exactly so (in the search, the best suggestion); a new tag is a button
under the field, offered only when no tag is spelled so, the whole phrase
one tag ("перевести форму на новый API"). Text left unpicked becomes a
tag of its own when a task is created, unless a tag is spelled so — then
it has to be picked first. A title another task has is named, with a
link, as it is typed (`Task.byTags`; the database refuses it anyway —
uq_task_tag_ids). "+" at the end of the search opens a new task with the
title typed. A dependency is found the same way, by tags or "#number";
in "Waited on by" one of my own tasks can be linked, not only a new one.

*Implemented:* `TagInput` and `useTitle` in
`client/components/App/TagInput.tsx`; `TaskPicker`; `Task.byTags`,
`SearchInput.tab` 'all'.

### 56. A title is rubrics and a phrase

The main criticism of titles made of tags: "отчёт · q3", "api ·
авторизация" name a heading, not what is to be done, and a list of them
says nothing. A tag may be a whole phrase (decision 55), so a title is
rubrics to group by and one phrase that says what this task is: "склад ·
инвентаризация · подписать акт до пятницы". The phrase needs no flag of
its own: a tag no other task carries is the task's phrase. It is shown as
a chip like any tag — showing it as text set it apart, but a title read
the same either way, and telling the two apart on every title cost a
count per tag; the difference matters only where groups are listed.
A new task made from another one starts with that task's tags, to be told
apart with a phrase or one more tag. Under a title being
typed, the rubrics that most often go with the picked ones are offered,
so the same things keep the same names; a phrase of one task is never
offered as one.

The demo company is written this way too — "сайт · новая главная к
осенней кампании", "поддержка · тикет 1049: двойное списание по карте" —
since it is the first thing anyone weighing yartt sees.

*Implemented:* `rubric()` (a tag on two tasks or more, read with `LIMIT 2`)
in `Tags.related` and `Tags.stats`; "Often together" in `TagInput`; the
title of a related new task in `NewTaskPage`.

### 57. Closed tasks have a tab of their own

Current tasks showed only open tasks, so what was just closed — by hand
or by its deadline — disappeared, and the search mixed closed tasks into
the open ones. Now a third tab, **Closed**, holds the closed tasks I see,
the most recently closed first; with a search the closed ones found go
there too, and "My open" and "Other open" stay open tasks only. The open tabs
keep their order: the nearest deadline first, the same moment by
priority, tasks without a deadline at the end, by priority.

*Implemented:* `CurrentTab` 'closed', `current()` in
`server/services/MyDay.ts`, `search()` in `server/services/Task.ts`;
`CurrentTasks`.

### 58. Tags: what happened under each, for everyone

Tags are how work is grouped, yet nothing showed how a tag was doing.
Now My day has **Tags**, under My team, for everyone, counted only on the
tasks the person sees — a director sees the company, anyone else their
corner of it — and only on what people did: a bot's comments are
automation, not work under a tag. The range starts on any day (the last
7, 30, 90 or 365 days in one click) and always ends today, so the plans
of now belong next to it. Without a search every rubric (a tag on more
than one task — a phrase of one task is not a group) is a line, the most
active first, with pages; with tags picked, those lines and, for two or
more, their tasks all together and any of them. The order is a column's,
shown by its arrow, and any column sorts on a click: by default "In
work" — the tasks with anything in the range, a comment, time logged, a
closing — counting tasks, not events, so one noisy thread does not lift
a tag. "The most active first" alone did not say why a tag with two
tasks stood over one with twenty-two: the column it is sorted by does.

A line: tasks in work in the range, tasks open now (at risk, and not moving — no comment and no time
logged in the range), closed in the range (and how many by their
deadline), comments (and in how many tasks), people (and the average
over them of each one's share of their own time logged in the range),
how many people plan time on it now, and when anything last happened on
it, ever. What a figure means is under a "?" by its column and by the
block's title, not in a line of text read once and then scrolled past.

A line unfolds into two charts, a line per person, never stacked: each
one's time logged per day, with their share of their own time in the
legend; and each one's plan of time left at the end of each day. In the
tooltip of a day each person's value carries its detail — next to their
time, in how many tasks and ✉ how many comments; next to their plan, how
many tasks it covers: a count apart from its person says nothing about
who. The tooltip names the person only: the share in the legend is the
whole range's, and the same on every day would read as the day's. Comments, closings and people at work were a chart of
their own at first, but counts of different things on one scale read as
nothing, and the people at work show in the time chart anyway. A plan is
never on the tag's line: it would be a sum of hours of different people
(decision 38). Under the charts, each one's time, share, plan now and
comments. Everything shown goes out as CSV: a line per tag and person.

*Implemented:* `Tags.stats`, `Tags.detail` in `server/services/Tags.ts`
(`pl` — plans in force at the end of each day, from `estimate_minutes`
and `finished_at` history); `client/components/MyDayPage/TagStats.tsx`,
`TagDetail.tsx`; `SincePicker`, `HelpTip` in `client/components/App/`.

### 59. A task hovered anywhere shows what it is and who spends on it

A title says what a task is; deciding what to open or where to log time
needs a little more — what is wanted and how much it has taken. Hovering
a task in any list (Current tasks, What waits for me, dependencies, the
search, the days) for a moment shows its context, cut short, and each
person's time logged on it and time left — one's own first, then the
others, each their own, with no total (decision 38). Someone who does not
see a private task gets only that it is private. In the days a task now
shows its whole title, wrapped, not cut.

*Implemented:* `Task.preview`; `client/components/App/TaskHint.tsx` in
`TaskLine` and the day rows.

### 60. One time entry per task and day, set, not added up

Time was logged as entries added up: logging twice for one task and day
made two entries, a correction meant deleting one and logging again, and
the timesheet listed them all. Now a person has one entry per task and
day — the day's whole time on it. Logging shows what is there and
replaces it; 0 removes the entry; when it was last set shows over it. The
same entry is set from the timesheet and from the task ("Today 1h 30m"
in My time) — two places, one record. A scored day changes in no way, as
before. The migration merged the entries of one day into their sum.

*Implemented:* `uq_spent_minutes_day`, `spent_minutes.updated_at`,
`trg_spent_minutes_check()` (migration `0.1-0.2`); `Time.set` instead of
`Time.log` and `Time.remove`; `LogTimeDialog`, `MyTime`.

### 61. The days are the Timesheet

The block of one's days was called "My days" on a screen called "My
day" — two names a letter apart for different things. It is the
Timesheet now: shifts and time logged are what it holds. "History",
which leads to all of one's days, keeps its name.

### 62. The guide is in the product, written for each language

yartt drops things people expect — titles, projects, assignees, deleting
— so they need to know why as much as how. "?" in the top line (in the
menu under the avatar at phone width) opens a guide over My day: what
yartt is and what it gives, short how-tos for the usual things, and
answers to "why is it so" for every unusual rule. It is written for each
language, not translated word by word, and kept in step with features
like the demo.

It speaks of what yartt gives, not only of what it lacks: each construct
dropped is replaced by a mechanism that bends further — tags for
projects, dependencies for subtasks, one owner for assignees, observers
invited by name for access by project — with responsibility and
security in front, transparency next and everything beyond tasks
optional. It uses the interface's words only (tags, owner, observers):
"rubric" and "phrase" are how we think about tags, not what people see.
The how-tos are "use cases", and bots are presented as automation.

*Implemented:* `shared/i18n/help/ru.ts` (the reference), `en.ts`;
`client/components/HelpPage.tsx`, `/help`.

### 63. Observers are participants

"Observer" said the opposite of what the role is: someone who watches.
In yartt the people of a task solve their part of it — review it, work on
it, log time and plan it — and the owner is one of them. The interface,
the guide and the product docs now say "participant" ("участник"). The
code, the API and `db.sql` keep `observer`: a bot's permission stays
`observers`, and the schema does not change for a word. In Tags the
column of people who were active in the range is "People" ("Люди"), so it
is not taken for a task's participants.

The guide was checked against the rules while at it: only the owner
adds participants (and, since decision 64, a mention addresses only
them); managers of every participant join by themselves; access requests,
public tasks, handing over, leaving, links, reminders, the plan, the
profile and invitations each got a use case.

*Implemented:* `shared/i18n/ru.ts`, `en.ts`, `help/`; the product docs;
`docs/admin/api.md` names the permission "Participants" (`observers`).

### 64. Only the owner brings people in; a mention addresses participants — changed by 82

A mention in a private task used to make the person a participant: any
participant could widen the circle of a task by asking someone for help.
That broke the rule that access is the owner's: the owner answers for
the task and for who sees it, and an important idea could spread one
mention at a time, the owner learning of it afterwards.

Now only the owner adds participants (or approves a request for access),
and a private task mentions only its participants: the mention picker
offers just them and says the owner adds people; the database refuses
anyone else (`mention_not_participant`). In a public task anyone can be
mentioned, and still nobody is added. Someone who needs a colleague not
in the task asks the owner, or the colleague requests access. Managers
still join with their reports: that is the org chart, not a choice.

*Implemented:* `trg_mention_check()` (migration `0.2-0.3`);
`Observer.mentionable`; the mention picker in `Composer`.

### 65. A dependency constrains the deadline or it does not — superseded by 66

"Hard" and "soft" dependencies were two words to learn for one choice:
whether the deadlines are tied. Now there is just a dependency — "Waits
for" — and a checkbox "Constrain the deadline" with "no earlier than"
a time after the other; a dependency without it only shows that one
task waits for another. The constraint is spelled out where it is set,
with the numbers: "the deadline of #7 will be no earlier than 1d after
the deadline of #3: once #3 is done, #7 still has at least 1d". The line
of a dependency says "this one's deadline ≥ its + 1d" (or "its deadline
≥ this one's + 1d" on the other side). The guide, the docs and the
specification say the same. Names inside stay — `min_minutes_after`,
the error `hard_dependency_violated` and the field `hard` of the
`dependency_added` webhook payload — so integrations do not break.

*Implemented:* `Dependencies` in `client/components/TaskPage/`; the
comments of `db.sql` (migration `0.2-0.3`).

### 66. A dependency carries a latest deadline, and breaking it is a risk

The deadline constraint of decision 65 — "no earlier than a time after
the other" — still read as arithmetic, it was unclear how to change it,
and it forbade moving a deadline until the waiting task moved first: a
rule that blocked people instead of telling them. Now a dependency may
carry the latest deadline of the task waited for that the waiting task
can live with — a date and time, set by the owner of the waiting task in
"Set a latest deadline" and changed by the pencil on its line.

Nothing is forbidden by it. When the deadline waited for is later, or
not set, while the waiting task is open, the line of the dependency is
highlighted and both tasks are "At risk": the waiting one is late
because of the other, the other delays it — each says so in the hint of
its mark, and both count as at risk in My team, Tags and Monday's email.
The owner of the waiting task is told of every move of the deadline
waited for, and when it breaks the latest one. An old lag became the
waiting task's deadline minus the lag, or, without one, the deadline
waited for.

The webhook field `hard` of `dependency_added` now means "has a latest
deadline"; the error `hard_dependency_violated` is gone, nothing raises
it.

*Implemented:* `dependency.latest_at`, `dependency_risk()`, `at_risk()`,
`notify_dependents()` (`late`) — migration `0.2-0.3`; `TaskHeader.late`,
`.delays`; `Dependencies`, `RiskChip`.

### 67. What I wait for from others is a list of its own — changed by 95

TODO shows what waits for me; what I wait for from others was nowhere:
an access request I filed, or a person I mentioned and who has not
closed it, could only be found by remembering the task. Now My day has
**Waiting for others** under TODO, shown only when there is something:
my requests not answered yet, with "Withdraw" right there, and my open
mentions — whom, when, my words and their answers so far — the longest
waiting on top. It is a list apart, not part of TODO: nothing in it is
mine to do, except to nudge or to withdraw.

*Implemented:* `MyDay.waiting` in `server/services/MyDay.ts`;
`client/components/MyDayPage/Waiting.tsx`.

### 68. Hours of a task or a tag add up: they measure the work, not the people

Decision 38 kept every hour with its person: the hours of different
people were never added up, so a tag could only say how many people
worked on it and an average share of their time — which told little: one
person wholly in a tag and another who looked in for an hour averaged
into a number that meant neither.

The work, though, does not depend much on who does it. When tasks go to
people by their level — the simple ones to juniors, the hard ones to
seniors — a task takes about the same time whoever of those fit for it
does it. So the hours logged to a task or a tag, and the hours left in
everyone's plans, measure the work itself: how much the tag took and how
much it has ahead. They add up.

What they do not measure is people. A person who logs more hours is not
doing more: they may be slower, or padding. So people and teams are
still compared by their own shares — time in tasks as a share of each
one's timesheet, scores, counts — and a team's line in My team shows no
sum of hours. "At risk" is still each person's plan against their own
working time: a total plan against a total of time would hide one
overloaded person behind a free one.

Now a task shows everyone's time together — spent and left — on its
page and in its hint; a tag's line has one column "Hours", logged in the
range → left in plans, with how many people worked and plan, instead of
the people, the planners and the average share; its charts have a line
for everyone together over each person's; the CSV has a total per tag.
Each person's own share of their time stays where it says something:
next to them, in a tag's details.

*Implemented:* `TagStatsRow.minutes`, `.leftMinutes`; `People.spentMinutes`,
`.leftMinutes`; `TaskHint`, `TagStats`, `TagDetail`.

### 69. Hour budgets on tag combinations, kept to rather than enforced

Since hours of a tag add up (decision 68), a direction can have a budget:
"the website — no more than 400 hours this half-year". Anyone sets one
on a combination of tags (a task counts when it carries all of them) for
a fixed period — for themselves and everyone under them: their hours
and their people's count against it. A task under several budgets counts
in each: one may come out underspent, none overspent.

It is a line to keep to, not a rule. Nothing is forbidden and nothing is
sent: a line shows what was logged of the limit, the forecast — logged
plus what its people still plan on the open tasks — and the running
total against the limit, coloured when the forecast or the spent passes
it. It is shown where the decision is made: under My time on every task
it covers, and in the plan dialog with the forecast the new plan would
make. Whoever set it set it for themselves, so nobody can say they did
not see it.

A budget is seen by who set it, by their managers up the chain and by
everyone under them — it counts their hours, so they keep to it. Other
people's budgets are theirs alone: departments agree theirs in person.

It is never edited: a change closes it and opens a new version, removing
only closes it, and every version stays in its history — what the
budget was and from when to when. A request to change someone's budget
goes the way everything does, in a task; there is no mechanism of its
own.

*Implemented:* `tag_limit`, `can_see_tag_limit()`,
`trg_tag_limit_immutable()` (migration `0.3-0.4`); `TagLimit.list`,
`.forTask`, `.history`, `.set`, `.remove`;
`client/components/MyDayPage/TagLimits.tsx`, `TaskPage/MyTime.tsx`.

### 70. A deadline settles for a minute before it counts

Picking a date and time is often a few tries: the day, then the hour,
then a day later after all. Each try was a move of the deadline — a row
of its own in the task's history and a notification to the owner of
every task waiting for it, so a minute of thinking read as a string of
slips. Now a change less than a minute after the previous one replaces
it: the history keeps the last decision, dated by it, and a deadline put
back where it was is no change at all. The owners of dependent tasks are
told once the deadline has stood for a minute, about the deadline that
stood; a newer change in that minute replaces the waiting notification.
This is not a digest — every settled move is still told, a minute late.

*Implemented:* `change_deadline()`, `deadline_settles()` (migration
`0.4-0.5`); the worker holds `finished_at_change` until it settles.

### 71. Enter makes a new tag when none is spelled so

Decision 55 kept Enter from ever making a tag, so that a typo would not
become one: a new tag was only the button under the field. In practice
a new task often needs a new tag, and reaching for the button broke the
typing — the cursor left the field, and the button came and went with
every letter while the suggestions were checked, so the form jumped. Now
Enter takes the tag spelled exactly so, and when there is none, makes
the text a new tag; the button stays for the mouse, keeps the cursor in
the field and holds its place while the text is checked. The typo is
still guarded against where it shows: suggestions forgive typos and sit
right under the field, and a new tag is dashed until the task is saved.
In the search, which cannot create, Enter still takes the best
suggestion.

*Implemented:* `TagInput` in `client/components/App/TagInput.tsx`.


### 72. A shift belongs to one day, and an overlap names the shift in the way — reversed by 100

A shift was two date-and-time fields, so it could start one day and end
the next, or last a week by a slip of the date. It counted towards the
day it started, which a night shift made wrong, and the day's ribbon and
totals went past midnight. Now a shift belongs to one day of the
employee: the dialog shows the day and asks only for the times, the end
is at most the following midnight (00:00), and the database refuses a
shift running into the next day — work past midnight is a shift of the
next day. A shift is thereby never longer than 24 hours.

A shift overlapping another was refused with "overlaps another shift",
so someone adding a shift around the day's shifts could not tell what
was wrong. Now the refusal names the shift in the way with its times,
or the open shift and when it started; two starts of the same minute at
once (a double click) are told as an overlap too, not as an internal
error.

*Implemented:* `trg_work_check()` (migration `0.4-0.5`),
`work_pkey` -> `shift_overlap` in `server/errors.ts`; `ShiftDialog`.

### 73. A due reminder waits until it is removed or put off

A reminder is a thought put off: whoever sets one wants to stop holding
it in mind now and have it back later. It came as a notification and
was deleted — an email read on the phone, or missed, and the thought was
gone again. Now a reminder that came due waits in Waiting for me, with
its text, until its author marks it done ("Done") or puts it off ("Put
off": in an hour, tomorrow, on Monday, a day before the deadline, or a
moment picked) — then it comes again at that moment. A reminder is not a
note and is never "overdue": it is a start — "from then on this is mine
to do" — so it reads "Reminder since …", without a warning colour. The notification
still goes out once, when it is due. On the task page the due ones are
marked and put off right there.

*Implemented:* `remind.sent_at`, `send_due_reminds()` (migration
`0.4-0.5`); `Remind.move`; the `remind` item of `MyDay.todo`;
`PutOff` in `client/components/TaskPage/Reminders.tsx`.

### 74. Waiting for me groups by task; "No intervention needed" is pressed in the task — reworked by 94

Waiting for me listed every event on its own, each under a line of its
task, so a task with a mention, new comments and a reminder showed three
times and its events had to be put together by eye. Now the events of
one task are under one line of it, in the order the first one came.

New comments on my task had "No intervention needed" right in the list.
It was too easy to press it to get the item out of the way, without
reading what was written — and the comments were then gone from sight
for good, the very thing the button is meant to confirm did not
happen. Now the item says how many comments and from whom, and "Read"
opens the task, where the button is, next to the comments.

*Implemented:* `client/components/MyDayPage/Todo.tsx`.

### 75. A deadline warns a day ahead, and an automatic close is confirmed — reworked by 87

A passed deadline closes the task by itself (decision 2). The owner
learned of it only from the closed task — or from their manager, who
sees automatic closes in the team summary. Now from a day before, the
task is in the owner's Waiting for me — "closes by itself in 5 hours",
with "Move the deadline" — and if the deadline was set earlier than
that, they are notified once. When a deadline set in advance comes, the
item turns into "Closed by its deadline": the owner is notified and
confirms the close, or moves the deadline and the task is open again.
The closing is still automatic: confirming it is a look back, not a
condition, so a task never hangs open for want of a click.

What waits for a closed task hears it is done: its owner gets "A task
this one waits for is done" in Waiting for me, with "Noted", whether the
task closed by hand or by its deadline (by its deadline they are
notified too; by hand they already were, as for every deadline change).
Reopened, the task is not done any more.

Nothing is backfilled: tasks closed before the upgrade are not brought
up for confirmation.

*Implemented:* `finished_at.warned_at`, `closed_told_at`,
`confirmed_at`, `dependency.done_at`, `send_deadline_notices()`,
`change_deadline()` (migration `0.4-0.5`); `Task.confirmClosed`,
`Dependency.noted`; the `closing`, `closed` and `done` items of
`MyDay.todo`.

### 76. The owner is whose initiative it is; a participant's part is a task of their own — reworked by 94

People read "owner" as "assignee": a task to be done by someone was
handed to them. But the owner decides when the task is done — the doer,
made owner, could close it and say they would not do it, and the author
had to start the task anew. The model is right and stays (vision.md,
"Assignments"):
the owner is neither the author nor the doer, but the one whose
initiative it is. Handing a task over gives the initiative away whole;
whoever wants to keep the result in their hands does not hand it over
but brings the doer in as a participant — participants do anything
within the initiative, comment, plan and log hours.

What was missing was the doer's own place. Now a participant has "My
part" under Waits for: a new task of their own that this one waits for
from its creation — the one exception to "only the owner links what a
task waits for", since it adds nothing to the owner's task but a line.
The doer describes the part strictly as they understand it and within
their bounds, owns it and closes it; the owner is notified of it, and
sees it in Waiting for me when it is done (decision 75). The transfer
dialog and the guide say all this where it is decided.

The latest deadline of a dependency was changed by a button with words
next to the line. Now the value itself is the control: "needed by …",
or "no latest deadline" when none is set, is clicked by the owner of
the waiting task and edited in place of the line, with a hint saying
so; for everyone else the hint says who may change it. Editing in
place also fixed a line shown twice while edited, and a remove that
left the editor open.

*Implemented:* `Dependencies.addPart` (`server/services/Dependency.ts`),
`part_added`; `TaskLine`'s `onNote`; `client/components/TaskPage/Dependencies.tsx`.

### 77. My team's tasks are a tab of their own

A manager sees every task their people take part in, so "Other open"
mixed the tasks their team owns — what they answer for through their
people — with ones they merely take part in or that are public; for a
director it was hundreds of lines with the team's in among them. Now
Current tasks has **My team** between "My open" and "Other open", shown
to someone with people under them: the open tasks owned by anyone below
them down the chain. "Other open" keeps the rest. The search narrows
the new tab like the others.

*Implemented:* the `team` tab of `MyDay.current` and `Task.search`
(`subordinates()`); `CurrentTasks`.

### 78. A report's page shows what waits for their attention — superseded by 83

To know what holds a report up, a manager had to ask, or open their
tasks one by one. Now a report's page shows a manager above them two
more blocks: **Waiting for his/her attention** — the report's Waiting
for me as they see it (requests, mentions, new comments, deadlines
closing, closings to confirm, parts done), grouped by task — and **His/her
open tasks**, the ones they own, by deadline, at risk marked. It is
read-only: the buttons are the report's. Their reminders are left out:
a reminder is "seen only by you", a thought put off, not something
waiting. Mentions in tasks the manager does not see are left out too.

*Implemented:* `Team.attention`, `MyDay.todo(me, viewerId)`,
`MyDay.openOwned`; `client/components/EmployeePage/Attention.tsx`,
`TodoList` (read-only) in `client/components/MyDayPage/Todo.tsx`.

### 79. My team and Tags are pages of their own — reversed by 83

My day had grown: under Current tasks came the team table, the tags,
the hour budgets and the bots — useful, but not what needs a person
today, and a manager scrolled past a dashboard to reach their days.
Now My day keeps only what needs me: Waiting for me, Waiting for
others, Current tasks and the timesheet. **My team** (`/team`) holds the
team and the bots, for someone with people or bots under them; **Tags**
(`/tags`) holds the tag summary and the hour budgets, for everyone. Both
open from the top line (and its menu at phone width) over My day, the
way a task does, and keep their state when left. This narrows decision
31 — still no tabs, no settings screen — rather than reversing it: the
pages are reached from the line every screen has, and the logo still
brings My day back as it was.

*Implemented:* `client/components/TeamPage.tsx`, `TagsPage.tsx` (their
parts in `TeamPage/`, `TagsPage/`), `useTeamRole`; the routes in
`App.tsx`, the buttons in `Header.tsx`.

### 80. The guide starts with the first day and draws what it explains

A newcomer had to read the guide several times: dense paragraphs, the
unusual rules explained in the middle of how-tos, nothing to look at.
The goal is a briefing of minutes. Now the guide opens with five steps
for the first day, then diagrams — where things are on the screen, who
is who in a task (owner, participants, managers, and what handing over
means), a task's life up to the deadline closing it, and "My part" —
then the essentials in two sentences each, the how-tos, a glossary of
the words the interface uses, and the "why" answers. The diagrams are
drawn by the interface from the guide's own text, not screenshots: they
read in every language and do not go stale when a screen changes.

*Implemented:* `quickStart`, `diagrams`, `glossary` in
`shared/i18n/help/*.ts`; `client/components/HelpPage/Diagrams.tsx`.

### 81. An overlapping shift is never saved

Decision 72 named the shift in the way only after "Save" was pressed.
Overlapping shifts are never to be saved, so the dialog now checks the
times against the day's shifts (and an open one) as they are typed: a
conflict is named in the dialog — "overlaps your shift 10:00–12:30" — and
"Save" stays off until the times are moved. The database still refuses
an overlap, for what the dialog cannot see.

*Implemented:* `others` of `ShiftDialog`, passed by `Day`.

### 82. Any participant brings people in; the owner removes them

Decision 64 kept adding participants to the owner. In practice a head
of a department brought into a task needs to bring in their own people,
and had to ask the owner for each. Now any participant of a private
task adds someone, the way a copy is added to an email; the new
participant is told who added them. The owner keeps the rest of access:
removes whoever came in by mistake, answers requests, makes the task
public or private.

New people also took being a participant for being kept informed: they
added colleagues and assumed those read the task. Participants are not
notified of comments — only the owner and those mentioned are. The add
field now says so: a participant sees the task; for an answer or an
action, mention them. The guide's first-day steps say it too.

*Implemented:* `add_observer()` (migration `0.4-0.5`); `People`.

### 83. My day folds what is not for today; a report's page is their My day

Decision 79 took the team, the tags, the budgets and the bots out to
pages of their own, to keep My day to what needs a person today. But a
manager wanted to look at a report's day with the report's eyes — and
the report's day then lived on three screens. So they are back in My
day, folded: below the tasks each is a line — its title and what it is
about — and opens on a click, staying open in that browser. The screen
stays light, and nothing moved away.

A report's page now shows a manager above them that My day as the report
sees it: Waiting for him/her, what they wait for from others, their
Available tasks (with "Team open" if they lead people), their team,
tags, budgets and bots, folded the same way, and their two days in the
timesheet — every block read-only: no buttons, no search, no new task.
Their reminders are left out — a reminder is theirs alone. All their days
in pages, where older days are scored, are folded under it. Every query
behind a block takes `as`, checked on the server: the viewer must be a
manager above that person. Decision 78's two blocks are replaced by it.

*Implemented:* `Fold`, `ViewAs`/`useViewAs`, `DayColumns`
(`client/components/MyDayPage.tsx`); `as` in `MyDay.todo`, `waiting`,
`current`, `Team.summary`, `Tags.stats`, `detail`, `TagLimit.list`,
`history`, `Bot.list`, `stats` (`viewAs()` in `server/services/Team.ts`).

### 84. Files are limited, and deleting one keeps its place

Nothing stopped someone from attaching a film, or a thousand small files,
until the database outgrew its server. Now the configuration limits them
(the installation decides, not the product): a file at most `FILE_MAX_MB`;
a person's files at most `FILE_QUOTA_MB` together — an upload over it is
refused with how much is taken. Nothing is deleted by size or age: an
old file may be exactly the one needed, and only a person knows which
they can do without — they let go of files when their quota runs out.

A file is kept while someone holds it in their quota. Whoever uploads it
holds it; anyone who sees a file in a task can keep it too ("Keep in my
files" by the file in the comment) — a file handed to the one who needs
it stays theirs when its author lets it go. **My files**, folded at the
end of My day, shows how much of the quota is taken, the files I keep
and below them those I uploaded and let go — names in comments, tasks,
when, how many keep them. "Let go" frees my space; kept by others, the
file stays for them; let go by the last one, its content is deleted. The
row and every comment's link stay — struck through, saying when — and
anyone who has the file brings it back by uploading it again: the same
bytes find the row and fill it, and every link works again. Identical
files are one row whoever uploads them, so a file shared in a team is
stored once.

*Implemented:* `attachment.held_by`, `purged_at`, `keep_attachment()`,
`release_attachment()` (migration `0.4-0.5`); `FILE_*` in
`server/env.ts`; `Attachment.mine`, `keep`, `release`;
`client/components/MyDayPage/Files.tsx`.

### 85. My open is my work: what I own and what I plan time on

"My open" held only the tasks I own, so a task where I take part and
have planned four hours — my work for the week — was among "Other open",
next to everything I merely see. Now "My open" holds what I own and what
I have time planned on (my current time left), and "Team open" what my
people own or plan time on. The difference from ownership is kept in
sight: the line says "my plan 4h" ("team plan 6h"), and whose the task
is shows by its owner's avatar, so planning time never reads as owning.
A plan cleared, the task goes back among the others.

*Implemented:* `whose()` and `plans()` in `server/services/Task.ts`, used
by `MyDay.current` and `Task.search`; the plan note in `CurrentTasks`.

### 86. Through the identity provider, an address it does not vouch for is confirmed

People are often in yartt before the company turns its identity provider
on: invited, signing in by links for months. Signing in through the
provider for the first time, they were found only by an email it vouches
for; otherwise someone new was created — or refused, the address being
taken. Entra never vouches (no `email_verified`), other providers leave
some addresses unverified, so the same person could not come in, or came
in twice, their history on the one nobody signs in as.

Now someone the provider lets in is known by its id once bound. The
first time, an address it vouches for (inside the company's domains)
finds whoever works here with it, or creates them, as before. Without
one, the person types their work email (the provider's address is
offered) and opens the link sent to it in the same browser: the working
employee with that email is them, or they are created. The link works
only in the browser that signed in, so a forwarded one binds nobody's
account to the provider account of whoever asked; an address bound to
another provider account is never taken over without that confirmation.
The email no longer follows the provider: it is the person's, changed in
the profile with a link as without the provider. Invites and sign-in
links stay off.

*Implemented:* `external_sign_in`, `begin_external_sign_in()`,
`send_external_email()`, `confirm_external_email()`, `sign_in_external()`
returning NULL for whoever must confirm (migration `0.4-0.5`);
`Auth.ssoPending`, `Auth.ssoSendEmail`, `Auth.ssoConfirm`;
`client/components/SsoEmailPage.tsx`, `SsoConfirmPage.tsx`.

### 87. A closed task is confirmed by "No intervention needed", once nobody plans time on it — reworked by 93

Decision 75 kept three marks on a deadline — warned, told it closed,
confirmed — and a cron every minute to set the first two and send their
emails. The marks only made sure each email went once, and Waiting for
me showed all of it anyway. And a task closed with hours still planned
on it read as done while someone still meant to work on it.

Now nothing is sent and nothing is marked: Waiting for me is computed.
A task closed by its deadline waits for its owner while they have not
looked at it since (`reviewed_at` before the deadline); confirming it is
"No intervention needed", the same mark as for comments. It is refused
while anyone still has time planned on the task: each of them sees
"Closed, yet you have 3h planned on it" with "Clear my plan" — done or
no longer needed — and the owner sees whose plans are left. Closing by
hand is confirming at once, refused the same way. Only a confirmed task
is done for what waits for it: then its owners get an email and see it
in Waiting for me until they look at their own task — "Noted" is "No
intervention needed" there too. The day-ahead warning stays an item of
Waiting for me, without an email. Tasks closed before this count as
confirmed.

*Implemented:* `mark_reviewed()` (plans, `dependency.done_at`,
`dependency_done`), `change_deadline()`; `finished_at.warned_at`,
`closed_told_at`, `confirmed_at` and `send_deadline_notices()` removed
(migration `0.4-0.5`); `MyDay.todo` (`closed` with plans, `plan_left`,
`done`); `Task.confirmClosed` and `Dependency.noted` removed.

### 88. A plan says what its hours are for

"3h more" on a task said how much, not what — and once a task closed
with a plan still on it (decision 87), its owner could not tell whether
the hours were forgotten or meant something still to do. Now a plan may
carry a few words of what is left: typed with the hours in "My plan",
shown in the task, in its history and in Waiting for me next to the
plan left on a closed task. It is optional: the hours alone still make a
plan, and the words go with the plan — a new plan says anew.

*Implemented:* `estimate_minutes.about` (migration `0.4-0.5`);
`Time.setLeft({ about })`, `Time.mine.leftAbout`; the plan dialog, the
feed and the `closed` / `plan_left` items of `MyDay.todo`.

### 89. Whoever comes without an invite is welcomed by yartt itself

An invite says who asks a person in. The first employee, created on the
first start, had nobody to say it — they learned of their account only
if the administrator told them — and neither had people the installation's
administrator adds outside the interface. Now yartt itself sends them a
"You are in yartt" email with where to sign in, through the notification
queue like everything else; nobody stands as its sender.

*Implemented:* the `welcome` notification (`shared/notification.ts`,
`mail.welcome`); `server/bootstrap.ts` sends it to the first employee.

### 90. Managers may form a ring

A CEO and a CTO wanted to see each other's work, and two directors
each other's: a manager sees everything to do with their people, but
`manager_id` refused a cycle, so two people could never be each other's
managers. The tree guarded nothing, though: picking a manager opens
one's own tasks to them, never someone else's to oneself, so no ring
shows anyone what its people did not open themselves. Now managers may
form a ring — A picks B, B picks C, C picks A — and each sees everything
to do with the others, as any manager does, with nothing new to learn.

The rights stay with the direct manager, in a ring as elsewhere: each
scores the days of, and dismisses, whoever picked them. That power was
handed over by the one who picked, as always. Dismissing someone of a
ring moves their reports to their manager, as always; in the last pair
that is the one dismissing, who is then left without a manager.
Someone at the top now leaves in two steps: they pick the successor as
manager, and the successor dismisses them.

A person has one manager, so a ring has nobody above it: it is the top
of the company, or a group of its own. Two heads of departments under
one CEO cannot ring each other without leaving the CEO.

*Implemented:* `trg_employee_manager_cycle()` removed; `subordinates()`
never returns the manager themselves, `notify()` goes round a ring of
the away once, `dismiss_employee()` leaves the last of a pair without a
manager (migration `0.4-0.5`); the code `manager_cycle` became
`manager_self`.

### 91. A budget's forecast counts only what fits in its period

A budget's forecast was what had been logged plus everyone's plans on
its tasks. A plan has no date, though: 20 hours on a direction may be
meant for the whole year, and a half-year budget counted all of them as
spent within it — so a budget that would be kept showed as overrun, and
nothing could bring it in line short of cutting the plans.

Now the forecast is what was logged, plus of the plans what its people
get through before the period ends at their pace: what they logged on
its tasks in the last 28 days, per day, times the days left. A plan
bigger than that pace allows goes past the period and does not count;
a smaller one counts in full — the work ends with it rather than going
on at the pace. A new plan in the plan dialog still moves the forecast
while it fits.

The pace is of the last 28 days, not since the period began: one busy
first day would otherwise make a half-year budget look overrun, and a
period not begun yet would have no pace at all. With nothing logged in
those 28 days there is no pace to go by, and all the plans count, as
before. Spreading plans by their tasks' deadlines was considered and
left out: it assumes work goes evenly to the deadline and needs each
person's load to cap it, while the pace is a fact anyone can check.

*Implemented:* `TagLimit.aheadMinutes`, `forecast()` in
`shared/tagLimit.ts`; `TagLimit.list`, `.forTask`.

### 92. The guide explains each idea once, and sets yartt against the usual

The guide had grown by additions: the owner was explained in the
diagram, in the essentials, in the glossary, in two answers and in three
how-tos; mentions and "My part" in five places each. A reader met the
same idea in different words and could not tell which was the rule. The
glossary only repeated the diagrams and the how-tos in fewer words.

Now every idea has one home. The guide opens with the philosophy, four
principles in two sentences each: a result has one owner, a task is
seen by those invited, links rather than a hierarchy, figures that tell
the truth. Under each, the usual things it replaces stand against what
takes their place — statuses against a deadline, a subtask against
"Waits for", percent done against "5h → 3h" — in one line each, so a
principle is never left abstract and a missing thing is never named
without its replacement. The diagrams say who does what; the how-tos
say how, the answers say why, and neither repeats the other. The how-tos and the answers are
grouped by topic, questions that asked the same are merged, and the
glossary is gone.

*Implemented:* `instead`, the grouped `scenarios` and `faq` in
`shared/i18n/help/*.ts`; `glossary` and `ideas` removed;
`client/components/HelpPage.tsx`.

### 93. Only the owner closes a task; a deadline reminds — reworked by 94

Decision 87 made a task closed by its deadline wait for its owner's
confirmation, and made it done for what waits for it only then. But the
rest of yartt still read a passed deadline as closed: the task left My
open for Closed, the team summary counted it closed "automatically",
the interface said "closes by itself". The same task was open for one
rule and closed for another, and a task whose owner was away simply
vanished from the lists while nothing about it was done.

Now a task is closed only when its owner closes it, and everything
reads that one fact. A deadline that passes makes the task overdue: it
stays open — in My open, first by its deadline, its date in red — and
sits in its owner's Waiting for me as "Overdue" with "Finish" and "Move
the deadline" until they do one of them. "Finish" on an overdue task
closes it at the deadline it missed, so closing late stays visible; on
any other it puts the deadline at now, as before. Closing is still
refused while someone has time planned on the task (decision 87).
"No intervention needed" goes back to being about the comments only: a
task is never closed by reading it.

The confirmation is kept on the deadline row (`finished_at.confirmed_at`),
not on the task: a moved deadline is a new row, so the task opens again
by itself, and handing a task over — which resets `reviewed_at` — leaves
it closed. An overdue task waited for breaks the latest deadline of the
waiting one once that has passed, so both are at risk. The team summary
and the tag summary say how many tasks were closed in time and how many
after their deadline; Monday's email counts the overdue ones. Nothing is
sent at the moment a deadline passes: Waiting for me is computed, and an
email would need a mark of its own. Tasks closed before count as closed
at the deadline they had.

*Implemented:* `finished_at.confirmed_at`, `close_task()`; `mark_reviewed()`
no longer closes; `dependency_risk()`, `at_risk()`, `backlog_minutes()`,
`send_weekly_digests()` (`overdue`) read the confirmation (migration
`0.4-0.5`); `Task.close`, `TaskHeader.closed`, the `overdue` item of
`MyDay.todo`, the `closed` event of the feed; `late` instead of
`expired` in `Team.summary` and `Tags.stats`.

### 94. Waiting for me is tasks with groups of notices; anyone links a dependency

A participant's part had two shapes. "My part" made it a task of their
own that the owner's task waited for (decision 76), and "My plan" with
"What is left to do" said the same within the owner's task. The button
was "My part" for a participant and "New task" for the owner, though both
opened the same form; and a participant could not link a task that
already existed, even their own. Linking binds nobody to anything: it
only says what waits for what.

Now anyone links two tasks they see, the same rule from either side —
in "Waits for" and in "Waited on by", an existing task or a new one made
right there — under "Add" and "New task", the same for everyone; "My
part" is gone. Seeing both is what makes a link a statement about them:
nobody makes a task they do not see wait, or waited on. The usual
way to take part stays a plan within the task; a task of one's own is
for when one needs a deadline of one's own and to decide oneself when
it is done.
The latest deadline is still set by the owner of the waiting task alone:
it is their commitment. A link is removed by the owner of the waiting
task or by whoever added it. A dependency keeps who added it and when
(`added_by`, `added_at`); the owners of both tasks, other than the one
who added it, are notified.

The other half was "No intervention needed". It put `reviewed_at` at
now, so one press took away everything since the last one — a done
dependency's "Noted" in Waiting for me took away comments never read,
and whatever came while the page was open went with it. The task showed
only the comments it would take away.

Now Waiting for me is a list of tasks, and within each task groups of
notices, one group per kind of action: access requests (approve or
reject), mentions (answer or close), reminders (done or put off), a plan
left on an overdue task (clear it), and the review. The review is every
notice the owner reacts to by moving `reviewed_at`: new comments by
others, links added by others on either side, dependencies done, the
deadline a day ahead and the deadline passed.
The same block, the same way, is in My day and on top of the task.
The tasks are in the order of their deadlines, the overdue and the
nearest first, those without a deadline last; with the same deadline,
the newer task — the higher number — first. Waiting for me was ordered
by when each notice came, newest first (decision 87): what is most
urgent to decide now sank under what was most recently said.

New comments are one line, as before — "7 comments from …"; a click
opens a table of all of them in full. Until the table has been scrolled
to its end the review button is disabled and says why; this is kept in
the page, not in the database: `reviewed_at` is not a read receipt. So
the button is back in My day (decision 74): the table is where the
comments are read, not the task's page. The button is "No intervention
needed", with a warning that these notices will be gone. When the task
is overdue it is "Finish" instead, next to "Move the deadline": finishing
means nothing else needs the owner; while someone still has time planned
it is disabled and names whose plans are left, and only moving the
deadline is open. Access requests do not block it: they used to, when
the button spoke for the whole task, but now they are a group of their
own, answered apart, and a review neither waits for them nor takes them
away. Waiting for me, and the bell, count tasks, not items: a review of
ten notices and a single mention were one item each.

The press puts `reviewed_at` at the moment of the newest notice shown,
not at now, never later than now, never back: whatever came later
stays. That moment comes in milliseconds and covers its whole
millisecond, the database keeping microseconds. The day-ahead
warning is a notice at the deadline minus a day, so a review after it
takes it away; the overdue one is the deadline itself, and only
finishing or moving it takes it away. A mention of the owner is both a
mention and a new comment. Handing a task over still resets
`reviewed_at`, and now keeps when (`handed_at`). Until the new owner
accepts it, their review is the handover alone, with "Accept": not the
task's whole history as new, and nothing to read before it is theirs.
Accepting puts `reviewed_at` at the handover; what came after it is the
review from then on.

*Implemented:* `dependency.added_at`, `added_by`, `task.handed_at`,
`mark_reviewed(p_until)` (migration `0.4-0.5`); `Dependencies.set`/`remove`
(`server/services/Dependency.ts`), `waits_added` instead of `part_added`;
`MyDay.todo` (the `review` item, `taskId`), `Comment.unreviewed`,
`Task.close` with `reviewedUntil`; `Review` in
`client/components/MyDayPage/Todo.tsx`, shown in `TaskPage/Sheet.tsx` too.

### 95. A mention can be closed without a reply, and waits for its author's "Accepted" — changed by 98

Decision 9 let a mention be closed only after a reply, so whoever asked
would see the answer. In practice two needs did not fit. Some comments
are for everyone in a task (a change of plan, a date that moved), and
participants are not notified of comments (decision 82): the author had
to mention each of them, and each had to write something only to close
it. And once a mention was closed it simply left the author's Waiting
for others (decision 67): a reply or not, the author could miss that
anything had happened.

Now a mention goes through three steps:

- **Open.** In the mentioned person's TODO, as before.
- **Closed** by the mentioned person: after a reply, or with "No reply
  needed". It leaves their TODO and stays in the author's Waiting for
  others, marked "replied" or "closed without a reply", so the author
  sees whether the request got an answer.
- **Accepted** by the author: "Accepted" ends it, or the author answers
  with a new mention of the person, and the old one is accepted by
  itself. A comment with many mentions has one "Accepted" for all of
  them closed so far. If the author is a bot or dismissed, nobody is
  there to accept: closing accepts too.

The author adds a mention to a comment at any time; the time it was added
is kept, and the reaction is counted from it. The author deletes a
mention only until its first reaction (a reply by the mentioned person
or its closing): a mistake is corrected, an answered request is not
erased. After a reaction the author can accept a mention still open —
the reply was enough — and that closes it too.

**Everyone.** Mentions offer "All participants" with a list of
exceptions; it makes an ordinary mention for each person, the author
left out. In a private task "all" are the active participants; in a
public one — every active employee: a public task concerns everyone
(decision 14). Anyone who can comment may mention everyone. The feed
shows the names when half of the participants or fewer are mentioned,
and "all but …" otherwise; the share is taken against the participants
now, so nothing about the comment is stored apart.

A mention for everyone is still a request to react, and the team's
reaction time counts it like any other: the reaction is the first reply
or the closing, whichever came first, from the moment the mention was
added. If the mentioned person is away, the copy to their manager is
not sent when the manager is mentioned in the same comment — they were
told already.

*Changes decision 9:* a reply is no longer required to close a mention;
the "Noted" without a reply once decided against is now "No reply
needed", and the author's "Accepted" is what keeps the asker informed.

"All participants" leaves bots out, in a private task as in a public
one: a bot is mentioned by name, for what it is there to do, and a
mention it never closes would sit in the author's Waiting for others.
A reply made before the person was mentioned does not answer the
mention. Mentions closed before 0.6 needed a reply and left the author's
list, so the migration accepts them.

*Implemented:* `mention.created_at`, `accepted_at`, `mention_reaction()`,
`accept_mentions()` and the triggers `mention_close`,
`mention_delete_check`, `mention_accept_earlier` (`db.sql`, migration
`0.5-0.6`); `notify(…, p_told)`; `Comment.addMention`, `removeMention`,
`acceptMentions`; `client/components/TaskPage/Mentions.tsx`.

### 96. Every change of the owner is kept

A handover overwrote task.owner_id, and its only trace was the
notifications, deleted after a year: the task's feed did not say that
it had changed hands, nor who handed it over. That broke "the data never
lies" in the one place where responsibility moves.

Now every change of the owner is a row of owner_change: the moment, the
previous owner, the new one and who made it — the owner handing it over,
their manager, whoever took an ownerless task, the manager of someone
dismissed. A trigger writes it, and refuses a change whose author is not
named, so the history has no holes. The feed shows each change among
its events: "New owner: Ivan (previously Pavel)", and who made it when
that was not the previous owner.

The creation of a task is not a row: when a task was created is still
not stored (philosophy), so a task never handed over has no history.
Changes before 0.6 are restored from their notifications; the last one
is task.handed_at, and what nothing recorded is shown without its author.

*Implemented:* `owner_change`, `trg_task_owner_reset_review()` with
`yartt.actor` (`db.sql`, migration `0.5-0.6`); `setActor()` in
`server/services/Task.ts`; the `owner` event of the feed.

### 97. Who knows the subject is shown under the tags

"I do not know who should take it" was answered by the guide alone: look
up tasks with the same tags, unfold a tag's people, or ask a manager.
The data to answer it was there already: who logged time on tasks with
these tags. Studies of bug triage find the same: the history of similar
work is the strongest sign of who knows it.

Now, under the tags of a new task and under "Add participant" of a
private one, up to three people who logged time in the past year on tasks
sharing the tags, a click invites one. The most shared tags over the
most tasks come first, and the line shows how many such tasks: a count,
not hours, so people are not compared by hours (decision 68). Only
tasks the viewer sees count, so nobody's private work shows through;
the viewer, the dismissed and bots are left out.

Who has time for it is deliberately not weighed: a plan is the person's
own word, and whether they take it is for them and their manager to say
once invited.

*Implemented:* `Task.experts` (`server/services/Task.ts`);
`client/components/App/Experts.tsx` in the new task form and the task's
people.

### 98. A comment is reviewed as a whole, like a task

Decision 95 had the author accept each mention: a closed one waited in
Waiting for others until "Accepted". A comment to a hundred people,
closed one by one over a month, came back after each of them, and the
author pressed "Accepted" again and again.

Now the comment carries comment.reviewed_at, like task.reviewed_at
(decision 94): "No intervention needed" on the comment, in the task or
in Waiting for others, takes it away up to the newest reaction shown. It
comes back only with a reaction after that, a reply by the mentioned or
a closing, and then shows only those who reacted since, with "Not
answered yet: N" for the rest who never did. A comment never reviewed
shows everyone mentioned. Reviewing does not close anything: an open
mention stays in the TODO of the person mentioned, which is where the
reminder belongs, and the comment shows in the task who has not
answered.

Nothing is mailed to the author when someone closes a mention; a reply
is a comment and notifies the task's owner as any comment does. A
comment is still never edited: reviewed_at, its author's, is the one
column that changes.

*Changes decision 95:* "Accepted" on mentions, mention.accepted_at and
accepting earlier mentions by a new one are gone. Comments whose
mentions were all closed before 0.6 are reviewed up to their last
reaction.

*Implemented:* `comment.reviewed_at`, `review_comment()`,
`comment_forbid_change` over the other columns (`db.sql`, migration
`0.5-0.6`); `Comment.reviewComment`; `awaitsReview()` in
`shared/comment.ts`.

### 99. Moments are shown in the profile's time zone

Days were counted in the time zone of the profile, and moments shown in
the browser's. When the two differed, a day showed times of another: the
English demo, opened from Moscow, suggested a shift of a New York day as
"04:03 PM–01:13 AM", past midnight; a manager in another zone than a
report saw the report's shifts shifted; a deadline typed while
travelling meant another moment than it said.

Now every moment is shown and typed in the signed-in employee's time
zone: shifts, the day's ribbon, deadlines, reminders, the feed. On a
report's page, the report's My day is shown in the report's zone: their
days are theirs, and a shift reads as they wrote it. The profile says
so under the field. A day (YYYY-MM-DD) is a date and is shown as one,
in no zone.

*Implemented:* `setZone()`, `useZone()`, `clockOf()`, `zoned()` in
`client/hooks/format.ts`; `e2e/timeZone.spec.ts` runs the browser in
another zone.

### 100. A day is how shifts are shown: time is logged and scored by shift

Decision 72 kept a shift within one day, ending by midnight, so that a
day's totals stayed the day's. Night work had to be cut in two at
00:00, and a shift that crossed midnight in another time zone (decision
99) could not be written at all. And a day was the unit of everything
else: time was logged to a day without saying when within it, the
timesheet was optional (decision 6), so an entry could stand with no
shift behind it, and a manager scored a day whose shifts and entries
were not tied together.

Now the shift is the unit:

- **A shift may run past midnight.** It is never longer than 24 hours
  (a slip of the date is not a week of work). It shows in each day it
  touches, and every sum by day — the day's totals, My team, budgets of
  tags, the tag summary, the payroll export — takes the share of its
  minutes that fell in the day, in the employee's time zone, so nothing
  is counted twice.
- **Time is logged in a shift.** An entry is one per task and shift and
  belongs to the days of its shift by the same shares. All entries of a
  shift together are at most its length — an open shift's, the time
  since it began; a shift is never made shorter than the time in it and
  is not deleted while time is logged in it. Logging time therefore
  means keeping the timesheet: an entry without a shift could be neither
  checked nor scored.
- **The manager scores shifts.** "Score" on a day gives one score to all
  its closed shifts not scored yet, each of which can be left out; a
  shift's score chip opens it alone. Any closed shift can be scored. A
  standing score freezes the shift and its entries; withdrawing it frees
  them, as before (decision 37). The weighted score is weighted by the
  minutes of the scored shifts within the range, and a day's score in
  the charts is that of its shifts. Every version is mailed, one email
  per shift, with its times in the employee's time zone.

The day stays where people read: My day, History, the charts and the
weekly email count days, now days with a shift waiting for a score.

What came before 0.6 is moved as it was: a day's entries go to its
longest shift, a day with entries and no shift gets one from 09:00 as
long as its entries, and a day's score goes to each of its closed
shifts. Older days may hold more in a shift than it lasts: the limit is
checked on writing.

*Reverses decision 72; changes decisions 6 and 37.*

*Implemented:* `work.id`, `chk_work_length`, `day_split()`, the views
`shift_day` and `spent_day`, `spent_minutes.shift_id`,
`check_shift_minutes()`, `score.shift_id`, `trg_work_check()`,
`trg_score_check()` (`db.sql`, migration `0.5-0.6`); `Time.set` and
`Team.score` by shift; `client/components/MyDayPage/Day.tsx`,
`LogTimeDialog.tsx`, `ShiftDialog.tsx`, `EmployeePage/ScoreDialog.tsx`.

### 101. A sign-in link works only in the browser that asked for it

The page of a sign-in link redeemed its token as soon as it opened. Mail
scanners of large companies (Defender Safe Links, Mimecast, Proofpoint)
open every link of an incoming email in a real browser that runs the
page's scripts: the scanner used the link up and got the session, and
the person met "The link is invalid". The same link forwarded, or read
by the receiver of the webhook, signed in whoever opened it.

Now asking for a link leaves a random key in this browser's cookie, and
the token keeps its hash. The link signs in only where the key is; any
other browser is told to open it where it was asked for, or to ask for a
new one there, and the token is not used up, so the scanner that came
first takes nothing away. Asking again from the same browser keeps its
key, so every link sent to it works.

Opening the email on a phone after asking on a laptop no longer signs
the phone in: the link is asked for where it is needed. A confirmation
on the page ("Sign in" pressed by hand) was the other way out; it keeps
the forwarded link dangerous and is one more click every time.

*Implemented:* `token.browser`, `issue_token()`, `login()` (`db.sql`,
migration `0.5-0.6`); the `yartt_login` cookie (`server/ctx.ts`),
`Auth.requestLogin`, `Auth.login`; the error `login_other_browser`.
