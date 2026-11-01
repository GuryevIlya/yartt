# Interface

The interface is one screen — My day — and what opens over it: a task, a
person's page, the profile. Each answers one question. There is no settings
screen and no tabs (decision 31).

## The top line

A thin line, not a toolbar: the logo (the mark and the name of the only
screen in the interface language — Мой день / My day), my open shift
with its running time (a click closes it — the end of the day is often
spent on a task page; a shift is started in My day, where the first
visit suggests its start), a bell with how many TODO items wait for me
(a click brings My day and scrolls to TODO, flashing its title — so a
new mention is noticed on any page, My day itself included),
**I'll be away** (a calendar: the day I'm back — tomorrow, Monday, in a
week or any date; while away it reads "Back Oct 24", and my
notifications are copied to my manager; "I'm back at work" clears it),
**Invite** (a person with a plus: a small dialog
with a name and an email) and my avatar (a photo, or the initials in a circle). The avatar
opens a menu: Profile, How to work, Log out. "?" opens the guide (`/help`, decision 62): what yartt gives, how-tos, why the unusual rules are so — written for each language; at phone width it is only in the menu. The search lives in My day (3). Without a connection
the top line says "Offline" or how many changes wait to be sent; the
app installs on a phone and opens offline with what was loaded last
(decision 43). The product name and its release are in a quiet footer at the bottom
of My day.

The logo is the way back: there is no "Back" line on a page. My day keeps
its state while a task or a person is open (its tab, pages, scroll), so the
logo returns me exactly where I was — the search and its picked tags
included (3); a task is created in the new-task form (2a). Whatever is
typed and not saved — a comment, a new task, an edit — waits as a draft
until I come back to it (decision 36).

## 1. My day — "what needs me?"

The home screen, and the only one. Marina opens it with her morning
coffee; Pavel keeps it open all day. On top what needs me today — what
waits for me, what I wait for, my tasks — and my days beside them; below,
folded to a line each until opened (and remembered open), my team, the
tags, the hour budgets and the bots (decision 83):

- **TODO** — what waits for my reaction, counted in tasks, here and on
  the bell: tasks, by deadline — the
  overdue and the nearest first, those without one or closed last, the
  same deadline the newer task first — and under the line of each task its
  groups, one per kind of action (decision 94):
  - access requests to my task: approve or reject;
  - the review of my task — everything that came since I last looked,
    which I answer by "No intervention needed": comments by others, one
    line "New comments: 7, from …" with "Read" that opens them all in a
    table, in full; links others added on either side ("Pavel: this task
    now waits for" and the task); tasks it waits for that their owners
    closed; its deadline a day ahead ("Deadline in
    5 hours", with "Move the deadline") or passed ("Overdue", with whose
    plans are left). One button for the whole group: "No intervention
    needed", after a warning naming what will go away; on an overdue task
    "Finish" in its place, disabled while someone has time planned on it.
    Disabled until the table of new comments was scrolled to its end
    (kept in the page, not the database); access requests, a group of
    their own, do not hold it up and stay. It takes away what was shown — up to its newest notice — so
    whatever came later stays. A task handed to me and not accepted yet
    shows only "The task was handed to you" with "Accept"; accepted, what
    came after the handover is its review;
  - mentions of me that are still open. A mention closes only explicitly:
    a reply alone does not mean the request is handled. Before I reply
    to the mentioning comment ("Reply"; a comment elsewhere in the task
    does not count) the button is "No reply needed", after it "Done";
    whoever asked sees which (decision 95). Every reply shows
    inside the mention ("My reply: …"), oldest first. This is
    the only way a task I merely take part in gets here — its other comments
    stay quiet;
  - my reminders that came due — "Reminder since …", something to do from
    then on, not overdue: each waits with its text until I mark it done
    or put it off — in an hour, tomorrow, on Monday, before the
    deadline or at a moment I pick (decision 73);
  - overdue tasks with my time still planned on them, with "Clear my plan".
  The same block, the same way, is on top of the task's page. Each item
  has its action right there. When TODO is empty, the screen says so —
  that is the goal. Days of my reports waiting for a score are not here:
  scoring is never required, it lives on the employee's page.
- **Waiting for others** — a list of its own under TODO, shown only when
  there is something: my access requests the owner has not answered yet,
  with "Withdraw", and my comments with mentions I have not accepted —
  the beginning of the comment, and under it each person: "no reply",
  "replied", "replied, closed" or "closed without a reply", with their
  answers. One "Accepted" takes every mention of the comment that has a
  reaction (an answered open one is closed by it); mentioning the person
  again in the task accepts the earlier one by itself. The longest
  waiting on top (decisions 67, 95).
- **Available tasks** — every open task I see (no deadline, or a deadline
  ahead), in tabs: **My open** (I answer for them, or I have time planned
  on them — "my plan 4h" on the line, decision 85), for a manager **Team
  open** (those my people own or plan time on, down the chain — decisions
  77, 85) and **Other
  open** — and the closed ones I see in the last, **Closed** (decision 57); each
  explains itself on hover. Open tasks are by deadline, nearest first,
  the same moment by priority; tasks without a deadline at the end, by
  priority. Closed ones are the most recently closed first. Every tab has
  pages. For a director "Team open" is hundreds of tasks — pages keep it
  usable, the search on top narrows it (3). Public tasks of others are in
  "Other open" for everyone: there should be few of them (decision 14).
  A line of a task I see says everyone's time on it, "5h → 3h": logged,
  and still left in plans (decision 68) — how big it is and how far along,
  without opening it. Not a percentage: hours logged are not work done.
  "New task" in its title row opens a new task with what the search holds (2a). A task whose
  plan does not fit before its deadline, or that waits for a task due too
  late or delays one waiting for it, says "At risk", the reasons on hover
  (decisions 40, 66).
- **My team** — only for someone with reports, folded; see 4.
- **Tags** — for everyone, folded: what people (not bots) did
  under each tag from any day to today (the last 7, 30, 90 or 365 days
  in a click), on the tasks I see — open now, at risk and not moving;
  closed, by hand and by deadline; comments and in how many tasks;
  hours logged in the range → hours left in plans, everyone's together,
  with how many people worked and plan (decision 68); when it last moved. Sorted by a column, shown by its arrow — by
default "In work", the tasks with a comment, time or a closing in the
range; a click on another heading sorts by it — or the tags
  picked in its search with all of them together and any of them. "?"
  by the title and each column says what it means. A line unfolds into
  two charts by day, everyone together and a line per person — time
  logged and plan of time left; the tooltip of a day puts next to each person's time the tasks and ✉
  comments behind it, and next to their plan the tasks it covers — and a table of people; CSV export (decision 58).
- **My files** — for everyone, folded, at the end: how much of my quota my
  files take, the files I keep and those I uploaded and let go — names,
  tasks, when, how many keep them. "Let go" frees my space; the last one
  to let a file go deletes its content; its links stay, struck through,
  and the same file uploaded again brings it back. A file in a comment
  has "Keep in my files" — it stays mine whoever lets it go (decision 84).
- **Hour budgets** — for everyone, folded, under Tags: limits of hours on a
  combination of tags for a fixed period that I set for myself and
  everyone under me, and those my managers set (they count my hours) and
  my people set. A line: the tags, the period, "70h of 80h · 88% ·
  forecast 89h (+11% vs the budget)" — logged, and of the plans what
  fits before its end at the pace of the last 28 days (decision 91), and
  how far the forecast is above or below the limit — with a bar, coloured when
  the forecast or the logged time passes the limit; unfolded, the
  plans left and that pace, the running total day by day against the
  limit and every version.
  "New budget", the pencil (a new version; the old one stays in the
  history) and the cross (removed, folded under "Removed") are mine
  only. Nothing is forbidden or sent (decision 69).
- **Timesheet** ("My days" before: next to "My day" the two were
  confused) — today and the last day before it with activity (on
  Monday that is usually Friday: what was I doing?); "History" leads to
  all of them, my own employee page (decision 54). On a wide screen it
  sits beside the other blocks and scrolls on its own, staying in view
  while they scroll. A day in a few lines:
  - its totals — the time in its closed shifts and the time logged to
    tasks, with a warning when more is logged than worked;
  - the ribbon: the day from 09 to 18 (wider if something happened
    outside), the shifts as bars, every visit as a thin tick — faint
    inside a shift, marked outside one — and what was done (a comment,
    time logged) as a dot; a hover tells the time and the task;
  - its shifts, each corrected or deleted while the day is not scored
    (decision 37); today "Start the shift" starts one now, and "Finish"
    closes it with what was done (the end offered is now, rounded up to
    the minute) — the top line does the same with its icons;
  - every task once, in one line: its one entry of the day — the whole
    time, set and replaced, 0 removes it, at most 24 hours for the day's
    tasks together, when it was last set on hover
    (decision 60) — and "Log time" (15m, 30m, 1h, 2h a click away), so
    time is logged where the day is reviewed; the tasks opened and not
    logged are folded under one line, a reminder — without those opened
    only once closed, looked up rather than worked on;
  - the visits one by one, folded too under "Activity" (the screens and
    tasks opened; "visits" in the code).
  Any shift is added by hand with the clock in the day's header. A shift
  belongs to its day: the dialog names the day and asks only for the
  start and the end, 00:00 as the end being the midnight after it
  (decision 72); a shift in the way is named with its times as they
  are typed, and "Save" waits until they are moved (decision 81). A past
  day suggests the shift its activity shows — a day without shifts, or 30
  minutes or more of visits outside its shifts as the shift that was not
  written down — confirmed with one click.

There is no separate "closed by its deadline" item: a passed deadline
closes the task like a manual close does, and the task simply leaves
Available tasks. Reopening it is the owner's job (see decision 2).

Opening My day is logged.

## 2. Task — "what is this and who answers for it?"

A page of its own (`/tasks/<id>`). There is no "Back" line: the My day tab
in the top line returns to it without reloading — tab, page and scroll
are kept.

Two columns: the task and its feed on the left, a side panel on the right
running the whole height of the page.

Left, top to bottom:

- **Header:** the task number before the tags, so the tags never shift;
  the tags (the "title", in my own tag order), the owner with avatar, priority, deadline, and whether the task
  is public or private. The owner edits them in place and has "Finish"
  (the deadline becomes now).
- **Waiting for me:** what of TODO is in this task, the same block as in
  My day — for the owner the review with "No intervention needed".
  Pressing it is a statement — "I read this, nothing here waits for my
  decision" — not "I have seen it" (decisions 16, 94). The new comments
  are marked in the feed.
- **Context:** the owner's description, edited in place. It follows from
  the comments, so it keeps no history of its own; neither do the owner,
  priority and tags — they are the task's state, not its story.
  A task number in it or in a comment ("see #12") is a link to that
  task — in what is shown only, nothing is stored.
- **Dependencies:** "Waits for", then "Waited on by", one under the other.
  Each line — tags, priority, its latest deadline if it has one —
  "needed by 24 Oct, 12:00" in Waits for, "needs this by …" in Waited on
  by, highlighted when the deadline waited for is later or not set, and
  spelled out with the numbers on hover (decision 66) — deadline, owner's
  avatar. The latest deadline is on every line — "needed by …", or "no
  latest deadline" — and is the waiting task's owner's: in Waits for they
  change it by clicking it, edited in place of the line; for everyone
  else its hint names who may change it (decision 76). Resolved
  dependencies stay in the list, struck through, so the history of what
  blocked the task is not lost. **Add** and **New task** are next to each
  list for anyone who sees the task (decision 94), the same on both: the
  search offers only tasks I see; the latest deadline is offered only to
  the owner of the waiting task. For a
  participant, the hint of New task in Waits for says when a task of
  their own is needed — a deadline of their own — and that otherwise a
  plan here is enough. A line is removed by the owner of the waiting task
  or by whoever linked it.
- **Feed**, newest first; the composer on top is a rich text editor
  (mui-tiptap): images are pasted, dropped or picked and shown in the
  text; other files become attachments; people and tasks are attached
  explicitly. After "Send" the comment waits a few seconds with "Back to
  editing" and then goes out. Replies live in threads (decision 46): under
  the first comment, oldest first, replies to replies too (those quote
  what they answer). Anyone may reply; a mention counts as answered only
  by a reply of the person mentioned, made after they were mentioned.
  Under a comment its mentions show their state; the author adds
  someone later with @ under it, takes a mention back (✕) until it has a
  reaction, and presses "Accepted". The composer's mention picker offers
  "All participants": every person in the task, or everyone working in
  a public one, bots aside, with exceptions picked after it; when more
  than half of the people are mentioned, the comment shows "@everyone
  but …", unfolded by a click (decision 95). By default the feed shows only the
  threads with an open mention — what still waits for someone, with its
  answers; "All events" shows every thread and event, with pages. Events
  appear between the comments as grey lines: a reply at its moment
  ("Pavel → Marina: «…»", a click unfolds the thread in place), deadline
  moves, a comment of another task attaching this one ("Mentioned in
  #7"), time logged ("Pavel logged 2h for Oct 14"), time left set or
  cleared, and a change of the owner ("New owner: Ivan (previously
  Pavel)", with who made it when it was the owner's manager, decision 96). Time entries of one person in a row, with nothing else between
  them, are one line ("logged 16h over 8 days, Oct 5 — Oct 14"); a click
  shows the days. Who read a comment is not
  shown: in a public task that would be the whole company.

Right, the side panel:

- **My time:** what I spent and what I have left, with "Log time" and
  "Time left" — on top, apart from the list; under it the hour budgets
  the task falls under, and in the plan dialog the forecast my new plan
  would make in those my hours count against (decision 69).
- **Participants**, one list:
  - access requests first, with "Approve" and "Reject", then "Add
    participant" (owner only);
  - every participant, sorted by the last visit, with pages. No roles, no
    table: a clock icon if the person logged time, an
    hourglass if they gave their time left; the tooltip shows the
    number (decision 17);
  - the owner and a manager whose report takes part in the task have a lock
    instead of "Hide"; its tooltip says why ("Task owner", "Pavel's
    manager");
  - hovering a person shows their periods of taking part — from when to
    when, who added or removed them;
  - the owner sees "Hide" on hover, and "Bring back" on someone who no
    longer takes part in the task. Former participants stay in the list, greyed
    out;
  - "Make public" — owner only.

No tabs, no "details" section, no activity log apart from the feed and the
periods of taking part. Opening a task is logged as a visit.

### What a participant sees

Exactly what the owner sees — header, context, dependencies, feed,
participants with their time — but as text, without the requests, "Add",
"Hide" and "Bring back". A participant writes comments, logs their
own time and sets their own time left; nothing else (decision 15). Their
own open mention is shown in the header with "Done" or "No reply needed". They can leave the
task.

### Access

- Any participant adds participants, like a copy in an email; only the
  owner removes them (decision 82). The add field says that participants
  are not notified of comments — mention them for an answer. A mention
  addresses only those already in a private task — the mention picker
  offers just them, with a hint to add someone first; in a public task
  anyone can be mentioned (decision 64). Anyone else requests access.
- Becoming a participant and stopping being one is always notified: "access
  opened" (added, request approved) and "access closed"
  (hidden, request rejected, the task made private without them).
- Someone without access sees the task number, tags, priority and
  deadline — they are visible to everyone (decision 19) — and "Request
  access"; the page says that the answer comes as a notification. The
  context, the feed and the people open after approval.

### Public tasks

A task with no participants is **public**: every employee sees it, comments,
logs time; it is in everyone's "others" in My day. A mention in a public
task does not add a participant. A new task is private, with its owner as
the only participant. The owner makes it public (all participants go). Making it
private again leaves the owner, the managers above and everyone with an
open mention; the people who commented are offered back with one click
(decision 14). A public task shows a "Public" mark in its header; its
side panel lists only the people who opened it, the same way as
participants, with pages.

## 2a. New task — "what is there to do?"

A form over My day (`/tasks/new`), opened by "New task" over the search of Current
tasks, by "+" in the search of a task's dependencies, with the title typed there, or by "New
task" under a dependency. The title is the tags, typed as in Find (decision
55): typos forgiven, several words offered as ready sets of tags. Enter
takes the tag spelled so, or, when none is, makes the text a new tag — as
does the "New tag «…»" button under the field, which keeps the cursor in
the field; a new tag is shown dashed and created when the task is saved
(decision 71). With tags picked and nothing typed, the ones that most
often go with them are offered ("Often together"); with nothing picked
and nothing typed, a click lists the rubrics of my own tasks, the most
used first — in the search the same. Text left unpicked
becomes a tag of its own, the whole phrase one tag — unless a tag is spelled exactly so, which has to be
picked first. Under the field, up to five similar tasks — sharing the
picked tags, the most in common first, open before closed — so a new
task is written next to what exists. A title another task has is named under the field and
"Create task" waits. Priority, deadline, context and participants —
brought in at once, each told, as a participant brings people in later
— are optional; a
dependency the form was opened with can be dropped; opened from a task,
the title starts as that task's tags, to be told apart with a phrase or
one more tag. "Create task" opens
the new task.

## 3. Find — "where is that task?"

One input at the top of Available tasks in My day; `/` anywhere (a task
page too) brings My day back and focuses it. It finds by tags only.
Typing suggests tags — despite typos, transliteration or the wrong
layout, and several words as ready sets of tags (decision 33); Enter
takes the best one. A tag nobody has finds nothing, but "New task" in the
title row of the block — a button with a word, not a bare "+" in the
field — opens a new task with the title as typed: the picked tags and
the rest as a new tag (decision 55); it waits while a tag spelled so is
not picked, and when a task has that title already the field names it
with a link. Picked tags narrow the tabs to the tasks carrying all of
them — any task then, ones the person does not see included (they open
on "Request access"), since tags are visible to everyone; the closed
ones found are in their own tab. When the current tab has nothing and
another has, that one opens. A tag in a line of the block, clicked, is
added to the search instead of opening the task. Everywhere else a
task's title is its tags as text — "склад · инвентаризация за октябрь" —
not chips, and a tag is not a link.

## 4. My team — "how is my team doing?" (managers only)

A folded block of My day under Available tasks, for someone who has
reports, for a range (the last 7, 30, 90 days or any dates). The table is
narrow — four columns that compare across rows, no horizontal scroll
(decision 44):

- **in tasks** — the share of their own timesheet logged to tasks;
- **score** — weighted by their own hours; under it, the days waiting
  for my score (my direct reports);
- **tasks** — open now; a warning sign with how many are at risk; under
  it, the planned hours (their "time left" on open tasks);
- **delay** — the one of three delays furthest past its limit, named
  under it: writing the timesheet (median from a shift's end to its
  record; a day is the limit), replying to mentions (median of their
  working time to the first reply to it; a working day), scoring reports' days
  (median from the day's end to the score; three days).

On top, the line of all my team — me included; then me (my own report:
there is no other place to see it) and my direct reports, always shown.
Next to each name — when they were last seen, whatever the range, and
within each level the longest unseen come first, people away included
(their return date is next to them): someone gone without being
dismissed rises to the top (decision 50).
A report who manages others is the line of their team, folded: the
manager is part of it, so it unfolds into them first, then their people,
with their own teams folded the same way. A team's line combines its
manager and everyone under them: counts add up, shares and delays are
averaged over people, its score is its manager's, its backlog is not
shown (people and teams are compared by shares, not hours — decision 68). Only people who were
there in the range are shown: not someone invited after it or dismissed
before it.

The chart sign at the end of a line (or a click on the line) opens its details under it: the timesheet hours and
days, logged time, scored days, tasks closed by hand and automatically
(decision 32), the backlog and its growth, each delay and the unanswered
mentions — with charts over the range (time in tasks, score, backlog,
the three delays; a team's are the averages of its people, its score
chart is its manager's). A person's details let their direct manager
dismiss them (decision 45).

Under the table, folded, **My dismissed**: my own dismissed reports,
whatever the range — only I can bring them back, under me; moving to
another manager is then their own choice (decision 45). Ticks pick people
for a line of their own ("Picked", the score averaged over them); a
team's tick picks the whole team. **Export** saves the picked people (or
everyone) for payroll: an Excel file with a summary per person and a
sheet per person-day (timesheet, logged time, score), or the days as
CSV — built in the browser, with no total of hours across people. At
phone width the "in tasks" column and the ticks give way; the details
keep everything.

A name opens the person's page. Inviting is not here — anyone invites
from the top line. Bots are not people here: they have a block of their
own (4b).

## 4b. Bots — "what are my programs doing?"

A folded block of My day under the budgets — for someone with people or
bots under them — and the same list in the profile (decision 49): my
bots and those of everyone under me, dismissed ones included, with what
each may change; whose a bot is shows when it is not mine. From any day
to today (the last 7, 30, 90 or 365 days in a click), with "?" by the
title and each column: its open tasks and those it takes part in, its
comments and the people it mentioned, its tasks closed, its API calls
with a sparkline by day and the share refused (asked for what it may
not — set up wrong or broken), the share of its webhook deliveries that
got through, and its last call — the quiet ones
on top, so a bot that stopped is seen. A key over a year old has a
warning sign, and its manager gets a word once a year; it keeps working.
**New bot** creates one under me. A click opens its
settings, with a chart of its calls and refusals by day: name, pronoun, what it does, what it may change (four
permissions; none — read only), its webhook and signing secret, its key
(replaced on demand and shown once), handing it to someone (at once, the
key changes) and dismissing or bringing it back. Only its direct manager
changes anything; managers above look.

## 4a. Employee page — "how are this person's days?"

All of their days, as in My day — shifts, time logged to tasks, the
ribbon of visits and what was done, the score of each day if given — in
pages of two weeks, laid out as a grid of day cards of one size; a day that does not fit scrolls in its card, with "Details" under it,
which opens the whole day, with its actions, in a dialog. Nothing is hidden from the managers (decision 12). Seen by the employee and every manager
above them. Only the direct manager scores a day — never required;
managers higher up only look. A score is given in a small dialog, with a
reason for a low one, and may be corrected or withdrawn so the employee
can correct the day (the reason stays for the next score); the page
shows the current value, the employee's mail keeps every version
(decisions 22, 37). On top —
workload and the weighted score for 7, 30, 90 days or any dates, with a
chart (decision 23). For a manager above, under them: the person's My
day as they see it — Waiting for him/her (without their reminders),
Waits for others, Available tasks, their team, tags, budgets and bots,
and their two days — every block read-only, without their buttons; all
their days, in pages, folded below (decision 83). A bot's page is only
who it is and who runs it.

## 5. Profile — "who am I here?"

A dialog behind my avatar, not a screen.

- **Name, about me** — what I write; saved with one button. "About me" is
  free text: position, how to reach me, anything colleagues should know.
- **Sign-in email** — changed with "Change": a link goes to the new
  address, which becomes mine only when it is followed, within a day; the
  old address gets a word (decision 51). Only the company's domains are
  taken when they are set; someone whose address is outside them sees a
  single page after signing in — why, and this field (decision 52).
- **Back at work on, time zone, language, my manager** — applied as soon as
  picked, no button. "Back at work on" covers any absence: vacation, sick
  leave, a day off; until that day my notifications are copied to my
  manager.
- **Pronoun** — he, she or not given: verb forms follow.
- **Appearance** — as the system, light or dark; kept in this browser.
- **Keyboard layouts** I switch between (by default the interface
  language's and the US one): tag search reads a word typed with the
  wrong one in each of them (decision 33).
- **Avatar** — a photo, cropped to a square; or the initials.
- **Bots** — a section with the list of 4b, to create a bot without
  having people under me.
- **My tags** — a second section of the dialog: the tags of the tasks I
  see, with how many tasks carry each; my own color and weight of a tag
  (nobody else sees them). A tag opens the search narrowed to it.
- Log out on all devices.

There is no list of all employees: a person is picked where needed (my
manager, a mention, a participant), and a new one is invited from the top
line.

## Interaction rules

- **A task hovered shows itself.** In any list, a moment's hover over a
  task shows its context, cut short, and each person's time logged and
  left on it — never a total (decision 59).

- **A person picked shows who they are.** Wherever a person is picked —
  a participant, a mention, a new owner, a manager — each is offered with
  the avatar, the name and, under it, what they wrote about themselves;
  typing finds them by either ("frontend").
- **No confirmations for reversible actions.** Show what happened with
  "Undo" for a few seconds. Confirm only what cannot be undone and hurts
  others (dismissing an employee).
- **Edit in place.** No separate edit forms for things the owner changes
  daily.
- **Errors explain themselves.** A message says what happened and what to do
  next, with the task or person named, in the user's language.
- **Never an empty decision.** Defaults are always filled: the current
  user, today, the inviter's language and time zone.
- **Keyboard first for the perpetual intermediate:** `/` to search, `c` to
  comment, `Enter` to send.
