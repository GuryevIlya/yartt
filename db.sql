-- ============================================================================
--  Database: yartt (Yet Another Radical Task Tracker)
--
--  The current schema as a whole. All semantics live in COMMENT ON; read
--  them with \d+, \dt+, \dn+ or SELECT * FROM pg_description.
--
--  The schema version is major.minor, stored in schema_version (below).
--  New installation: this file is applied to an empty database as a whole.
--  Upgrade: migrations server/migrations/<from>-<to>.sql in a chain. The
--  first version is 0.0; after a release every change of the schema is a
--  migration from the released version and a new version here. A
--  migration is checked against this file as it was at the release tag
--  (tests/schema.test.ts), so nothing is kept frozen by hand.
--  The application creates the first employee on startup (from .env), or
--  the demo company with DEMO_DATA (schema_version demo).
--
--  Business rule errors: RAISE EXCEPTION ... USING HINT = '<code>'
--  [, DETAIL = '<JSON parameters>']. The code is stable; the application
--  translates it into the user's language, substituting the parameters.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;


-- ============================================================================
-- schema_version — schema version
-- ============================================================================
CREATE TABLE schema_version (
    version TEXT NOT NULL CHECK (version ~ '^([0-9]+\.[0-9]+|demo)$'),
    entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expired_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_schema_version_active
    ON schema_version((TRUE)) WHERE expired_at IS NULL;

INSERT INTO schema_version (version) VALUES ('0.6');

COMMENT ON TABLE schema_version IS
'History of database schema versions (major.minor). Current = expired_at IS NULL.
Matches the product version without the patch (patches never change the schema).
Installation: a single row with the db.sql version.
Migrations — server/migrations/<from>-<to>.sql:
  - minor: X.Y-X.(Y+1);
  - major: only from the last minor, X.last-(X+1).0.
At every step the application closes the current row and opens a new one.
The whole chain is one transaction: on failure the database stays at the
old version. No downgrades.
demo — the database holds the demo company (DEMO_DATA, server/demo.ts): it is
installed from db.sql and seeded, then this row closes the installed version;
entered_at is when it was seeded. A demo is never migrated, only wiped and
seeded afresh, and only a database whose current version is demo is ever
wiped; the migrator refuses it, and the demo refuses a database with tables
and any other version — made-up and real data never pass for each other.';

COMMENT ON COLUMN schema_version.version IS
'Schema version major.minor, or demo for the demo company.';

COMMENT ON COLUMN schema_version.entered_at IS
'When the database moved to this version (installation or migration).';

COMMENT ON COLUMN schema_version.expired_at IS
'When the database left this version. NULL = current.';

COMMENT ON INDEX uq_schema_version_active IS
'Exactly one current version.';


-- ============================================================================
-- 0. Philosophy, rules, operations, invariants
-- ============================================================================
COMMENT ON SCHEMA public IS
'yartt — a task tracker without projects, subtasks or assignments.


============================================================================
PHILOSOPHY
============================================================================

yartt is a task tracker without projects and subtasks. Flexible clustering
through tags, links through a dependency graph, responsibility through
ownership.

Key principles:
  - No projects. Flexible clustering through tags.
  - No task titles. The set of tags is the task "title": nobody has to
    agree on a title format, and searching by tags keeps their variety
    under control.
  - No subtasks. Links go through dependency — a directed graph.
  - No assignments. The task owner (the author becomes the owner) is
    responsible for getting it done on time and well thought out. The
    owner directs other employees within the task like a project manager,
    or works alone if nobody else is needed.
  - Access is defined by task visibility (observer).
  - A task is private while it has active observers: only they see it.
    The owner of a private task is always an observer. The manager
    (recursively up manager_id) is automatically added as an observer to
    every task of their reports.
  - A task with no active observers is public: every employee sees it.
    The owner makes a task public (all observers go) and private again.
  - The header of any task — tags, priority, deadline — is visible to
    every employee, so a person can tell whether to ask for access. The
    context, comments and people are visible only to those who see the
    task. Only the owner changes the header and the context.
  - All work happens in comments.
  - Comments are never deleted or hidden. If a comment is outdated, reply
    to it (reply_to_id) and say so.
  - A task cannot be deleted. A task is closed only by its owner, who
    confirms it (close_task()): a passed deadline does not close it, it
    makes the task overdue — still open, in its owner''s "Waiting for me"
    until they close it or move the deadline (decision 93). The owner can
    move finished_at (later or earlier) or clear it — owners of dependent
    tasks are notified; a moved deadline opens a closed task again.
  - A task has an owner (owner_id). There is no separate creator role.
  - Ownership can be transferred by the owner or by the owner''s direct
    manager. The previous owner stays an observer. When the owner is
    dismissed, their tasks go to their manager. With no manager the task
    is left without an owner and any observer can take it. Every change
    of the owner is kept (owner_change) and shown in the task''s feed.
  - Observers see the task and change only their own things: comments,
    their time entries, their time left, their reminders, their mentions —
    and bring others in, the way a copy is added to an email. The owner
    keeps the rest of access: removes observers, answers requests and
    makes the task public or private. A mention in a private task
    addresses only its observers; anyone else is brought in by a
    participant or asks for access.
  - Access is revoked explicitly: an observer can leave, the owner can
    remove an observer. There is also an access request flow: an employee
    files a request (added_at = NULL), the owner is notified and approves
    it (added_at = NOW()) or rejects it (deleted_at = NOW()). Opening and
    closing someone''s access is notified to them.
  - The deadline (finished_at) lives in an interval table. The current
    value = expired_at IS NULL. Clearing = closing the active row without
    opening a new one.
  - A dependency may carry the latest deadline of the task waited for that
    the waiting task can live with (latest_at). Nothing is forbidden by
    it: when the deadline waited for is later, or there is none, both
    tasks are at risk (at_risk()) — the waiting one is late because of
    the other, the other delays it — and the owner of the waiting task is
    told as the deadline moves.
  - Anyone sets limits of hours on a combination of tags for a fixed
    period (tag_limit): how much they and everyone under them may spend
    on it. A task under several limits counts in each. A limit is never
    edited: a change closes it and opens a new one, so its history is
    kept. It warns, it forbids nothing.
  - Work quality is scored only per employee per shift, never per task.
    The current manager (employee.manager_id) scores any closed shift;
    the interface scores a day''s shifts at once. Scores are optional: the
    manager decides which to score, if any. While a score stands neither
    the shift nor the time entries in it can change. The score itself can be
    corrected by the current manager; every version (value, reason, time
    and the previous value) is emailed to the employee — the mail is the
    history, the table keeps only the current value.
  - The timesheet is optional too, but time is logged to tasks only
    within a shift (decision 100): an entry belongs to a shift, and the
    shift holds what is logged in it.
  - A day is how shifts are shown and summed: a shift past midnight is
    in both days, each with its share of the minutes (shift_day).
  - Workload comes from the timesheet (work). Quality and workload are
    kept apart. A bonus is the manager''s decision; the system provides
    both metrics.
  - While a person is away (human.next_day in the future),
    notifications go both to them and to their manager (recursively up
    manager_id until an available manager is found).
  - Notifications are a queue in the database. The worker delivers them
    by email (SMTP from the configuration) and/or to an outgoing webhook
    for other channels (sent_at); the user handles a notification
    (closed_at). Cleaned up after a year.
  - Comments are never edited. The interface protects against accidental
    sending: a sent comment can be pulled back into editing for a few
    seconds and only then goes to the server.
  - Attachments live in a separate table, deduplicated by hash; a file is
    kept while someone holds it in their quota. A comment refers to them
    by an array of ids.
  - Reminders (remind) are explicit: an employee decides when to be
    reminded about a task. Once due it waits in their "Waiting for me"
    until they remove it or move it.
  - Only an employee can create another employee (an invite). The first
    employee is created by the application on its first start, and is
    greeted with a link to sign in (welcome), as is anyone the
    installation''s administrator adds outside the API. No roles:
    rights come from relationships. Only the direct manager can dismiss an
    employee or bring them back.
  - An employee is a person or a bot. A bot is a program — CI,
    monitoring — that owns tasks, comments and is mentioned like a
    person, through the API with its key, within permissions that only
    narrow what its relationships allow. It has no timesheet, time or
    scores and manages nobody. Its manager — whoever created it or got it
    handed over — runs it; its notifications go to its own webhook.
  - Visits are logged: opening a task or any other screen. They show the
    owner who looked at a task and help to suggest when a shift started
    and ended.
  - One database — one company. No multi-tenancy.


============================================================================
WHY WE DROP THE USUAL CONSTRUCTS
============================================================================

From projects to tags.
  The problem with projects: a rigid hierarchy. A task belongs to one
  project. To share one task you have to share the whole project or
  build ACLs. To reclassify a task you have to move it, which breaks
  links and reports.
  What we do: tags are free clustering. A task can have several tags.
  Tags are labels, not folders. Access to a task is separate from tags.
  The set of tags is unique and serves as the task title. There is no
  "belongs to a project" — a task exists on its own.

From titles to sets of tags.
  The problem with titles: everyone words them differently, one task is
  called five ways, free-text search is weak.
  What we do: title = a unique set of tags. New tags appear, but
  searching through existing ones keeps the vocabulary compact.

From subtasks to dependencies.
  The problem with subtasks: a hierarchy. Parent and child. A parent
  cannot be closed while a child is open. Deep nesting. "Zombie parents"
  (all children closed, the parent hangs).
  What we do: a directed dependency graph. A depends on B — A cannot be
  considered done until B is done. But B is not part of A. It is a
  separate task with its own owner. No "levels", only a network. Cycles
  and self-dependencies are forbidden.

From assignments to ownership.
  The problem with assignments: a manager gives a task to an assignee.
  The assignee does it. The manager checks. A "done / not done"
  argument. Double responsibility. A task "hangs" on an assignee who
  cannot close it. Or the assignee "closed" it and the manager disagrees.
  What we do: the task owner is responsible for the result. The owner is
  the author of the idea and the one in charge. They work alone or bring
  others in. The others are observers: they log time, comment, plan, but
  are not responsible for the result. Ownership can be transferred. Only
  the owner closes the task, by confirming it; a deadline that arrives
  only makes it overdue.

From scoring tasks to scoring people per day.
  The problem with scoring tasks: a task lasts months and ten people work
  on it — what do you score? Whom do you blame? Unclear. A "bad" or
  "good" score is subjective and vague. Gaming: close faster to avoid
  being late, or drag it out to look "hard".
  What we do: the manager scores a person''s shifts, 0–100%, a day''s at
  once. The score is about the quality of the day''s decisions: did the person pick the
  right priorities, do their decisions match the manager''s
  understanding. Not about the task result. A task may fail while the
  scores are good if the person chose well every day — then the problem
  is in priorities, plans or the manager, not in the person. Weighted by
  timesheet hours.

From created_by to owner_id.
  The problem with created_by: the creator is a role without
  responsibility. "I created it, but it is not mine." Responsibility
  blurs.
  What we do: owner_id. Creator = owner. No separate "author" role.
  Ownership can be transferred, and every change is kept (owner_change):
  whose the task was and since when, never when it was created. No
  "who created it" role — not needed. Creation is not a metric. Lead time / cycle time are easy to
  game (create only "quick" tasks). created_at is not stored at all.

From deleting to closing.
  The problem with deleting: delete it and the data is gone. Metrics
  drift. History is lost. Links break.
  What we do: a task cannot be deleted (trigger). finished_at can be
  set, cleared (the task is back in progress) or moved. A task is closed
  when its owner confirms it; one whose deadline passed unconfirmed is
  overdue — a signal: "missed it and did not warn".

From watching a person to requesting access.
  The problem with observer_link: A "watches" B and sees all of B''s
  tasks. Cognitive load. "I followed Pete — now there are 200 tasks in
  my feed."
  What we do: access is per task. Want to see it — ask, or get added.
  A manager is automatically added to every task of their reports (down
  the hierarchy).

From a notification inbox to a queue.
  The problem with an inbox: "1000 unread". Nobody reads them. They lose
  meaning.
  What we do: notification is a queue. A notification goes to the
  webhook, the user handles it (closed_at). Cleaned up after a year.
  Reminders (remind) are explicit: an employee sets them; a due one
  waits for them until removed or moved.

From deleting comments to "they live forever".
  The problem with deleting: delete it and the context is lost. Replies
  dangle. Links break.
  What we do: comments are never deleted or hidden (trigger). If a
  comment is outdated, reply to it (reply_to_id) and say so.
  reply_to_id is the parent''s local id.

From parsing @username to attachments.
  Employees (mention) and tasks (task_mention) are attached to a comment
  explicitly. No text parsing.


============================================================================
SEARCH
============================================================================

  - By tags: autocomplete forgiving typos, transliteration and the wrong
    keyboard layout. Every tag keeps its name in Latin letters
    (tag.latin); the typed text, and the same keys read with each other
    layout of the person (human.keyboards; the layouts themselves are
    in the application), are transliterated the same way and compared
    with Levenshtein and trigrams. Comparing in Latin also keeps trigrams
    working when the database locale is C, where pg_trgm ignores non-ASCII
    letters. Candidates are picked by the indexes on tag.latin first — the
    nearest by trigrams (GiST, KNN), the exact name, names starting with
    the word — so the cost does not grow with every tag.
    Then tasks WHERE tag_ids @> ARRAY[...] (GIN).
  - By text: task.context and comment.value with ILIKE / similarity
    (trigrams work for any language and for substrings).


============================================================================
TASK IDENTIFIERS
============================================================================

  - task.id — SERIAL PRIMARY KEY, immutable. All FKs and URLs use it.
  - task.tag_ids — the set of tags, stored sorted (trigger).
    UNIQUE: two tasks with the same set of tags are impossible.
    On a conflict the application asks to add a tag.
  - Tags cannot be empty (at least one tag).
  - Duplicate tags are forbidden. All tags must exist.


============================================================================
AUTHENTICATION
============================================================================

  - The email token (token) is single-use and lives 10 minutes.
  - The session token (session) is long-lived: 30 days of inactivity.
  - The database stores only SHA-256 of the tokens. Tokens are 32 random
    bytes, so no salt is needed. A database leak (backup, replica,
    read-only SQL injection) does not let anyone sign in.
  - Issuing and checking tokens — functions issue_token, login,
    authenticate.
  - A sign-in link works only in the browser that asked for it: the
    request leaves a random key in that browser''s cookie, the token keeps
    its hash. A link opened anywhere else (a mail scanner following links,
    someone the email was forwarded to, the webhook''s receiver) signs
    nobody in and is not used up.


============================================================================
OPERATIONS
============================================================================
What the application must be able to do. No URLs — they are defined when
the API is implemented.

  Authentication:
    - With the company''s identity provider configured (OIDC), only through
      it: the provider''s answer -> sign_in_external(); someone it lets in
      for the first time confirms their email by a link opened in the same
      browser (begin_external_sign_in(), send_external_email(),
      confirm_external_email()); no sign-in links, no invites (people come
      in by signing in).
    - Otherwise: request sign-in by email -> a key for this browser''s
      cookie, issue_token(), send the link through the webhook directly
      (not through notification — the token must not lie in the database
      in plain text).
    - Follow the link from the email -> login() with the browser''s key,
      set the cookie.
    - Every request -> authenticate().
    - Log out -> deletes the session.
    - Log out everywhere -> deletes all sessions of the employee.

  Employees:
    - Invite an employee (any employee: email, full_name, locale)
      -> notify(kind = invite).
    - Edit the profile (full_name, about, next_day, time_zone, locale).
    - Change one''s email -> request_email_change(), the link goes by email
      to the new address only; following it -> confirm_email_change().

  Bots:
    - Create a bot (create_bot: any person, under themselves).
    - Change its name, pronoun, about, permissions, webhook (its direct
      manager, check_bot_manager).
    - Replace its key (reset_bot_key: its direct manager).
    - Hand it to another person (transfer_bot: its direct manager).
    - Dismiss / bring back — like anyone, by its direct manager.
    - Every API request with a key -> authenticate_bot().
    - Set / change manager_id (the employee themselves).
    - Dismiss an employee (dismiss_employee: the direct manager).
    - Bring a dismissed employee back (restore_employee: the direct manager).

  Visits:
    - Open a task / any other screen -> log_visit().

  Tasks:
    - Create a task (owner = creator, tags, priority).
    - Change tag_ids / priority / context (owner only).
    - "No intervention needed" (mark_reviewed: owner only): takes away
      the review notices up to the newest one shown (decision 94). Access
      requests are a group of their own and stay. It never closes the
      task.
    - Make public / private (make_public / make_private: owner only).
    - Transfer ownership (the owner or the owner''s manager).
    - Take an ownerless task (owner_id IS NULL, any observer).

  Access:
    - Add an observer or bring one back (add_observer: any participant).
    - Request access (request_access: the employee themselves).
    - Withdraw one''s own request (withdraw_access).
    - Approve a request (approve_access: the owner).
    - Reject a request (reject_access: the owner).
    - Remove an observer (remove_observer: the owner).
    - Leave a task (leave_task: the observer themselves, except the owner
      and the manager of an observing report).

  Dependencies:
    - Add a dependency — an existing task or one created with it (anyone
      who sees both tasks, the same from either side; the owners of both,
      other than whoever added it, are notified).
    - Set / change its latest deadline (owner of task_id only).
    - Remove a dependency (owner of task_id, or whoever added it).

  Deadlines:
    - Set / move finished_at (set_finished_at, owner only).
    - Clear finished_at (clear_finished_at, owner only).
    - Close a task (close_task: owner only, not while someone still has
      time planned on it): an open one is closed now, an overdue one at
      its passed deadline; the tasks waiting for it are done for from
      then on (dependency.done_at).
    - Take note that a task waited for is done (mark_reviewed of the
      waiting task, or close_task with it).

  Time left:
    - Set / change / clear estimate_minutes for oneself (anyone who sees
      the task).

  Time entries:
    - Set one''s time on a task in one of one''s shifts (anyone who sees
      the task): the shift''s whole time on it, replacing what was there;
      0 removes the entry.

  Timesheet:
    - Open a shift (started_at = NOW, spent_minutes = NULL).
    - Close a shift (spent_minutes = N, about = text), its start corrected.
    - Add a closed shift, correct one (times, about) or delete one —
      while it has no standing score; it may run past midnight.

  Comments:
    - Upload an attachment (deduplicated by hash; refused over the size
      and quota limits; the same bytes restore a purged one) -> attachment.id.
    - Keep a file one sees in a task (keep_attachment); let a file one
      holds go (release_attachment) — the last one to let it go deletes
      its content.
    - Leave a comment (with attachment_ids and image_ids) — anyone who
      sees the task.
    - Reply to a comment (reply_to_id).
    - Attach an employee -> mention.
    - Attach a task -> task_mention.

  Mentions:
    - Add a mention to one''s own comment later (created_at = NOW).
    - Delete a mention from one''s own comment until its first reaction.
    - Close a mention (closed_at = NOW, explicitly, by the mentioned
      employee): after a reply, or with "No reply needed".
    - "No intervention needed" on one''s own comment (review_comment):
      comment.reviewed_at goes to the newest reaction shown; the comment
      leaves Waiting for others until a new reaction (decision 98).

  Reminders:
    - Set a remind (an observer).
    - Move a remind to a later moment (its author): due again then.
    - Delete a remind (its author).

  Notifications:
    - Close a notification (closed_at = NOW).

  Scores:
    - Score an employee''s closed shifts or correct the score, withdraw it
      (the current manager; every version is notified to the employee).


============================================================================
ACCESS RULES
============================================================================

  Task:
    - priority, tag_ids, context — owner only.
    - reviewed_at — owner only.
    - owner_id — the current owner or the owner''s direct manager.
    - finished_at — owner only.
    - dependency — added by anyone who sees both task_id and value; latest_at
      by the owner of task_id only; removed by the owner of task_id or
      whoever added it (decision 94).

  Seeing a task (can_see):
    - The header (tag_ids, priority, finished_at, owner) — everyone.
    - The rest (context, comments, people, time) — the active observers
      of a private task; everyone for a public task.

  Observers:
    - Add or bring back an observer — any participant of a private task
      (like a copy in an email); remove — owner only.
    - Make the task public / private — owner only.
    - Any employee can request access to a private task.
    - Approve / reject a request — owner only.
    - Leave a task — the observer themselves. The owner cannot leave.
    - A manager cannot be removed (and cannot leave) while a report of
      theirs (recursively) observes the task.

  Time left and time entries:
    - estimate_minutes — anyone who sees the task, for themselves only.
    - spent_minutes — anyone who sees the task, for themselves only.
    - remind — anyone who sees the task, for themselves only.
    - work — the employee themselves (their own shift).

  Comments:
    - Leave a comment — anyone who sees the task.
    - Attach an employee or a task — anyone who sees the task; to a
      comment already left — its author only.
    - Delete a mention — the comment''s author, until the first reaction.
    - Close a mention — the mentioned employee; review the comment''s
      reactions (reviewed_at) — the comment''s author.
    - A private task: only an active observer can be attached (mentioned).
      A public task: any active employee can be attached.

  Scores:
    - score — only the current manager (employee.manager_id).

  Bots:
    - Create — any person, under themselves.
    - Change, replace the key, hand over, dismiss, bring back — its
      direct manager only.
    - What it may change — its permissions (bot_permission), checked by
      the application; never more than its relationships allow.

  Employees:
    - Invite — any employee.
    - manager_id — the employee themselves (own profile). No confirmation
      from the manager: such a substitution is too noticeable.
    - Dismiss / bring back — the direct manager only. An employee with no
      manager cannot be dismissed (nobody dismisses themselves); a
      dismissed one always has a manager, and only that manager brings
      them back — under themselves: the employee then moves to another
      manager on their own.
    - Managers may form a ring (decision 90): directors who pick each
      other see all of each other''s tasks, like any manager. Rights stay
      with the direct manager: in a ring each dismisses and scores the
      one who picked them.
    - Someone at the top leaves in two steps of their own people: the
      leaver picks the successor as manager, the successor dismisses
      them (a successor among the leaver''s direct reports is left without
      a manager).
      Someone who will not: the installation administrator dismisses them
      with an heir (dismiss_with_heir, server/admin.ts) — outside the API.
    - Setting a manager notifies the new manager (new_report).


============================================================================
INVARIANTS (forbidden; all checked in the database)
============================================================================

  Task:
    - Empty tag_ids, NULL inside, duplicates, unknown tags.
    - Two tasks with the same set of tags.
    - Deleting a task.
    - The owner of a private task who is not an observer.

  Mentions:
    - Deleting a mention after its first reaction (a reply or the closing).
    - Changing a comment, except its author''s reviewed_at.

  Tags:
    - Deleting a tag that is in use.
    - A name with capital letters or surrounding spaces.

  Dependencies:
    - Self-dependency (task_id = value).
    - A cycle (A -> B -> A).

  Observers:
    - Two open rows (task_id, value): request + access, two requests,
      two accesses.
    - An active observer whose manager is not an observer.
    - Closing a manager''s access while a report of theirs observes the task.

  Mentions:
    - Self-mention.
    - Mentioning a dismissed employee.
    - A comment attaching its own task.

  Hierarchy:
    - An employee being their own manager.

  Timesheet:
    - Overlapping shifts of one employee (including two open ones).
    - A shift longer than 24 hours; spent_minutes <= 0.
    - A shift that starts in the future or ends after the current minute.
    - Changing or deleting a scored shift.
    - A shift shorter than the time logged in it; deleting a shift with
      time logged in it; changing a shift''s number.

  Time entries:
    - An entry by someone who does not see the task, in a shift not
      their own, in a scored shift.
    - More logged in a shift, all tasks together, than it lasts (an open
      one: than since it began).
    - Two entries of one person for one task and shift.
    - Moving an entry to another task, person or shift.

  Deadlines:
    - finished_at.value IS NULL (clearing = closing the row without a new one).

  Scores:
    - A score not by the current manager.
    - Scoring an open shift.
    - A score changed by anyone but the current manager; deleting a
      standing score; moving a score to another shift.

  Comments:
    - Changing or deleting a comment.
    - A comment by someone who does not see the task.
    - attachment_ids / image_ids with duplicates or unknown attachments.
    - Deleting an attachment referenced by a comment or a task context.
    - reply_to_id pointing to a missing comment of the same task.

  Employees:
    - Deleting an employee (dismissal only).
    - An employee without the row of its kind, or with both (human, bot).
    - A bot with an email, without a manager, or managing anyone.
    - A bot with a timesheet, time entries, estimates, scores, reminders,
      visits, sessions or tag settings (they refer to human).


============================================================================
WHAT THE APPLICATION DOES ITSELF (not in the database)
============================================================================

  - Permission checks "owner only" / "manager only" for task operations
    (priority, tag_ids, context, owner_id, finished_at, dependency).
  - The "for oneself" check for estimate_minutes and remind.
  - Sanitizing the HTML of comment.value and task.context (an allow-list
    of tags; images only from the application''s own attachments) and
    filling comment.image_ids / task.context_image_ids from it.
  - Creating notifications through notify(): comment, mention, task
    attachment, owner change, score. Database functions create the rest.
  - Protection against accidental comment sending: after "Send" the
    comment stays in the interface for a few seconds with a "Back to
    editing" button and only then goes to the server.
  - Attachment deduplication: on upload, look for an attachment with the
    same hash and size and compare the bytes (or take one whose content
    was deleted); on a match return the existing id. The file name is stored in the comment
    (attachment_names), not in the attachment.
  - Notification delivery: the worker reads notification WHERE sent_at
    IS NULL (a finished_at_change only once deadline_settles() has
    passed since it was added), sends an email in the recipient''s language (SMTP from the
    config) and/or posts it to the webhook (URL and secret in the config,
    body signed with HMAC-SHA256), then sets sent_at = NOW().
  - The close_delay metric (delay in closing a shift) — on the frontend.
  - Rate limiting of issue_token: 5 links per employee in 15 minutes.


============================================================================
CRON JOBS (outside SQL)
============================================================================

  - every minute: SELECT send_due_reminds();
  - every hour:   DELETE FROM token
                   WHERE sent_at < NOW() - CASE WHEN email IS NULL THEN INTERVAL ''1 hour''
                                                ELSE INTERVAL ''2 days'' END;
  - every hour:   DELETE FROM external_sign_in WHERE created_at < NOW() - INTERVAL ''1 hour'';
  - every hour:   SELECT send_weekly_digests();
  - every day:    DELETE FROM session WHERE last_seen_at < NOW() - INTERVAL ''30 days'';
  - every day:    DELETE FROM notification WHERE added_at < NOW() - INTERVAL ''1 year'';
  - every day:    DELETE FROM attachment a
                   WHERE used_at < NOW() - INTERVAL ''1 day''
                     AND NOT attachment_in_use(a.id);
  - every day:    DELETE FROM visit WHERE at < NOW() - INTERVAL ''1 year'';
  - every day:    DELETE FROM bot_usage WHERE day < CURRENT_DATE - 366;
  - every hour:   ask the identity provider about people last checked a
                  day ago or more (human.idp_refresh_token); a refusal ->
                  SELECT idp_refused(employee_id).
  - every day:    SELECT send_bot_key_reminders();
  - every day:    DELETE FROM tag t
                   WHERE created_at < NOW() - INTERVAL ''1 day''
                     AND NOT EXISTS (SELECT 1 FROM task WHERE tag_ids @> ARRAY[t.id])
                     AND NOT EXISTS (SELECT 1 FROM user_tag WHERE tag_id = t.id);
  - every day:    UPDATE human SET next_day = NULL
                   WHERE next_day <= local_today(employee_id);
';


-- ============================================================================
-- Helper functions needed before the tables
-- ============================================================================
CREATE OR REPLACE FUNCTION is_int_set(p_values INT[])
RETURNS BOOLEAN AS $$
    SELECT COALESCE(
        cardinality(p_values) > 0
        AND array_ndims(p_values) = 1
        AND array_position(p_values, NULL) IS NULL
        AND cardinality(p_values) = (SELECT COUNT(DISTINCT x) FROM unnest(p_values) AS x),
        FALSE)
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION is_int_set(INT[]) IS
'TRUE if the array is one-dimensional, non-empty, without NULLs and duplicates.
Used in CHECK (a subquery directly in CHECK is not allowed).';


CREATE OR REPLACE FUNCTION work_period(p_started_at TIMESTAMPTZ, p_minutes INT)
RETURNS TSTZRANGE AS $$
    SELECT tstzrange(p_started_at, p_started_at + p_minutes * INTERVAL '1 minute')
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION work_period(TIMESTAMPTZ, INT) IS
'Shift interval. p_minutes IS NULL -> open interval up to infinity.
Marked IMMUTABLE: adding minutes to a timestamptz does not depend on the
time zone (only days and months do).';


-- ============================================================================
-- 1. employee
-- ============================================================================
CREATE TYPE keyboard AS ENUM ('en', 'ru', 'uk', 'be');

COMMENT ON TYPE keyboard IS
'A keyboard layout someone types with (human.keyboards). The keys of
each are a table in the application (shared/keyboards.ts); a new layout
is a value here and a line there.';

CREATE TYPE employee_kind AS ENUM ('human', 'bot');

COMMENT ON TYPE employee_kind IS
'What an employee is: a person (human) or a program acting through the
API (bot). Each has a row of its own kind in human or bot.';

CREATE TABLE employee (
    id SERIAL PRIMARY KEY,
    kind employee_kind NOT NULL DEFAULT 'human',
    email CITEXT,
    full_name VARCHAR(255) NOT NULL,
    about TEXT,
    manager_id INT,
    time_zone TEXT NOT NULL DEFAULT 'UTC',
    locale VARCHAR(10) NOT NULL DEFAULT 'ru' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    pronoun VARCHAR(3) CHECK (pronoun IN ('he', 'she')),
    dismissed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_employee_kind
        UNIQUE (id, kind),
    CONSTRAINT chk_employee_manager_not_self
        CHECK (manager_id <> id),
    CONSTRAINT chk_employee_dismissed_manager
        CHECK (dismissed_at IS NULL OR manager_id IS NOT NULL),
    CONSTRAINT chk_employee_bot_email
        CHECK (kind = 'human' OR email IS NULL),
    CONSTRAINT chk_employee_bot_manager
        CHECK (kind = 'human' OR manager_id IS NOT NULL),
    CONSTRAINT chk_employee_time_zone
        CHECK ((TIMESTAMPTZ '2000-01-01 00:00Z' AT TIME ZONE time_zone) IS NOT NULL)
);
CREATE INDEX idx_employee_manager ON employee(manager_id);
CREATE UNIQUE INDEX uq_employee_email ON employee(email) WHERE dismissed_at IS NULL;

COMMENT ON TABLE employee IS
'An employee. The account: what a person (kind human) and a bot (kind bot)
have in common — a name, a manager, tasks, comments, mentions,
notifications. What only one kind has lives in human or bot, and tables
only a person has rows in (timesheet, time entries, scores, sessions,
reminders, visits) refer to human, so a bot cannot have them.
Only another employee can create one (an invite of a person, checked by
the application; a bot with create_bot()). The application creates the
first employee on its first start (from .env); the installation''s
administrator may add people outside the API. Whoever comes without an
invite is greeted (notify(), kind welcome).
Dismissal sets dismissed_at: records are kept, signing in is impossible.
The email stays, so bringing the employee back needs nothing typed again.
An employee cannot be deleted (trigger).

manager_id — the direct manager. One field, no history.
Changing the manager is a plain UPDATE (by the employee). The new manager
is automatically added to all of the employee''s tasks. The old one stays.
Managers may form a ring (A -> B -> A, decision 90). Only a person manages
(manager_id refers to human); a bot always has a manager.

time_zone — the employee''s time zone. It defines day boundaries for the
timesheet, time entries and scores.';

COMMENT ON COLUMN employee.id IS
'Employee id.';

COMMENT ON COLUMN employee.kind IS
'human — a person; bot — a program acting through the API with its key.
Never changes: a mistake is fixed by dismissing one and creating the other.';

COMMENT ON COLUMN employee.email IS
'CITEXT, case-insensitive. One working account per email
(uq_employee_email); a dismissed employee keeps theirs, and someone new
may get the same address.
NULL — no address: no emails and no sign-in link; the bell still works.
A bot never has one (chk_employee_bot_email).
Whether the employee works is dismissed_at, never the email.
The employee may change it in the profile (the next sign-in link goes
to the new address).';

COMMENT ON COLUMN employee.full_name IS
'Display name. Filled by the inviter on invite.';

COMMENT ON COLUMN employee.about IS
'Free text about the employee: position, how to reach me, anything
colleagues should know. Filled by the employee.';

COMMENT ON COLUMN employee.manager_id IS
'The direct manager — always a person. One field, no history.
The current manager scores the day.
A ring (A -> B -> A) is allowed (decision 90): its people see each
other''s tasks, and each dismisses and scores the one who picked them.
A person picks their own; a bot''s is whoever created it or got it
handed over (transfer_bot()).';

COMMENT ON COLUMN employee.created_at IS
'When the employee was invited (or created on the first start). My team
does not show them for a range that ended before.';

COMMENT ON COLUMN employee.dismissed_at IS
'When the employee was dismissed (dismiss_employee); NULL — working.
Cleared when they come back. A dismissed employee cannot sign in and gets
no notifications. My team
shows a dismissed employee only for ranges they worked in: dismissed on
or after the range''s first day.';

COMMENT ON COLUMN employee.locale IS
'Language of the interface and notifications (ru, en, pt-BR, ...).
Sent to the webhook with every notification. A bot gets its creator''s:
the language its program is expected to write in.';

COMMENT ON COLUMN employee.pronoun IS
'How to speak of the employee: he | she — a bot too, named as its team
likes. Picks verb forms in languages that have them ("упомянул" /
"упомянула"). NULL — not given: the neutral form with both endings.';

COMMENT ON COLUMN employee.time_zone IS
'IANA time zone (Europe/Moscow). Defines the employee''s day boundaries.
Changing it shifts past day boundaries — do it rarely.';

COMMENT ON CONSTRAINT chk_employee_manager_not_self ON employee IS
'An employee cannot be their own manager.';

COMMENT ON CONSTRAINT chk_employee_dismissed_manager ON employee IS
'A dismissed employee always has a manager — the one who can bring them
back. Someone without a manager cannot be dismissed (they first pick a
manager — their successor, once that one stepped out from under them),
and a dismissed manager''s reports,
dismissed ones included, move to the manager above.';

COMMENT ON INDEX uq_employee_email IS
'One working employee per email. Dismissed ones keep their address
without holding it. The email lives here, not in human, because the
uniqueness needs it next to dismissed_at.';

COMMENT ON CONSTRAINT uq_employee_kind ON employee IS
'The target of the (employee_id, kind) foreign keys of human and bot:
a row there matches the kind here, so nobody is both.';

COMMENT ON CONSTRAINT chk_employee_bot_email ON employee IS
'A bot has no email: it neither signs in nor gets mail.';

COMMENT ON CONSTRAINT chk_employee_bot_manager ON employee IS
'A bot always has a manager: the one who sets it up and answers for it.';


-- ----------------------------------------------------------------------------
-- human — what only a person has
-- ----------------------------------------------------------------------------
CREATE TABLE human (
    employee_id INT PRIMARY KEY,
    kind employee_kind NOT NULL DEFAULT 'human' CHECK (kind = 'human'),
    next_day DATE,
    keyboards keyboard[],
    weekly_digest_on DATE,
    outside_domains_told_at TIMESTAMPTZ,
    external_id TEXT UNIQUE,
    idp_refresh_token TEXT,
    idp_checked_at TIMESTAMPTZ,
    idp_blocked_at TIMESTAMPTZ,
    FOREIGN KEY (employee_id, kind) REFERENCES employee(id, kind)
);

ALTER TABLE employee ADD CONSTRAINT employee_manager_id_fkey
    FOREIGN KEY (manager_id) REFERENCES human(employee_id);

COMMENT ON TABLE human IS
'A person: an employee of kind human. Signs in, keeps a timesheet, logs
time, is scored, manages; those tables refer here. Created with the
employee row, in the same transaction (employee_kind_row).';

COMMENT ON COLUMN human.employee_id IS
'The employee.';

COMMENT ON COLUMN human.kind IS
'Always human: with employee_id, the foreign key to employee(id, kind).';

COMMENT ON COLUMN human.next_day IS
'When the person is back at work after an absence (vacation, sick
leave, a day off). NULL or a past date = available (cron clears past
dates). A future date = away: notifications go both to them and to their
manager (recursively up manager_id until an available one is found).';

COMMENT ON COLUMN human.keyboards IS
'Keyboard layouts the person switches between (en, ru, ...), for text
typed with the wrong one: the tag search reads the same keys with each
other layout. NULL — not chosen: the layout of the interface language and
the US one.';

COMMENT ON COLUMN human.weekly_digest_on IS
'The Monday the weekly email for managers last went out (or was due
with nothing to say), in their time zone: it goes once a week.';

COMMENT ON COLUMN human.outside_domains_told_at IS
'When the person was last emailed that their address is outside the
company''s mail domains (EMAIL_DOMAINS in the configuration — the
database does not know them). Until they change it their notifications
reach the bell and the webhook, and their mail gets only this request,
at most once a day.';

COMMENT ON COLUMN human.external_id IS
'Who the person is at the company''s identity provider (the OIDC sub):
sign-in through it finds them by this, whatever their email is there.
Set on their first sign-in through it, once they confirmed their email
(confirm_external_email()).';

COMMENT ON COLUMN human.idp_refresh_token IS
'The provider''s refresh token from their last sign-in, to ask it every
day whether they may still sign in (the idp_check cron). Useless
without the client secret, which only the configuration holds.';

COMMENT ON COLUMN human.idp_checked_at IS
'When the provider last said they may sign in (a sign-in or a check).';

COMMENT ON COLUMN human.idp_blocked_at IS
'When the provider refused them (idp_refused()): their sessions ended,
their bots stopped, sign-in links are refused too. Not a dismissal: their
tasks and people stay until their manager dismisses them. Cleared by their
next sign-in through the provider.';


-- ----------------------------------------------------------------------------
-- bot — a program acting through the API
-- ----------------------------------------------------------------------------
CREATE TYPE bot_permission AS ENUM ('task', 'task.transfer', 'comment', 'observers');

COMMENT ON TYPE bot_permission IS
'What a bot may change, on top of reading what its relationships show it:
  task          — create tasks and run its own (tags, priority, context,
                  deadline, dependencies, public or private, reviewed);
  task.transfer — hand its own tasks to someone;
  comment       — comment and close its mentions;
  observers     — bring people into tasks it takes part in, run the
                  observers of its own tasks, request access.
Checked by the application. Never: timesheet, time, scores, people, keys.';

CREATE TABLE bot (
    employee_id INT PRIMARY KEY,
    kind employee_kind NOT NULL DEFAULT 'bot' CHECK (kind = 'bot'),
    key_hash BYTEA NOT NULL UNIQUE,
    key_issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    permissions bot_permission[] NOT NULL DEFAULT '{}',
    webhook_url TEXT CHECK (webhook_url ~ '^https?://'),
    webhook_secret TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    key_reminded_at TIMESTAMPTZ,
    FOREIGN KEY (employee_id, kind) REFERENCES employee(id, kind)
);

COMMENT ON TABLE bot IS
'A bot: an employee of kind bot — CI, monitoring — that comments, owns
tasks and is mentioned like a person, through the API with its key
(Authorization: Bearer). It never signs in and keeps no timesheet.
Anyone creates one under themselves (create_bot()); only its direct
manager changes it, resets its key or hands it to someone
(transfer_bot()). Its notifications go to its own webhook, as JSON.';

COMMENT ON COLUMN bot.employee_id IS
'The employee.';

COMMENT ON COLUMN bot.kind IS
'Always bot: with employee_id, the foreign key to employee(id, kind).';

COMMENT ON COLUMN bot.key_hash IS
'SHA-256 of the key. One key, without expiry: the manager replaces it
when they want (reset_bot_key(); the key is shown once). A handover and
the dismissal of its manager replace it with one nobody knows: the
previous manager knew the old one.';

COMMENT ON COLUMN bot.key_issued_at IS
'When the key was issued or replaced.';

COMMENT ON COLUMN bot.permissions IS
'What it may change (bot_permission); empty — read only.';

COMMENT ON COLUMN bot.webhook_url IS
'Where its notifications go, as JSON signed with webhook_secret.
NULL — nowhere: they stay in its bell.';

COMMENT ON COLUMN bot.webhook_secret IS
'The HMAC-SHA256 key that signs its webhook bodies. Its own, so one bot
cannot forge another''s messages; kept in the clear, the server signs with it.';

COMMENT ON COLUMN bot.key_reminded_at IS
'When its manager was last told the key is a year old or more
(send_bot_key_reminders()): once a year of the key''s age. The key keeps
working; replacing it starts the count again.';


-- ----------------------------------------------------------------------------
-- bot_usage — how a bot used the API, by day
-- ----------------------------------------------------------------------------
CREATE TABLE bot_usage (
    bot_id INT NOT NULL REFERENCES bot(employee_id),
    day DATE NOT NULL,
    requests INT NOT NULL DEFAULT 0 CHECK (requests >= 0),
    refused INT NOT NULL DEFAULT 0 CHECK (refused >= 0),
    deliveries INT NOT NULL DEFAULT 0 CHECK (deliveries >= 0),
    failed_deliveries INT NOT NULL DEFAULT 0 CHECK (failed_deliveries >= 0),
    last_request_at TIMESTAMPTZ,
    PRIMARY KEY (bot_id, day)
);

COMMENT ON TABLE bot_usage IS
'A bot''s activity by day (in its time zone), for Bots under My team: a
row only for a day with activity. Requests are counted after each API
call, outside its transaction, so a refused one counts too
(count_bot_request()); deliveries — after each attempt at its webhook
(count_bot_delivery()). Cron deletes rows older than a year.';

COMMENT ON COLUMN bot_usage.requests IS
'API calls made with its key that day.';

COMMENT ON COLUMN bot_usage.refused IS
'Of them, refused for lack of permission or access (bot_not_permitted,
forbidden, no_access, not_manager): a bot knocking where it may not is
set up wrong, or broken.';

COMMENT ON COLUMN bot_usage.deliveries IS
'Notifications posted to its webhook that day.';

COMMENT ON COLUMN bot_usage.failed_deliveries IS
'Of them, failed: its webhook is down or answers with an error.';

COMMENT ON COLUMN bot_usage.last_request_at IS
'The last API call that day.';


CREATE OR REPLACE FUNCTION local_today(p_employee_id INT)
RETURNS DATE AS $$
    SELECT (NOW() AT TIME ZONE time_zone)::date FROM employee WHERE id = p_employee_id
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION local_today(INT) IS
'Today''s date in the employee''s time zone.';


CREATE OR REPLACE FUNCTION local_day(p_employee_id INT, p_at TIMESTAMPTZ)
RETURNS DATE AS $$
    SELECT (p_at AT TIME ZONE time_zone)::date FROM employee WHERE id = p_employee_id
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION local_day(INT, TIMESTAMPTZ) IS
'The day the moment p_at falls on in the employee''s time zone.';


CREATE OR REPLACE FUNCTION subordinates(p_manager_id INT)
RETURNS SETOF INT AS $$
    WITH RECURSIVE tree AS (
        SELECT id FROM employee WHERE manager_id = p_manager_id
        UNION
        SELECT e.id FROM employee e JOIN tree t ON e.manager_id = t.id
    )
    SELECT id FROM tree WHERE id <> p_manager_id
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION subordinates(INT) IS
'All reports, recursively. For the "reports'' tasks" section:
SELECT * FROM task WHERE owner_id IN (SELECT subordinates(:me)).
Never the manager themselves: in a ring of managers (decision 90) the
others of the ring are their reports, they are not their own.';


-- ============================================================================
-- 1a. avatar
-- ============================================================================
CREATE TABLE avatar (
    employee_id INT PRIMARY KEY REFERENCES employee(id),
    value BYTEA NOT NULL,
    mime VARCHAR(50) NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE avatar IS
'Employee avatar, stored as BYTEA.
One avatar per employee (PK = employee_id). Set and deleted only by the
employee themselves; seen by every employee. The client crops it to a
square and scales it down before uploading; without one the interface
shows the initials.';

COMMENT ON COLUMN avatar.employee_id IS
'PK. One avatar per employee.';

COMMENT ON COLUMN avatar.value IS
'Image bytes.';

COMMENT ON COLUMN avatar.mime IS
'MIME type: image/png, image/jpeg or image/webp (never SVG — it can carry scripts).';

COMMENT ON COLUMN avatar.updated_at IS
'When it was last replaced: part of its URL, so browsers may cache it.';


-- ============================================================================
-- 2. auth
-- ============================================================================
CREATE TABLE token (
    hash BYTEA PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES human(employee_id),
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    email CITEXT,
    browser BYTEA,

    CONSTRAINT chk_token_browser CHECK ((email IS NULL) = (browser IS NOT NULL))
);
CREATE INDEX idx_token_employee ON token(employee_id);
CREATE INDEX idx_token_sent_at ON token(sent_at);

COMMENT ON TABLE token IS
'Single-use tokens sent by email. Only the SHA-256 of the token is stored.
  - Sign-in (email IS NULL): issued by issue_token(), redeemed by login(),
    valid for 10 minutes; cron removes unused ones after an hour.
  - Confirming a new email (email = the new address): issued by
    request_email_change(), sent to that address and redeemed by
    confirm_email_change(), valid for a day; cron removes unused ones
    after two. Following it proves the mailbox is the person''s.';

COMMENT ON COLUMN token.hash IS
'SHA-256 of the token from the email. The token itself is not stored.';

COMMENT ON COLUMN token.employee_id IS
'Whom the token belongs to.';

COMMENT ON COLUMN token.sent_at IS
'When the token was issued. A sign-in token is valid for 10 minutes, an
email one for a day.';

COMMENT ON COLUMN token.email IS
'The new address an email-change token confirms; NULL — a sign-in token.';

COMMENT ON COLUMN token.browser IS
'SHA-256 of the key the browser that asked for a sign-in link keeps in its
cookie: login() signs in only there. NULL for an email-change token: it
signs nobody in, so any browser may follow it.';

COMMENT ON CONSTRAINT chk_token_browser ON token IS
'A sign-in token is always bound to a browser, an email-change token never.';

COMMENT ON INDEX idx_token_sent_at IS
'For the cron cleanup of old tokens.';


CREATE TABLE session (
    hash BYTEA PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES human(employee_id),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_session_employee ON session(employee_id);
CREATE INDEX idx_session_last_seen ON session(last_seen_at);

COMMENT ON TABLE session IS
'Live cookies. Created by start_session() (a sign-in link or the
identity provider), checked by authenticate().
Signing in by email, the TTL is by inactivity: cron deletes sessions not
seen for > 30 days, and an active user is never logged out. Signing in
through the company''s identity provider, a session lasts a day from
sign-in, active or not: someone the provider stops letting in is out by
the next day (authenticate(p_lifetime)).
Logout — DELETE. "Log out everywhere" — DELETE WHERE employee_id = ?.
Dismissal deletes all sessions of the employee.';

COMMENT ON COLUMN session.hash IS
'SHA-256 of the cookie token. The token itself lives only in the cookie.';

COMMENT ON COLUMN session.employee_id IS
'Whose session.';

COMMENT ON COLUMN session.created_at IS
'When the person signed in: with the identity provider, the session
ends a day later.';

COMMENT ON COLUMN session.last_seen_at IS
'Moment of the last activity.
Updated by authenticate() when older than 5 minutes.
Cron deletes sessions where last_seen_at < NOW() - INTERVAL ''30 days''.';


CREATE TABLE external_sign_in (
    hash BYTEA PRIMARY KEY,
    sub TEXT NOT NULL,
    suggested_email CITEXT,
    full_name VARCHAR(255) NOT NULL,
    locale VARCHAR(10) NOT NULL,
    time_zone TEXT NOT NULL,
    refresh_token TEXT,
    email CITEXT,
    email_hash BYTEA UNIQUE,
    sends INT NOT NULL DEFAULT 0,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_external_sign_in_created_at ON external_sign_in(created_at);
CREATE INDEX idx_external_sign_in_email ON external_sign_in(email, sent_at);

COMMENT ON TABLE external_sign_in IS
'A first sign-in through the company''s identity provider that vouched
for no address, waiting for the person to confirm their email (decision
86): the email says which employee they are here, as without the
provider, so someone added before by their address is found by it. The
provider''s address, if any, is only offered.
  1. sign_in_external() did not know them: begin_external_sign_in()
     keeps what it said and gives the browser a token (a cookie).
  2. They type their email: send_external_email() issues the token of a
     link to it.
  3. They open the link in the same browser: confirm_external_email()
     finds the working employee with that email or creates one, binds the
     provider id to them and starts a session.
Only SHA-256 of both tokens is stored. Valid for an hour from step 1;
cron removes older rows. The browser token keeps a link forwarded to
someone else from binding their account to the provider account of
whoever asked.';

COMMENT ON COLUMN external_sign_in.hash IS
'SHA-256 of the browser''s token (the cookie).';

COMMENT ON COLUMN external_sign_in.sub IS
'Who the person is at the provider (the OIDC sub).';

COMMENT ON COLUMN external_sign_in.suggested_email IS
'The address the provider sent, if any: offered, never trusted.';

COMMENT ON COLUMN external_sign_in.full_name IS
'The name the provider sent: given to the employee if one is created.';

COMMENT ON COLUMN external_sign_in.locale IS
'The language the provider sent (or the installation''s): of the email
with the link, and of the employee if one is created.';

COMMENT ON COLUMN external_sign_in.time_zone IS
'The time zone the provider sent (or the installation''s), for a new employee.';

COMMENT ON COLUMN external_sign_in.refresh_token IS
'The provider''s refresh token, moved to human.idp_refresh_token on
confirmation.';

COMMENT ON COLUMN external_sign_in.email IS
'The address the last link went to. NULL — none sent yet.';

COMMENT ON COLUMN external_sign_in.email_hash IS
'SHA-256 of the token in the last link; a new link voids the previous one.';

COMMENT ON COLUMN external_sign_in.sends IS
'How many links this sign-in sent: at most 5.';

COMMENT ON COLUMN external_sign_in.sent_at IS
'When the last link went out.';

COMMENT ON COLUMN external_sign_in.created_at IS
'When the provider let them in: valid for an hour from then.';




-- ============================================================================
-- 3. tag / user_tag
-- ============================================================================
CREATE OR REPLACE FUNCTION translit(p_text TEXT)
RETURNS TEXT AS $$
    SELECT translate(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(
            p_text, 'щ', 'sch'), 'ш', 'sh'), 'ч', 'ch'), 'ц', 'ts'), 'ж', 'zh'),
            'ю', 'yu'), 'я', 'ya'), 'ъ', ''), 'ь', ''),
        'абвгдеёзийклмнопрстуфхыэәғқңөұүһі',
        'abvgdeeziyklmnoprstufhyeagknouuhi')
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION translit(TEXT) IS
'Lower-case Russian and Kazakh letters in Latin, the way people type them
(х -> h, щ -> sch, й -> y); everything else stays. Used for tag.latin
and for the typed text, so "sklad" finds "склад". Another alphabet the
company writes tags in is one more line here.';

CREATE TABLE tag (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    latin TEXT GENERATED ALWAYS AS (translit(name)) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_tag_name
        CHECK (name = lower(name) AND name = btrim(name) AND name <> '')
);
CREATE INDEX idx_tag_name_trgm ON tag USING GIN (name gin_trgm_ops);
CREATE INDEX idx_tag_latin_trgm ON tag USING GIN (latin gin_trgm_ops);
-- KNN: the nearest tags to what is typed (ORDER BY latin <-> ...), for suggestions.
CREATE INDEX idx_tag_latin_trgm_knn ON tag USING GIST (latin gist_trgm_ops);

COMMENT ON TABLE tag IS
'A tag. Name only. Color and weight are personal settings (user_tag).
Tags are stored in task.tag_ids as a sorted array.
A tag in use cannot be deleted (trigger).
A tag is created only with a task, when the task is saved with a name no
tag has. Cron deletes, once a day, tags no task carries any more (the
owner changed the title) and nobody gave a color or a weight, created
more than a day ago: abandoned spellings would otherwise crowd the
suggestions.';

COMMENT ON COLUMN tag.id IS
'Tag id.';

COMMENT ON COLUMN tag.name IS
'Unique tag name, lower case only: "Склад" and "склад" are one tag.
The application lowers the case before it gets here (lower() depends on
the database locale; under C it leaves Cyrillic as is).';

COMMENT ON COLUMN tag.created_at IS
'When the tag was created; the cron cleanup spares new tags for a day.';

COMMENT ON COLUMN tag.latin IS
'The name in Latin letters (translit()): fuzzy search compares the typed
text with it, see SEARCH.';

COMMENT ON CONSTRAINT chk_tag_name ON tag IS
'Lower case, no surrounding spaces, not empty.';


CREATE TABLE user_tag (
    employee_id INT NOT NULL REFERENCES human(employee_id),
    tag_id INT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    color VARCHAR(7) CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    weight INT NOT NULL DEFAULT 0,
    PRIMARY KEY (employee_id, tag_id)
);

COMMENT ON TABLE user_tag IS
'Personal tag settings of an employee: color and weight.
No row — the default color and weight 0.
The weight orders tags when a task "title" is shown: see ordered_tags().';

COMMENT ON COLUMN user_tag.employee_id IS
'Whose settings.';

COMMENT ON COLUMN user_tag.tag_id IS
'Which tag.';

COMMENT ON COLUMN user_tag.color IS
'Hex color code (#RRGGBB). NULL — the default color (decided by the frontend).';

COMMENT ON COLUMN user_tag.weight IS
'Display weight: a heavier tag is shown earlier in a task "title".
Ties are broken by how many visible tasks of the employee carry the tag.';


-- ============================================================================
-- 4. task — a thin entity
-- ============================================================================
CREATE TYPE priority AS ENUM ('LOW','NORMAL','HIGH','CRITICAL');

COMMENT ON TYPE priority IS
'Task priority. LOW / NORMAL / HIGH / CRITICAL.
Visible to everyone, changed only by the task owner.';


CREATE TABLE task (
    id SERIAL PRIMARY KEY,
    owner_id INT REFERENCES employee(id),

    tag_ids INT[] NOT NULL,
    priority priority NOT NULL DEFAULT 'NORMAL',

    context TEXT,
    context_image_ids INT[] NOT NULL DEFAULT '{}',
    reviewed_at TIMESTAMPTZ,
    handed_at TIMESTAMPTZ,

    CONSTRAINT chk_task_tag_ids_set
        CHECK (is_int_set(tag_ids)),
    CONSTRAINT chk_task_context_image_ids
        CHECK (cardinality(context_image_ids) = 0 OR is_int_set(context_image_ids)),
    CONSTRAINT uq_task_tag_ids
        UNIQUE (tag_ids)
);
CREATE INDEX idx_task_owner ON task(owner_id);
CREATE INDEX idx_task_tag_ids ON task USING GIN (tag_ids);
CREATE INDEX idx_task_context_trgm ON task USING GIN (context gin_trgm_ops);
CREATE INDEX idx_task_context_image_ids ON task USING GIN (context_image_ids);

COMMENT ON TABLE task IS
'A task — only "what this entity is".

id — SERIAL, immutable PK. All FKs and URLs use it.

tag_ids — the set of tags, which is also the task "title". Stored sorted
(trigger), so UNIQUE (tag_ids) forbids two tasks with the same set. An
empty set, duplicates and unknown tags are forbidden.

owner_id — the current owner, responsible for getting it done on time and
well thought out. Always an observer of a private task (trigger). May be
NULL — an ownerless task (after the owner was dismissed with no manager).

PUBLIC AND PRIVATE: a task with active observers is private, one without
them is public (see is_public(), can_see()). A new task is private: its
owner becomes its first observer.

tag_ids, priority and the deadline are the header, visible to every
employee. context is visible to those who see the task. All of them are
changed only by the owner.

reviewed_at — when the owner last confirmed that nothing in the task
waits for their decision ("No intervention needed", mark_reviewed()).
Not a read receipt. What came after it is the review in the owner''s
"Waiting for me" (decision 94). Reset to NULL when the owner changes,
handed_at set (trigger).

A task cannot be deleted (trigger). A task is closed by its owner
(close_task(), finished_at.confirmed_at). A closed task can be commented on, have time
logged, have its tags changed — just like an open one. "When it was
created" is not stored — it is not a metric, to avoid gaming lead time.';

COMMENT ON COLUMN task.id IS
'SERIAL PRIMARY KEY. Immutable. All FKs and URLs use it.';

COMMENT ON COLUMN task.owner_id IS
'The current task owner, responsible for the result. Always an observer
of a private task.
May be NULL: an ownerless task. Then the first observer to take it
becomes the owner.
Ownership is transferred by the current owner or the owner''s direct
manager. The previous owner stays an observer.
On transfer reviewed_at is reset to NULL and handed_at set.';

COMMENT ON COLUMN task.tag_ids IS
'Sorted set of tag ids. Unique among tasks.
Changed only by the owner. Non-empty, no duplicates, tags exist.';

COMMENT ON COLUMN task.priority IS
'Priority. Visible to every employee, changed only by the owner. Default NORMAL.';

COMMENT ON COLUMN task.context IS
'Task description from the owner''s point of view: sanitized HTML (see
WHAT THE APPLICATION DOES ITSELF). Visible to those who see the task,
changed only by the owner. Keeps no history: why it changed is said in
the comments.';

COMMENT ON COLUMN task.context_image_ids IS
'Attachments shown as images inside context. Filled by the application
from the HTML; keeps them from the attachment cleanup.';

COMMENT ON COLUMN task.reviewed_at IS
'When the owner last confirmed that nothing in the task waits for their
decision: the moment of the newest notice they were shown, never later
(decision 94). Updated only by mark_reviewed(); never moves back.
The review notices are what came after it: comments by others,
dependencies added by others on either side, dependencies done, the
deadline a day ahead. Handed over and not accepted yet (NULL, handed_at
set), the review is the handover alone. An overdue deadline is not taken
away by it: only closing or moving it.
Reset to NULL when the owner changes.';

COMMENT ON COLUMN task.handed_at IS
'When the task last came to its current owner (trigger on owner_id): the
moment of its last owner_change.
Until they accept it (reviewed_at NULL, mark_reviewed()) their review
shows the handover alone; accepted, reviewed_at is handed_at, and only
what came after it is new to them. NULL — never handed over: the creator
owns it.';

COMMENT ON CONSTRAINT chk_task_tag_ids_set ON task IS
'Tags: non-empty, no NULLs, no duplicates.';

COMMENT ON CONSTRAINT uq_task_tag_ids ON task IS
'The set of tags is unique — it is the task "title".';


-- ============================================================================
-- 4a. owner_change — who owned a task, and since when
-- ============================================================================
CREATE TABLE owner_change (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES task(id),
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    from_id INT REFERENCES employee(id),
    to_id INT REFERENCES employee(id),
    by INT REFERENCES employee(id)
);
CREATE INDEX idx_owner_change_task ON owner_change(task_id, at);

COMMENT ON TABLE owner_change IS
'Ownership history: one row per change of task.owner_id, written by a
trigger (decision 96). task.owner_id is the current owner and
task.handed_at the moment of the last row. The creation of a task is not
a row: when a task was created is not stored (philosophy).
The rows are never changed or deleted. The task''s feed shows each one.';

COMMENT ON COLUMN owner_change.id IS
'Row id.';

COMMENT ON COLUMN owner_change.task_id IS
'Which task.';

COMMENT ON COLUMN owner_change.at IS
'When the owner changed.';

COMMENT ON COLUMN owner_change.from_id IS
'The previous owner. NULL — the task had none, or, with by NULL, it is
not known.';

COMMENT ON COLUMN owner_change.to_id IS
'The new owner. NULL — the task was left without one.';

COMMENT ON COLUMN owner_change.by IS
'Who changed it: the owner who handed it over, their manager, whoever
took an ownerless task, the manager of a dismissed owner. NULL — not
known: a change made before 0.6, restored from its notifications.';


-- ============================================================================
-- 5. observer — who sees a task, and access requests
-- ============================================================================
CREATE TABLE observer (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES task(id),
    value INT NOT NULL REFERENCES employee(id),
    added_by INT REFERENCES employee(id),
    added_at TIMESTAMPTZ,
    deleted_by INT REFERENCES employee(id),
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_observer_open
    ON observer(task_id, value)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_observer_value
    ON observer(value)
    WHERE added_at IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE observer IS
'Access to a task and access requests.

STATES:
  - added_at IS NULL AND deleted_at IS NULL — a request awaiting approval.
  - added_at IS NOT NULL AND deleted_at IS NULL — active access.
  - deleted_at IS NOT NULL — access closed or request rejected.
At most one open row per (task_id, value).

A task without active rows is public (is_public()).

WHO CREATES A ROW:
  - The employee requests access to a private task: added_by = NULL,
    added_at = NULL. The owner is notified.
  - A participant adds someone (add_observer): added_by = them,
    added_at = NOW(). The new observer is notified (access_opened).
  - The system: added_by = NULL, added_at = NOW(). This is how the owner
    (on task creation and transfer, unless the task is public) and the
    managers of all active observers, recursively, are added (triggers).

WHO APPROVES:
  - The task owner: approve_access / reject_access; the requester is
    notified (access_opened / access_closed). The requester may withdraw
    the request (withdraw_access).

ACCESS IS REVOKED:
  - An observer can leave (leave_task, deleted_by = value).
  - The owner can remove an observer (remove_observer); they are
    notified (access_closed).
  - make_public closes every row; make_private brings back the owner and
    everyone with an open mention, and notifies the others who commented
    (access_closed).
  - The owner cannot leave.
  - A manager cannot leave or be removed while an active report of theirs
    (recursively) observes the task.
Rows are never deleted: they are the observation periods shown in the
task.

When an observer leaves, their current estimate_minutes row is closed
(expired_at = NOW()) and their reminders (remind) are deleted (trigger).';

COMMENT ON COLUMN observer.id IS
'Row id.';

COMMENT ON COLUMN observer.task_id IS
'Which task the access is for.';

COMMENT ON COLUMN observer.value IS
'Who gets access to the task.';

COMMENT ON COLUMN observer.added_by IS
'Who granted access.
NULL with added_at IS NULL = the employee requested access.
NULL with added_at NOT NULL = added by the system.';

COMMENT ON COLUMN observer.added_at IS
'When the access became active.
NULL = a request awaiting the owner''s approval.';

COMMENT ON COLUMN observer.deleted_by IS
'Who closed the access or rejected the request.';

COMMENT ON COLUMN observer.deleted_at IS
'When closed. NULL = access active or request pending.';


CREATE OR REPLACE FUNCTION ordered_tags(p_employee_id INT, p_tag_ids INT[])
RETURNS INT[] AS $$
    SELECT ARRAY(
        SELECT t.id
          FROM unnest(p_tag_ids) AS t(id)
          LEFT JOIN user_tag u ON u.employee_id = p_employee_id AND u.tag_id = t.id
         ORDER BY COALESCE(u.weight, 0) DESC,
                  (SELECT COUNT(*)
                     FROM observer o JOIN task k ON k.id = o.task_id
                    WHERE o.value = p_employee_id
                      AND o.added_at IS NOT NULL
                      AND o.deleted_at IS NULL
                      AND k.tag_ids @> ARRAY[t.id]) DESC,
                  t.id
    )
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION ordered_tags(INT, INT[]) IS
'Tags of a task in the order an employee sees them as its "title".
task.tag_ids stays sorted by id (for UNIQUE); only the display order
changes: by the employee''s weight (user_tag.weight), heavier first; on a
tie, the tag carried by more tasks the employee observes goes first; then
by id.';


-- ============================================================================
-- 6. dependency — the dependency graph
-- ============================================================================
CREATE TABLE dependency (
    task_id INT NOT NULL REFERENCES task(id),
    value INT NOT NULL REFERENCES task(id),
    latest_at TIMESTAMPTZ,
    done_at TIMESTAMPTZ,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    added_by INT REFERENCES employee(id),
    PRIMARY KEY (task_id, value),

    CONSTRAINT chk_dependency_not_self CHECK (task_id <> value)
);
CREATE INDEX idx_dependency_value ON dependency(value);

COMMENT ON TABLE dependency IS
'The dependency graph. task_id depends on value.
Linking binds nobody (decision 94): anyone who sees both tasks links them
— an existing task or a new one, made with it — and the
owners of both other than whoever added it are notified (waits_added,
dependency_added) and see it in their review. latest_at is the owner of
task_id''s alone; a dependency is removed by the owner of task_id or by
whoever added it. Checked by the application.
Cycles are forbidden (trigger). Self-dependency is forbidden (CHECK).
Deletion is physical. No audit.
When finished_at of value is set, moved or cleared, owners of all
dependent tasks are notified.';

COMMENT ON COLUMN dependency.task_id IS
'The dependent task.';

COMMENT ON COLUMN dependency.value IS
'The task task_id depends on.';

COMMENT ON COLUMN dependency.latest_at IS
'The latest deadline of value that task_id can live with, set by the
owner of task_id. NULL = no constraint: the dependency only says what
waits for what. Nothing is forbidden by it: while task_id is open and
the deadline of value is later than latest_at or not set, the constraint
is broken (dependency_risk()) and both tasks are at risk (at_risk()).';

COMMENT ON COLUMN dependency.done_at IS
'When the owner of value closed it (close_task()): only then is it done for task_id,
whose owner is notified (dependency_done) and sees it in "Waiting for
me" while done_at is after their own task''s reviewed_at — "No
intervention needed" there takes note. Cleared when value reopens
(change_deadline()). NULL — not done.';

COMMENT ON COLUMN dependency.added_at IS
'When the dependency was added. NULL — added before 0.5, not known.';

COMMENT ON COLUMN dependency.added_by IS
'Who added it: they may remove it, and its notice goes to the owners of
both tasks but them. NULL — added before 0.5, not known.';


-- ============================================================================
-- 7. finished_at — task deadline history
-- ============================================================================
CREATE TABLE finished_at (
    task_id INT NOT NULL REFERENCES task(id),
    value TIMESTAMPTZ NOT NULL,
    entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expired_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,

    CONSTRAINT chk_finished_at_confirmed CHECK (confirmed_at IS NULL OR confirmed_at >= value)
);
CREATE UNIQUE INDEX uq_finished_at_active
    ON finished_at(task_id) WHERE expired_at IS NULL;
CREATE INDEX idx_finished_at_task ON finished_at(task_id);

COMMENT ON TABLE finished_at IS
'Task deadline history.
Current = expired_at IS NULL. There may be no rows — "not set".
The task is closed when the current row is confirmed (confirmed_at), and
only its owner confirms it (close_task()). A current value <= NOW() not
confirmed is an overdue task: still open (decision 93).

Set, moved (later or earlier) and cleared only by the owner —
through set_finished_at / clear_finished_at.
Move: the old row is closed and a new one opened.
Clear: the old row is closed, no new one is created.
A change within deadline_settles() of the previous one replaces it
(change_deadline()): a person trying dates leaves only the last one.
Owners of dependent tasks are notified once the deadline settles, and
told when the new deadline breaks the latest one their task can live
with (dependency.latest_at).

A deadline reminds its owner: a day before it (or when set, if later) it
is a notice of their review in "Waiting for me" ("deadline in …") until a
review takes it away, and once it passed unconfirmed it stays there as
overdue until they close it (refused while someone still has time planned
on it — that plan is cleared first) or move the deadline (decision 94).
Nothing is sent: "Waiting for me" is computed from these rows (decision
87).';

COMMENT ON COLUMN finished_at.task_id IS
'Which task.';

COMMENT ON COLUMN finished_at.value IS
'Moment of completion. NOT NULL.';

COMMENT ON COLUMN finished_at.entered_at IS
'When this value became current.';

COMMENT ON COLUMN finished_at.expired_at IS
'When it stopped being current. NULL = current.';

COMMENT ON COLUMN finished_at.confirmed_at IS
'When the owner closed the task at this deadline (close_task()). Never
before the deadline itself: an open task is closed by a deadline set to
now and confirmed at once. Later than value — closed after its deadline.
A new row (the deadline moved) starts unconfirmed: the task is open
again. NULL — not closed.';

COMMENT ON CONSTRAINT chk_finished_at_confirmed ON finished_at IS
'A deadline is confirmed only once it has come.';

COMMENT ON INDEX uq_finished_at_active IS
'Exactly one current deadline: UNIQUE (task_id) WHERE expired_at IS NULL.';


-- ============================================================================
-- 8. estimate_minutes — time estimate history
-- ============================================================================
CREATE TABLE estimate_minutes (
    task_id INT NOT NULL REFERENCES task(id),
    by INT NOT NULL REFERENCES human(employee_id),
    value INT NOT NULL CHECK (value > 0),
    about TEXT CHECK (about <> '' AND length(about) <= 1000),
    entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expired_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_estimate_minutes_active
    ON estimate_minutes(task_id, by) WHERE expired_at IS NULL;
CREATE INDEX idx_estimate_minutes_task ON estimate_minutes(task_id);
CREATE INDEX idx_estimate_minutes_by ON estimate_minutes("by", entered_at);

COMMENT ON TABLE estimate_minutes IS
'History of each observer''s estimate of the time left: how much more
they plan to spend, not the total. Spent (spent_minutes) + left is the
current forecast; the history shows how it changed.
Current row = expired_at IS NULL.
Set by anyone who sees the task — for themselves (by = them).
A change closes the old row and opens a new one.
When an observer leaves the task, their current row is closed.
Does not notify the task owner.';

COMMENT ON COLUMN estimate_minutes.by IS
'Who estimates.';

COMMENT ON COLUMN estimate_minutes.value IS
'How many more minutes they plan to spend. > 0.';

COMMENT ON COLUMN estimate_minutes.about IS
'What they still mean to do for these minutes, in their words (decision
88): so the owner of an overdue task knows what a plan left on it is about,
and others what the hours are for. NULL — not said.';

COMMENT ON COLUMN estimate_minutes.entered_at IS
'When this value became current.';

COMMENT ON COLUMN estimate_minutes.expired_at IS
'When it stopped being current. NULL = current.';


CREATE OR REPLACE FUNCTION backlog_minutes(p_employee_id INT, p_at TIMESTAMPTZ)
RETURNS INT AS $$
    SELECT COALESCE(sum(es.value), 0)::int
      FROM estimate_minutes es
     WHERE es."by" = p_employee_id
       AND es.entered_at <= p_at AND (es.expired_at IS NULL OR es.expired_at > p_at)
       AND NOT EXISTS (
         SELECT 1 FROM finished_at f
          WHERE f.task_id = es.task_id
            AND f.entered_at <= p_at AND (f.expired_at IS NULL OR f.expired_at > p_at)
            AND f.confirmed_at <= p_at)
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION backlog_minutes(INT, TIMESTAMPTZ) IS
'The employee''s backlog at a moment: how many more minutes they planned
to spend (their estimates current then) on tasks not closed then. Its
change over a range is whether planned work grows faster than it is done.';


CREATE OR REPLACE FUNCTION backlog_by_day(p_employee_ids INT[], p_from DATE, p_to DATE)
RETURNS TABLE (employee_id INT, day DATE, minutes INT) AS $$
    WITH d AS (
        SELECT e.id, g::date AS day,
               LEAST(NOW(), (g::date + 1)::timestamp AT TIME ZONE e.time_zone) AS at
          FROM employee e, generate_series(p_from, p_to, INTERVAL '1 day') g
         WHERE e.id = ANY(p_employee_ids)
    )
    SELECT d.id, d.day, COALESCE(sum(es.value), 0)::int
      FROM d
      LEFT JOIN estimate_minutes es
             ON es."by" = d.id AND es.entered_at <= d.at AND (es.expired_at IS NULL OR es.expired_at > d.at)
            AND NOT EXISTS (
                SELECT 1 FROM finished_at f
                 WHERE f.task_id = es.task_id
                   AND f.entered_at <= d.at AND (f.expired_at IS NULL OR f.expired_at > d.at)
                   AND f.confirmed_at <= d.at)
     GROUP BY d.id, d.day
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION backlog_by_day(INT[], DATE, DATE) IS
'backlog_minutes() at the end of every day of a range (now for today), for
several people at once — one set-based query instead of a call per
person and day, for the sparklines of My team.';


-- ============================================================================
-- 10. work — timesheet
-- ============================================================================
CREATE TABLE work (
    id SERIAL NOT NULL UNIQUE,
    employee_id INT NOT NULL REFERENCES human(employee_id),
    started_at TIMESTAMPTZ NOT NULL,
    spent_minutes INT CHECK (spent_minutes > 0),
    about TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (employee_id, started_at),
    CONSTRAINT chk_work_length CHECK (spent_minutes <= 24 * 60),
    CONSTRAINT excl_work_overlap EXCLUDE USING gist (
        employee_id WITH =,
        work_period(started_at, spent_minutes) WITH &&
    )
);

COMMENT ON TABLE work IS
'Timesheet. The employee records: "started at 10:00, worked N minutes".
Optional — if nobody keeps it, the day cannot be scored.

spent_minutes IS NULL — the shift is open (working right now).
An open shift lasts until infinity, so an employee has at most one open
shift and no shift can follow it.
The employee always closes the shift themselves, with whatever time
they consider right.
Shift end = started_at + spent_minutes. A shift may run past midnight: it
belongs to every day of the employee it touches, each with its share of the
minutes (shift_day, decision 100). It is never longer than 24 hours
(chk_work_length): a slip of the date is not a week of work.
Shifts of one employee never overlap (EXCLUDE).
A shift cannot start in the future, nor end after the end of the current
minute: the timesheet is kept in whole minutes, so closing rounds the end
up — a shift closed at 17:59:40 ends at 18:00, and one started a moment
ago can be closed as one minute.

Any shift without a standing score can be added, changed or deleted,
closed ones included, and a day may have several shifts. A score freezes
the shift and its time entries; the manager withdrawing the score
(score.value NULL) lets the employee correct them. Time is logged to tasks
within a shift (spent_minutes.shift_id): a shift is never shorter than the
time logged in it, nor deleted while time is logged in it (trigger).

about — what was done during the shift. Free text, optional.

The close_delay metric (delay in closing a shift) is computed on the
frontend: the difference between updated_at and
(started_at + spent_minutes). A large one is a signal for the manager.

id — the shift''s own number: time entries and scores refer to it, so a
shift keeps them when its times are corrected.';

COMMENT ON COLUMN work.id IS
'The shift''s number, for time entries and scores; never changes.';

COMMENT ON COLUMN work.employee_id IS
'Who worked.';

COMMENT ON COLUMN work.started_at IS
'When work started. Part of the PK.';

COMMENT ON COLUMN work.spent_minutes IS
'Minutes worked. NULL = the shift is open.
Filled by the employee when closing the shift.';

COMMENT ON COLUMN work.about IS
'What was done during the shift. Free text. Optional.';

COMMENT ON COLUMN work.updated_at IS
'When the row last changed (for a closed shift — the moment it was closed).';

COMMENT ON CONSTRAINT excl_work_overlap ON work IS
'Shifts of one employee never overlap. An open one lasts until infinity.';

COMMENT ON CONSTRAINT chk_work_length ON work IS
'A shift lasts at most 24 hours.';


CREATE OR REPLACE FUNCTION day_split(p_time_zone TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (day DATE, minutes NUMERIC, share NUMERIC) AS $$
    SELECT g::date,
           extract(epoch FROM LEAST(p_to, (g::date + 1)::timestamp AT TIME ZONE p_time_zone)
                            - GREATEST(p_from, g::date::timestamp AT TIME ZONE p_time_zone)) / 60,
           CASE WHEN p_to > p_from
                THEN extract(epoch FROM LEAST(p_to, (g::date + 1)::timestamp AT TIME ZONE p_time_zone)
                                      - GREATEST(p_from, g::date::timestamp AT TIME ZONE p_time_zone))
                     / extract(epoch FROM p_to - p_from)
                ELSE 1 END
      FROM generate_series((p_from AT TIME ZONE p_time_zone)::date,
                           (GREATEST(p_from, p_to - INTERVAL '1 microsecond') AT TIME ZONE p_time_zone)::date,
                           INTERVAL '1 day') g
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION day_split(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) IS
'The days of a time zone an interval touches, each with its minutes in
it and its share of the whole (1 for an empty interval, on its day).';


CREATE VIEW shift_day AS
SELECT w.id AS shift_id, w.employee_id, d.day, d.minutes, d.share, w.spent_minutes IS NOT NULL AS closed
  FROM work w
  JOIN employee e ON e.id = w.employee_id
 CROSS JOIN LATERAL day_split(e.time_zone, w.started_at,
                              COALESCE(w.started_at + w.spent_minutes * INTERVAL '1 minute', GREATEST(NOW(), w.started_at))) d;

COMMENT ON VIEW shift_day IS
'Each shift by the days of its employee it touches (decision 100): a shift
past midnight belongs to both days, each with the minutes worked in it and
its share of the shift. An open shift counts up to now (closed = FALSE).
Sums by day take minutes from here, so nothing is counted twice.';


-- ============================================================================
-- 9. spent_minutes — time entries
-- ============================================================================
CREATE TABLE spent_minutes (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES task(id),
    by INT NOT NULL REFERENCES human(employee_id),
    shift_id INT NOT NULL REFERENCES work(id),
    value INT NOT NULL CHECK (value > 0),
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_spent_minutes_shift UNIQUE (task_id, "by", shift_id)
);
CREATE INDEX idx_spent_minutes_task ON spent_minutes(task_id);
CREATE INDEX idx_spent_minutes_shift ON spent_minutes(shift_id);
CREATE INDEX idx_spent_minutes_by ON spent_minutes(by);

COMMENT ON TABLE spent_minutes IS
'Time entries: one per task, person and shift (uq_spent_minutes_shift).
by — who logged it, in one of their own shifts (shift_id). Only for
oneself, only someone who sees the task (can_see). Checked by a trigger.
Time is logged only within a shift (decision 100): the entries of a
shift together are at most its length — for an open one, the time since
it began (check_shift_minutes()). Nothing changes in a scored shift.
The value is the shift''s whole time on the task: a new value replaces it
(updated_at follows), 0 removes the entry — never in a scored shift.
An entry belongs to the days of its shift by the shift''s shares
(spent_day).
Does not notify the task owner.';

COMMENT ON COLUMN spent_minutes.id IS
'Entry id (for deletion).';

COMMENT ON COLUMN spent_minutes.task_id IS
'Which task the time is logged to.';

COMMENT ON COLUMN spent_minutes.by IS
'Who logged it — and for whom: only for oneself.';

COMMENT ON COLUMN spent_minutes.shift_id IS
'The shift of by the time is logged in.';

COMMENT ON COLUMN spent_minutes.value IS
'Minutes spent in that shift on the task, all of them. CHECK > 0: none is no row.';

COMMENT ON COLUMN spent_minutes.added_at IS
'When the entry was first made.';

COMMENT ON COLUMN spent_minutes.updated_at IS
'When its value was last set: shown over the entry.';

COMMENT ON CONSTRAINT uq_spent_minutes_shift ON spent_minutes IS
'One entry per task, person and shift: time is set for the shift, not added up.';


CREATE VIEW spent_day AS
SELECT s.id AS entry_id, s.task_id, s."by", s.shift_id, d.day, s.value * d.share AS minutes, s.added_at, s.updated_at
  FROM spent_minutes s
  JOIN shift_day d ON d.shift_id = s.shift_id;

COMMENT ON VIEW spent_day IS
'Each time entry by the days of its shift, with the share of its minutes
that falls on each (decision 100): sums of time by day take it from here.';


-- ============================================================================
-- 9a. tag_limit — limits of hours on a combination of tags
-- ============================================================================
CREATE TABLE tag_limit (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES human(employee_id),
    tag_ids INT[] NOT NULL,
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    minutes INT NOT NULL CHECK (minutes > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expired_at TIMESTAMPTZ,
    replaced_by INT REFERENCES tag_limit(id),

    CONSTRAINT chk_tag_limit_tag_ids CHECK (is_int_set(tag_ids)),
    CONSTRAINT chk_tag_limit_period CHECK (starts_on <= ends_on AND ends_on - starts_on <= 731),
    CONSTRAINT chk_tag_limit_replaced CHECK (replaced_by IS NULL OR expired_at IS NOT NULL)
);
CREATE INDEX idx_tag_limit_employee ON tag_limit(employee_id) WHERE expired_at IS NULL;
CREATE INDEX idx_tag_limit_replaced_by ON tag_limit(replaced_by);

COMMENT ON TABLE tag_limit IS
'A limit of hours an employee sets on a combination of tags for a fixed
period: they and everyone under them (subordinates()) may spend at most
minutes on the tasks carrying all of tag_ids between starts_on and
ends_on. A task under several limits counts in each: one may be
underspent, none overspent. Set by anyone, for themselves and their
people; seen by them, their managers up the chain and everyone under them
(can_see_tag_limit()); other people''s limits are theirs alone. It
forbids nothing and sends nothing: it is a line to keep to, shown with
what has been spent and what is planned, so nobody can say they did not
see it. A request to change one goes as anything else does — in a task.

Never edited (trigger): a change closes the row (expired_at) and opens a
new one (replaced_by points to it), removing only closes it — the history
is the chain of rows. Current = expired_at IS NULL.';

COMMENT ON COLUMN tag_limit.employee_id IS
'Who set it: their own hours and their subordinates'' count against it.';

COMMENT ON COLUMN tag_limit.tag_ids IS
'The combination: a task counts when it carries all of them.';

COMMENT ON COLUMN tag_limit.starts_on IS
'The first day of the period, in the days of the time entries.';

COMMENT ON COLUMN tag_limit.ends_on IS
'The last day of the period, included. At most two years after starts_on.';

COMMENT ON COLUMN tag_limit.minutes IS
'The limit, in minutes.';

COMMENT ON COLUMN tag_limit.expired_at IS
'When it stopped being current: changed or removed. NULL = current.';

COMMENT ON COLUMN tag_limit.replaced_by IS
'The row that replaced it when it was changed; NULL when removed or current.';


-- ============================================================================
-- 10a. attachment — attachments
-- ============================================================================
CREATE TABLE attachment (
    id SERIAL PRIMARY KEY,
    hash BYTEA NOT NULL,
    size INT NOT NULL CHECK (size >= 0),
    mime VARCHAR(100) NOT NULL,
    value BYTEA,
    uploaded_by INT[] NOT NULL DEFAULT '{}',
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    held_by INT[] NOT NULL DEFAULT '{}',
    purged_at TIMESTAMPTZ,

    CONSTRAINT chk_attachment_purged CHECK ((value IS NULL) = (purged_at IS NOT NULL)),
    CONSTRAINT chk_attachment_held CHECK (value IS NOT NULL OR cardinality(held_by) = 0)
);
CREATE INDEX idx_attachment_hash ON attachment(hash);
CREATE INDEX idx_attachment_used_at ON attachment(used_at);
CREATE INDEX idx_attachment_uploaded_by ON attachment USING GIN (uploaded_by);
CREATE INDEX idx_attachment_held_by ON attachment USING GIN (held_by);

COMMENT ON TABLE attachment IS
'Attachments: files of comments and images inside comments and task
contexts.
Uploaded before the comment is sent; the comment refers to them by the
arrays comment.attachment_ids (files) and comment.image_ids (images in
the text), a context by task.context_image_ids — by id, not by hash
(hashes may collide).
Reading an attachment: whoever uploaded or holds it, or whoever sees a
task whose comment or context refers to it (the application checks).
There is no file name here: the same file may arrive under different
names; the name is stored in comment.attachment_names.
Deduplication: on upload the application looks for a row with the same
hash and size and compares the bytes (or finds one whose content was
deleted); on a match it returns the existing id, puts the content back if
it was gone, and the uploader holds it (held_by).
Cron deletes, once a day, attachments nothing refers to
(attachment_in_use) that have not been used for more than a day
(uploaded, but the comment was never sent). An attachment in use cannot
be deleted (trigger) — comments live forever.

Storage is limited (decision 84), by the configuration, not the
database: a file at most so large; the files a person holds (held_by) at
most so much together, refused at upload or keep. Nothing deletes a
file''s content by its size or age: people let go of what they no longer
need when their quota runs out.
A file is kept while someone holds it: its uploaders, and whoever saw it
in a task and kept it (keep_attachment()) — a file handed to the one who
needs it stays theirs when its author lets it go. Letting a file go
(release_attachment()) takes it out of one''s quota; when nobody holds it
any more, its content is deleted. The row stays — who uploaded it, its
size, the names in comments — and value goes (purged_at): a link to it
says the file is gone. Anyone uploading the same bytes again (the same
hash and size) restores it in place, so every link to it works again.';

COMMENT ON COLUMN attachment.id IS
'Id. Referenced by comment.attachment_ids.';

COMMENT ON COLUMN attachment.hash IS
'SHA-256 of the content. For a quick duplicate lookup, not unique.';

COMMENT ON COLUMN attachment.size IS
'Size in bytes.';

COMMENT ON COLUMN attachment.mime IS
'MIME type.';

COMMENT ON COLUMN attachment.value IS
'File content. NULL — deleted when nobody held it any more (purged_at);
the same bytes uploaded again bring it back.';

COMMENT ON COLUMN attachment.held_by IS
'Who keeps the file — it counts in each one''s quota: the uploaders, and
whoever kept a file they saw in a task. Empty with content — uploaded
before 0.5 and not let go of, or kept by nobody: nobody pays for it. When
the last holder lets it go, the content is deleted.';

COMMENT ON CONSTRAINT chk_attachment_held ON attachment IS
'Nobody holds a file without content.';

COMMENT ON INDEX idx_attachment_held_by IS
'A person''s quota: the files they hold.';

COMMENT ON COLUMN attachment.purged_at IS
'When the content was deleted — the last holder let it go. NULL — the
content is here.';

COMMENT ON CONSTRAINT chk_attachment_purged ON attachment IS
'No content exactly when it was purged.';

COMMENT ON INDEX idx_attachment_uploaded_by IS
'A person''s files: their list.';

COMMENT ON COLUMN attachment.uploaded_by IS
'Everyone who uploaded these bytes (deduplication returns the same row).
They may read it before it is attached anywhere. It stays when they let
the file go and after its content is gone: the history of who uploaded
what. Who keeps it in their quota is held_by.';

COMMENT ON COLUMN attachment.added_at IS
'When first uploaded.';

COMMENT ON COLUMN attachment.used_at IS
'When last uploaded again or attached to a comment.';


-- ============================================================================
-- 11. comment — comments
-- ============================================================================
CREATE TABLE comment (
    task_id INT NOT NULL REFERENCES task(id),
    id INT NOT NULL,
    created_by INT NOT NULL REFERENCES employee(id),
    value TEXT NOT NULL,
    attachment_ids INT[] NOT NULL DEFAULT '{}',
    attachment_names TEXT[] NOT NULL DEFAULT '{}',
    image_ids INT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reply_to_id INT,
    reviewed_at TIMESTAMPTZ,
    PRIMARY KEY (task_id, id),
    FOREIGN KEY (task_id, reply_to_id) REFERENCES comment(task_id, id),

    CONSTRAINT chk_comment_attachment_ids
        CHECK (cardinality(attachment_ids) = 0 OR is_int_set(attachment_ids)),
    CONSTRAINT chk_comment_attachment_names
        CHECK (cardinality(attachment_names) = cardinality(attachment_ids)
               AND array_position(attachment_names, NULL) IS NULL),
    CONSTRAINT chk_comment_image_ids
        CHECK (cardinality(image_ids) = 0 OR is_int_set(image_ids))
);
CREATE INDEX idx_comment_reply_to ON comment(task_id, reply_to_id);
CREATE INDEX idx_comment_attachment_ids ON comment USING GIN (attachment_ids);
CREATE INDEX idx_comment_image_ids ON comment USING GIN (image_ids);
CREATE INDEX idx_comment_value_trgm ON comment USING GIN (value gin_trgm_ops);

COMMENT ON TABLE comment IS
'Comments. id is local (max+1 within task_id).
reply_to_id is the local id of the parent in the same task.
Comments are never edited, deleted or hidden (trigger); only reviewed_at,
its author''s, changes.
If a comment is outdated, reply to it (reply_to_id) and say so.
The interface protects against accidental sending: for a few seconds
after "Send" the comment can be pulled back into editing, and only then
it goes to the server.
All communication about a task happens here. Written by anyone who sees
the task (trigger).
Employees (mention) and tasks (task_mention) are attached to a comment.
A comment notifies the task owner (unless the owner wrote it).';

COMMENT ON COLUMN comment.task_id IS
'Which task.';

COMMENT ON COLUMN comment.id IS
'Local id: max+1 within task_id. Trigger with an advisory lock.';

COMMENT ON COLUMN comment.created_by IS
'Comment author.';

COMMENT ON COLUMN comment.value IS
'Comment text: sanitized HTML (see WHAT THE APPLICATION DOES ITSELF).';

COMMENT ON COLUMN comment.image_ids IS
'Attachments shown as images inside the text. Filled by the application
from the HTML. No duplicates, all exist (trigger).';

COMMENT ON COLUMN comment.created_at IS
'When the comment was created.';

COMMENT ON COLUMN comment.attachment_ids IS
'Attachment ids (attachment). No duplicates, all exist (trigger).
Their used_at is updated on insert.';

COMMENT ON COLUMN comment.attachment_names IS
'File names in the same order as attachment_ids.';

COMMENT ON COLUMN comment.reply_to_id IS
'Local id of the parent comment in the same task. NULL — a root comment.';

COMMENT ON COLUMN comment.reviewed_at IS
'Up to when the author has seen the reactions to the comment''s mentions:
replies by the mentioned and closings ("No intervention needed",
review_comment(), decision 98). A comment with mentions waits in its
author''s Waiting for others while it was never reviewed or has a
reaction after it; one reviewed with mentions still unanswered leaves
the list until someone reacts. Never moves back. NULL — never reviewed.';


-- ============================================================================
-- 12. mention / task_mention — what is attached to a comment
-- ============================================================================
CREATE TABLE mention (
    task_id INT NOT NULL,
    comment_id INT NOT NULL,
    value INT NOT NULL REFERENCES employee(id),
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (task_id, comment_id, value),
    FOREIGN KEY (task_id, comment_id) REFERENCES comment(task_id, id)
);
CREATE INDEX idx_mention_value ON mention(value) WHERE closed_at IS NULL;

COMMENT ON TABLE mention IS
'An employee attached to a comment (a mention).
Attached explicitly, the text is not parsed.
Open (closed_at IS NULL): in the mentioned employee''s TODO in My day —
the only way a task they merely observe gets there. Closed by the
mentioned employee: after a reply ("Done"), or without one ("No reply
needed") — a reply alone does not mean the request is handled (decision
95). The comment waits in its author''s Waiting for others with each
reaction (a reply, the closing) until the author reviews it
(comment.reviewed_at, decision 98).
The author adds a mention to their comment later and deletes one until
its first reaction (trigger): a mistake is corrected, an answered request
is not erased.
Self-mention and mentioning a dismissed employee are forbidden. In a
private task only an active observer can be mentioned: someone is brought
in first (add_observer), a mention only addresses those already in. In a
public task anyone can be mentioned, and it adds no observer (trigger).
The mentioned employee is always notified.';

COMMENT ON COLUMN mention.task_id IS
'Which task.';

COMMENT ON COLUMN mention.comment_id IS
'Local comment id.';

COMMENT ON COLUMN mention.value IS
'Who is mentioned.';

COMMENT ON COLUMN mention.closed_at IS
'When the mention was closed. NULL = open.';

COMMENT ON COLUMN mention.created_at IS
'When the person was mentioned: the comment''s moment, or later if the
author added the mention afterwards. The reaction is counted from it, and
only replies after it answer the mention.';



CREATE TABLE task_mention (
    task_id INT NOT NULL,
    comment_id INT NOT NULL,
    value INT NOT NULL REFERENCES task(id),
    PRIMARY KEY (task_id, comment_id, value),
    FOREIGN KEY (task_id, comment_id) REFERENCES comment(task_id, id),

    CONSTRAINT chk_task_mention_not_self CHECK (value <> task_id)
);
CREATE INDEX idx_task_mention_value ON task_mention(value);

COMMENT ON TABLE task_mention IS
'A task attached to a comment of another task.
idx_task_mention_value serves backlinks ("where this task is mentioned").
The owner of the attached task is notified (unless they wrote the
comment).';

COMMENT ON COLUMN task_mention.task_id IS
'The comment''s task.';

COMMENT ON COLUMN task_mention.comment_id IS
'Local comment id.';

COMMENT ON COLUMN task_mention.value IS
'Which task is attached.';


-- ============================================================================
-- 13. remind — reminders
-- ============================================================================
CREATE TABLE remind (
    employee_id INT NOT NULL REFERENCES human(employee_id),
    task_id INT NOT NULL REFERENCES task(id),
    at TIMESTAMPTZ NOT NULL,
    value TEXT,
    sent_at TIMESTAMPTZ,

    PRIMARY KEY (employee_id, task_id, at)
);
CREATE INDEX idx_remind_at ON remind(at) WHERE sent_at IS NULL;

COMMENT ON TABLE remind IS
'Task reminders. Any observer can set a reminder for themselves at a
given moment: a thought put off until then, so it need not be kept in
mind meanwhile. send_due_reminds() sends it once due (sent_at), and from
then on it waits in their "Waiting for me" until they remove it or move
it to a later moment (at changes, sent_at is cleared) — a reminder is not
gone because a notification went out. Leaving the task deletes the
reminders.
value — reminder text (what exactly to remind about). Optional.';

COMMENT ON COLUMN remind.employee_id IS
'Whom to remind.';

COMMENT ON COLUMN remind.task_id IS
'Which task.';

COMMENT ON COLUMN remind.at IS
'When to remind.';

COMMENT ON COLUMN remind.value IS
'Reminder text.';

COMMENT ON COLUMN remind.sent_at IS
'When the notification went out; NULL — not due yet. A sent reminder is
in "Waiting for me" until removed or moved.';


-- ============================================================================
-- 14. notification — notification queue
-- ============================================================================
CREATE TABLE notification (
    id BIGSERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employee(id),
    task_id INT REFERENCES task(id),
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_notification_employee
    ON notification(employee_id) WHERE closed_at IS NULL;
CREATE INDEX idx_notification_unsent
    ON notification(added_at) WHERE sent_at IS NULL;
CREATE INDEX idx_notification_added_at ON notification(added_at);

COMMENT ON TABLE notification IS
'Notification queue. Not an inbox.
Created only through notify(), which handles absence and dismissal.
payload JSONB — context; kind is stored inside payload.
The worker takes WHERE sent_at IS NULL (FOR UPDATE SKIP LOCKED), sends
it by email and/or to the webhook and sets sent_at; a finished_at_change
waits deadline_settles() first, and change_deadline() replaces it
meanwhile. One that fails waits for its next attempt in
notification_failure while the queue goes on. The user handles the
notification — closed_at. Cleaned up after a year.

RULES:
  - comment -> the task owner (unless they wrote it).
  - mention -> the mentioned employee, always.
  - task attached to a comment -> the owner of the attached task
    (unless they wrote the comment).
  - reminder (remind) -> whoever set it.
  - access request -> the task owner.
  - access opened (added by the owner, request approved, the task made
    public while a request waited) -> the employee.
  - access closed (removed, request rejected, the task made private
    without them) -> the employee.
  - finished_at set / moved / cleared -> owners of dependent tasks, once
    it settles (deadline_settles(): the worker holds it that long).
  - a task closed by its owner (close_task) -> the owners of the tasks
    waiting for it (dependency_done).
  - a new dependency -> the owner of the task waited for (with the latest
    deadline the waiting task can live with, if set; dependency_added),
    and the owner of the waiting task (waits_added) — but not whoever
    added it.
  - owner change -> the new owner. If the manager initiated it — the
    previous owner too.
  - score -> the scored employee.
  - invite -> the invitee.
  - welcome -> someone added without an invite: the first employee, or
    whoever the installation''s administrator adds outside the API.
  - a new report (someone set their manager) -> the new manager.
  - a bot''s key a year old -> the bot''s manager, once a year of its age.
If the recipient is away, a copy goes to their manager (recursively).
Dismissed employees get no notifications.

Delivery: an email in the employee.locale language (SMTP_URL) and/or the
outgoing webhook (WEBHOOK_URL), whose receiver picks other channels
(Telegram, Slack, ...); a bot gets its own webhook only.';

COMMENT ON COLUMN notification.id IS
'Notification id.';

COMMENT ON COLUMN notification.employee_id IS
'Recipient.';

COMMENT ON COLUMN notification.task_id IS
'Which task (may be NULL).';

COMMENT ON COLUMN notification.added_at IS
'When the notification was created.';

COMMENT ON COLUMN notification.sent_at IS
'When sent to the webhook. NULL = queued.';

COMMENT ON COLUMN notification.closed_at IS
'When the user handled the notification. NULL = not handled.';

COMMENT ON COLUMN notification.payload IS
'JSONB context. Contains kind:
  comment | mention | task_mention | remind | access_request |
  access_opened | access_closed | finished_at_change | dependency_added |
  dependency_done | waits_added |
  owner_change | owner_handed |
  score | invite | welcome | new_report | weekly_digest | bot_key_old.
Payload keys are camelCase (employeeId, dependencyId, ...).
A copy for an absent employee''s manager has for = the recipient id.';


CREATE TABLE notification_failure (
    notification_id BIGINT PRIMARY KEY REFERENCES notification(id) ON DELETE CASCADE,
    attempts INT NOT NULL CHECK (attempts > 0),
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_attempt_at TIMESTAMPTZ,
    mailed BOOLEAN NOT NULL DEFAULT FALSE,
    error TEXT NOT NULL
);
CREATE INDEX idx_notification_failure_next ON notification_failure(next_attempt_at);

COMMENT ON TABLE notification_failure IS
'A person''s notification that could not be delivered: the mail server
refused it (a mailbox deleted, a full one) or the webhook did not take it.
It waits here for its next attempt while the queue goes on: one broken
address never holds the others. Attempts after 1, 5 and 15 minutes, then
every hour, for three days (fail_notification()); then it is given up
and stays for the administrator to see (node server/admin.ts
deliveries). Delivered at last, the row goes. A bot''s webhook is not
here: it gets one attempt (bot_usage counts the failure).';

COMMENT ON COLUMN notification_failure.attempts IS
'How many attempts failed.';

COMMENT ON COLUMN notification_failure.first_failed_at IS
'When the first attempt failed: three days after it the notification is given up.';

COMMENT ON COLUMN notification_failure.last_failed_at IS
'When the last attempt failed.';

COMMENT ON COLUMN notification_failure.next_attempt_at IS
'When to try again. NULL — given up.';

COMMENT ON COLUMN notification_failure.mailed IS
'The email went and the webhook failed: the next attempt sends only to the
webhook, so nobody gets the same email twice.';

COMMENT ON COLUMN notification_failure.error IS
'What the last attempt failed with, for the administrator.';

COMMENT ON INDEX idx_notification_failure_next IS
'For the worker: the notifications due for another attempt.';


-- ============================================================================
-- 15. score — the work score of a shift
-- ============================================================================
CREATE TABLE score (
    shift_id INT PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
    by INT NOT NULL REFERENCES human(employee_id),
    value INT CHECK (value BETWEEN 0 AND 100),
    reason TEXT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);

COMMENT ON TABLE score IS
'An employee''s work score for a shift. 0–100 (decision 100).
Set by the employee''s current manager (employee.manager_id) for any
closed shift; the interface scores the day''s unscored shifts at once.
A score cannot be deleted. The current manager may correct it (value,
reason; by and updated_at follow) or withdraw it (value -> NULL, the
reason stays, to be seen again when the shift is scored anew); the
application emails every version to the employee with its time and the
previous value, so the history lives in their mail and the table keeps
only the current value. While a score stands (value IS NOT NULL) the
shift and its time entries are frozen (triggers); withdrawing it is how
a manager lets the employee correct them. A withdrawn score is not a
score: it counts nowhere, and it goes with its shift if the employee
deletes it.

The score is about the quality of the shift''s decisions:
  - did the employee pick the right priorities;
  - do their decisions match the manager''s understanding.
Not about the task result. A task may fail while the scores are good, if
the employee chose well every day.

reason — an optional justification. Needed first of all for bad scores,
so the employee understands what went wrong.

Weighted average score for a period: SUM(value * minutes) / SUM(minutes)
over the scored shifts, the minutes of each within the period
(shift_day). A day''s score is the same over the day. Workload — the
minutes — is a separate metric; the manager weighs it on their own when
deciding on a bonus.';

COMMENT ON COLUMN score.shift_id IS
'Which shift is scored; whose — its employee.';

COMMENT ON COLUMN score.by IS
'Who scored — the manager at the time of scoring (manager_id has no history).';

COMMENT ON COLUMN score.value IS
'Score 0–100. Quality of the shift''s decisions. NULL — withdrawn: the
shift is not scored, and it and its time entries can be corrected.';

COMMENT ON COLUMN score.reason IS
'Justification. Optional. Needed first of all for bad scores.';

COMMENT ON COLUMN score.added_at IS
'When the score was first given.';

COMMENT ON COLUMN score.updated_at IS
'When the score was last corrected. NULL — never.';


-- ============================================================================
-- 16. visit — who opened what and when
-- ============================================================================
CREATE TABLE visit (
    id BIGSERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES human(employee_id),
    task_id INT REFERENCES task(id),
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_visit_task ON visit(task_id, at) WHERE task_id IS NOT NULL;
CREATE INDEX idx_visit_employee ON visit(employee_id, at);

COMMENT ON TABLE visit IS
'Visits: an employee opened a task (task_id) or any other screen — My day,
a person''s days, a new task (task_id IS NULL).
Written by log_visit(), at most once per 10 minutes per (employee, task).
The client logs on opening a screen and on coming back to a tab that was
hidden for 10 minutes or more: sitting on a page is one visit.
Used to:
  - show the owner in the task who looked at it;
  - show the history of a day in "My day" and on the employee page
    (which tasks were opened, when the employee came in);
  - suggest when a shift started and ended (first and last activity of
    the day).
Cron deletes visits older than a year.';

COMMENT ON COLUMN visit.id IS
'Visit id.';

COMMENT ON COLUMN visit.employee_id IS
'Who visited.';

COMMENT ON COLUMN visit.task_id IS
'Which task. NULL — another screen.';

COMMENT ON COLUMN visit.at IS
'When.';


CREATE OR REPLACE FUNCTION log_visit(p_employee_id INT, p_task_id INT)
RETURNS VOID AS $$
BEGIN
    -- Two tabs opening the same screen at once must not both pass the check.
    PERFORM pg_advisory_xact_lock(hashtext('yartt.visit'), p_employee_id);
    IF NOT EXISTS (
        SELECT 1 FROM visit
         WHERE employee_id = p_employee_id
           AND task_id IS NOT DISTINCT FROM p_task_id
           AND at > NOW() - INTERVAL '10 minutes'
    ) THEN
        INSERT INTO visit (employee_id, task_id) VALUES (p_employee_id, p_task_id);
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION log_visit(INT, INT) IS
'Logs a visit unless the same one was logged within the last 10 minutes.
p_task_id = NULL — "My day". Serialized per employee by an advisory lock,
so simultaneous calls log one visit.';


-- ============================================================================
-- FUNCTIONS used by triggers
-- ============================================================================

-- ----------------------------------------------------------------------------
-- notify — create a notification, honoring absence
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify(
    p_employee_id INT,
    p_task_id INT,
    p_payload JSONB,
    p_told INT[] DEFAULT '{}'
)
RETURNS VOID AS $$
DECLARE
    v_id INT := p_employee_id;
    v_dismissed_at TIMESTAMPTZ;
    v_next_day DATE;
    v_manager_id INT;
    v_payload JSONB := p_payload;
    v_seen INT[] := ARRAY[]::INT[];
BEGIN
    SELECT dismissed_at INTO v_dismissed_at FROM employee WHERE id = p_employee_id;
    IF NOT FOUND OR v_dismissed_at IS NOT NULL THEN
        RETURN;
    END IF;

    LOOP
        SELECT e.dismissed_at, h.next_day, e.manager_id
          INTO v_dismissed_at, v_next_day, v_manager_id
          FROM employee e LEFT JOIN human h ON h.employee_id = e.id
         WHERE e.id = v_id;

        IF v_dismissed_at IS NULL THEN
            INSERT INTO notification (employee_id, task_id, payload)
            VALUES (v_id, p_task_id, v_payload);
            EXIT WHEN v_next_day IS NULL OR v_next_day <= local_today(v_id);
        END IF;

        -- A ring of managers all away (decision 90): the copies stop where they began.
        v_seen := v_seen || v_id;
        EXIT WHEN v_manager_id IS NULL OR v_manager_id = ANY(v_seen) OR v_manager_id = ANY(p_told);
        v_id := v_manager_id;
        v_payload := p_payload || jsonb_build_object('for', p_employee_id);
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION notify(INT, INT, JSONB, INT[]) IS
'The only way to create a notification.
A dismissed employee gets nothing. If the recipient is away
(human.next_day in the future), a copy goes to their manager, and so on up until an
available one is found — once round a ring of managers at most. Copies carry
for = the original recipient. p_told — those told of the same thing
already (mentioned in the same comment): the copies stop before them.';


-- ----------------------------------------------------------------------------
-- grant_observer — grant active access
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fail_notification(p_id BIGINT, p_error TEXT, p_mailed BOOLEAN)
RETURNS TIMESTAMPTZ AS $$
DECLARE
    v_attempts INT;
    v_first TIMESTAMPTZ;
    v_next TIMESTAMPTZ;
BEGIN
    INSERT INTO notification_failure AS f (notification_id, attempts, mailed, error)
    VALUES (p_id, 1, p_mailed, p_error)
    ON CONFLICT (notification_id) DO UPDATE
       SET attempts = f.attempts + 1, last_failed_at = NOW(),
           mailed = f.mailed OR EXCLUDED.mailed, error = EXCLUDED.error
    RETURNING attempts, first_failed_at INTO v_attempts, v_first;

    v_next := NOW() + CASE v_attempts WHEN 1 THEN INTERVAL '1 minute'
                                      WHEN 2 THEN INTERVAL '5 minutes'
                                      WHEN 3 THEN INTERVAL '15 minutes'
                                      ELSE INTERVAL '1 hour' END;
    IF v_next > v_first + INTERVAL '3 days' THEN
        v_next := NULL;
    END IF;
    UPDATE notification_failure SET next_attempt_at = v_next WHERE notification_id = p_id;
    RETURN v_next;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fail_notification(BIGINT, TEXT, BOOLEAN) IS
'Records a failed attempt to deliver a person''s notification and
returns when to try again: after 1, 5 and 15 minutes, then every hour;
NULL — three days have passed since the first failure, it is given up.
p_mailed — the email went this time (the webhook failed).';


CREATE OR REPLACE FUNCTION grant_observer(
    p_task_id INT,
    p_employee_id INT,
    p_actor_id INT
)
RETURNS VOID AS $$
BEGIN
    UPDATE observer
       SET added_at = NOW(),
           added_by = p_actor_id
     WHERE task_id = p_task_id
       AND value = p_employee_id
       AND added_at IS NULL
       AND deleted_at IS NULL;

    IF NOT FOUND THEN
        INSERT INTO observer (task_id, value, added_by, added_at)
        VALUES (p_task_id, p_employee_id, p_actor_id, NOW())
        ON CONFLICT (task_id, value) WHERE deleted_at IS NULL DO NOTHING;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION grant_observer(INT, INT, INT) IS
'Makes an employee an active observer. No permission checks.
A pending request -> approved. Already active -> nothing. Otherwise -> a new row.
p_actor_id = NULL — a system action.';


-- ----------------------------------------------------------------------------
-- is_public / can_see / is_observer — who sees a task
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_observer(p_task_id INT, p_employee_id INT)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM observer
         WHERE task_id = p_task_id
           AND value = p_employee_id
           AND added_at IS NOT NULL
           AND deleted_at IS NULL
    )
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION is_observer(INT, INT) IS
'TRUE if the employee is an active observer of the task.';


CREATE OR REPLACE FUNCTION is_public(p_task_id INT)
RETURNS BOOLEAN AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM observer
         WHERE task_id = p_task_id
           AND added_at IS NOT NULL
           AND deleted_at IS NULL
    )
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION is_public(INT) IS
'TRUE if the task has no active observers: every employee sees it.';


CREATE OR REPLACE FUNCTION can_see(p_task_id INT, p_employee_id INT)
RETURNS BOOLEAN AS $$
    SELECT is_observer(p_task_id, p_employee_id) OR is_public(p_task_id)
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION can_see(INT, INT) IS
'TRUE if the employee sees the whole task (context, comments, people,
time): they observe it, or it is public. The header (tags, priority,
deadline, owner) is visible to everyone regardless.';


CREATE OR REPLACE FUNCTION attachment_in_use(p_attachment_id INT)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (SELECT 1 FROM comment
                    WHERE attachment_ids @> ARRAY[p_attachment_id]
                       OR image_ids @> ARRAY[p_attachment_id])
        OR EXISTS (SELECT 1 FROM task
                    WHERE context_image_ids @> ARRAY[p_attachment_id])
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION attachment_in_use(INT) IS
'TRUE if a comment (file or image) or a task context refers to the attachment.';


CREATE OR REPLACE FUNCTION touch_attachments(p_ids INT[])
RETURNS VOID AS $$
DECLARE
    v_found INT;
BEGIN
    UPDATE attachment SET used_at = NOW() WHERE id = ANY(p_ids);
    GET DIAGNOSTICS v_found = ROW_COUNT;
    IF v_found <> (SELECT COUNT(DISTINCT x) FROM unnest(p_ids) AS x) THEN
        RAISE EXCEPTION 'attachment ids contain unknown attachments'
            USING HINT = 'unknown_attachment';
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION touch_attachments(INT[]) IS
'Checks that all attachments exist and updates their used_at. The UPDATE
locks the rows, so the cleanup cannot delete them concurrently.';




-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- no deletion: employee, task, comment
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_forbid_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME
            USING HINT = 'immutable_row';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_forbid_delete() IS
'Forbids DELETE (and, for comment, an UPDATE of anything but its
reviewed_at). An employee is dismissed, a task is closed, a comment
stays forever and is never edited.';

CREATE TRIGGER employee_forbid_delete
BEFORE DELETE ON employee
FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();

CREATE TRIGGER task_forbid_delete
BEFORE DELETE ON task
FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();

CREATE TRIGGER comment_forbid_change
BEFORE DELETE OR UPDATE OF task_id, id, created_by, value, attachment_ids, attachment_names, image_ids, created_at, reply_to_id
ON comment
FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();


-- ----------------------------------------------------------------------------
-- employee: a person has a human row, a bot a bot row (at commit)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_employee_kind_row()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.kind = 'human' AND NOT EXISTS (SELECT 1 FROM human WHERE employee_id = NEW.id)
       OR NEW.kind = 'bot' AND NOT EXISTS (SELECT 1 FROM bot WHERE employee_id = NEW.id) THEN
        RAISE EXCEPTION 'employee % has no % row', NEW.id, NEW.kind
            USING HINT = 'invalid_data';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_employee_kind_row() IS
'An employee is created together with the row of its kind (human or bot)
in one transaction; checked at commit. The (employee_id, kind) foreign
keys keep anyone from having both.';

CREATE CONSTRAINT TRIGGER employee_kind_row
AFTER INSERT ON employee
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_employee_kind_row();


-- ----------------------------------------------------------------------------
-- employee: the new manager sees the employee's tasks
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_employee_manager_observe()
RETURNS TRIGGER AS $$
DECLARE
    v_task_id INT;
BEGIN
    FOR v_task_id IN
        SELECT task_id FROM observer
         WHERE value = NEW.id
           AND added_at IS NOT NULL
           AND deleted_at IS NULL
    LOOP
        PERFORM grant_observer(v_task_id, NEW.manager_id, NULL);
    END LOOP;

    PERFORM notify(NEW.manager_id, NULL, jsonb_build_object(
        'kind', 'new_report', 'employeeId', NEW.id));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_employee_manager_observe() IS
'When manager_id changes, the new manager (and recursively their managers)
becomes an observer of all the employee''s tasks. The tasks of the
employee''s reports are already among them — the employee observes them.
The new manager is notified (new_report).';

CREATE TRIGGER employee_manager_observe
AFTER UPDATE OF manager_id ON employee
FOR EACH ROW
WHEN (NEW.manager_id IS NOT NULL AND NEW.manager_id IS DISTINCT FROM OLD.manager_id)
EXECUTE FUNCTION trg_employee_manager_observe();


-- ----------------------------------------------------------------------------
-- tag: a tag in use cannot be deleted
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_tag_in_use()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM task WHERE tag_ids @> ARRAY[OLD.id]) THEN
        RAISE EXCEPTION 'tag % is used by tasks', OLD.id
            USING HINT = 'tag_in_use',
                  DETAIL = json_build_object('tagId', OLD.id)::text;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_tag_in_use() IS
'Forbids deleting a tag that appears in task.tag_ids.';

CREATE TRIGGER tag_in_use
BEFORE DELETE ON tag
FOR EACH ROW EXECUTE FUNCTION trg_tag_in_use();


-- ----------------------------------------------------------------------------
-- task: normalize tag_ids
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_task_tag_ids()
RETURNS TRIGGER AS $$
DECLARE
    v_found INT;
BEGIN
    NEW.tag_ids := ARRAY(SELECT x FROM unnest(NEW.tag_ids) AS x ORDER BY x);

    PERFORM 1 FROM tag WHERE id = ANY(NEW.tag_ids) FOR KEY SHARE;
    GET DIAGNOSTICS v_found = ROW_COUNT;
    IF v_found <> (SELECT COUNT(DISTINCT x) FROM unnest(NEW.tag_ids) AS x) THEN
        RAISE EXCEPTION 'tag_ids contain unknown tags'
            USING HINT = 'unknown_tag';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_task_tag_ids() IS
'Sorts tag_ids (for UNIQUE) and checks that all tags exist.
FOR KEY SHARE prevents a concurrent deletion of a tag.';

CREATE TRIGGER task_tag_ids
BEFORE INSERT OR UPDATE OF tag_ids ON task
FOR EACH ROW EXECUTE FUNCTION trg_task_tag_ids();


-- ----------------------------------------------------------------------------
-- task: an owner change resets reviewed_at and marks the handover
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_task_owner_reset_review()
RETURNS TRIGGER AS $$
DECLARE
    v_by TEXT := current_setting('yartt.actor', TRUE);
BEGIN
    IF COALESCE(v_by, '') = '' THEN
        RAISE EXCEPTION 'the owner of task % changed without yartt.actor', NEW.id;
    END IF;
    NEW.reviewed_at := NULL;
    NEW.handed_at := NOW();
    INSERT INTO owner_change (task_id, from_id, to_id, "by")
    VALUES (NEW.id, OLD.owner_id, NEW.owner_id, v_by::int);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_task_owner_reset_review() IS
'reviewed_at = NULL and handed_at = NOW() when the owner changes: the
new owner is shown only what came after the handover (decision 94). The
change is kept in owner_change with who made it: whoever changes
owner_id first sets yartt.actor (set_config(..., TRUE), for the
transaction); without it the change is refused.';

CREATE TRIGGER task_owner_reset_review
BEFORE UPDATE OF owner_id ON task
FOR EACH ROW
WHEN (NEW.owner_id IS DISTINCT FROM OLD.owner_id)
EXECUTE FUNCTION trg_task_owner_reset_review();


-- ----------------------------------------------------------------------------
-- task: context images exist, used_at is updated
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_task_context_images()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM touch_attachments(NEW.context_image_ids);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_task_context_images() IS
'Checks that the images of the context exist and updates their used_at.';

CREATE TRIGGER task_context_images
BEFORE INSERT OR UPDATE OF context_image_ids ON task
FOR EACH ROW
WHEN (cardinality(NEW.context_image_ids) > 0)
EXECUTE FUNCTION trg_task_context_images();


-- ----------------------------------------------------------------------------
-- task: the owner of a private task is always an observer
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_task_owner_observe()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND is_public(NEW.id) THEN
        RETURN NULL;
    END IF;
    PERFORM grant_observer(NEW.id, NEW.owner_id, NULL);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_task_owner_observe() IS
'The creator and every new owner of a private task become observers
(and, through observer_add_manager, their managers too). A new owner of a
public task does not: an observer would make it private.';

CREATE TRIGGER task_owner_observe_insert
AFTER INSERT ON task
FOR EACH ROW
WHEN (NEW.owner_id IS NOT NULL)
EXECUTE FUNCTION trg_task_owner_observe();

CREATE TRIGGER task_owner_observe_update
AFTER UPDATE OF owner_id ON task
FOR EACH ROW
WHEN (NEW.owner_id IS NOT NULL AND NEW.owner_id IS DISTINCT FROM OLD.owner_id)
EXECUTE FUNCTION trg_task_owner_observe();


-- ----------------------------------------------------------------------------
-- observer: the manager of an active observer is an observer too
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_observer_add_manager()
RETURNS TRIGGER AS $$
DECLARE
    v_manager_id INT;
BEGIN
    IF NEW.added_at IS NULL OR NEW.deleted_at IS NOT NULL THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.added_at IS NOT NULL THEN
        RETURN NULL;
    END IF;

    SELECT manager_id INTO v_manager_id FROM employee WHERE id = NEW.value;
    IF v_manager_id IS NOT NULL THEN
        PERFORM grant_observer(NEW.task_id, v_manager_id, NULL);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_observer_add_manager() IS
'When access becomes active, the observer''s manager gets access too.
The recursion up the hierarchy goes through this same trigger.';

CREATE TRIGGER observer_add_manager
AFTER INSERT OR UPDATE OF added_at ON observer
FOR EACH ROW EXECUTE FUNCTION trg_observer_add_manager();


-- ----------------------------------------------------------------------------
-- observer: leaving a task
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_observer_leave()
RETURNS TRIGGER AS $$
BEGIN
    -- make_public() closes every row; everyone still sees the task.
    IF current_setting('yartt.public_task', TRUE) = NEW.task_id::text THEN
        RETURN NEW;
    END IF;

    IF NEW.value = (SELECT owner_id FROM task WHERE id = NEW.task_id) THEN
        RAISE EXCEPTION 'owner cannot leave task %', NEW.task_id
            USING HINT = 'owner_cannot_leave',
                  DETAIL = json_build_object('taskId', NEW.task_id)::text;
    END IF;

    IF EXISTS (
        SELECT 1 FROM observer
         WHERE task_id = NEW.task_id
           AND value IN (SELECT subordinates(NEW.value))
           AND added_at IS NOT NULL
           AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'manager % cannot leave task % while a subordinate observes it',
            NEW.value, NEW.task_id
            USING HINT = 'manager_cannot_leave',
                  DETAIL = json_build_object('employeeId', NEW.value, 'taskId', NEW.task_id)::text;
    END IF;

    UPDATE estimate_minutes SET expired_at = NOW()
     WHERE task_id = NEW.task_id AND by = NEW.value AND expired_at IS NULL;
    DELETE FROM remind
     WHERE task_id = NEW.task_id AND employee_id = NEW.value;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_observer_leave() IS
'On closing access: keeps the owner and any manager whose report
(recursively) observes the task; closes the leaver''s estimate_minutes
and deletes their reminders. Skipped while make_public() closes every
row: nobody loses sight of the task then.';

CREATE TRIGGER observer_leave
BEFORE UPDATE OF deleted_at ON observer
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND OLD.added_at IS NOT NULL)
EXECUTE FUNCTION trg_observer_leave();


-- ----------------------------------------------------------------------------
-- dependency: no cycles
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_dependency_cycle()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('yartt.dependency'));

    IF EXISTS (
        WITH RECURSIVE chain AS (
            SELECT NEW.value AS id
            UNION
            SELECT d.value FROM dependency d
            JOIN chain c ON d.task_id = c.id
        )
        SELECT 1 FROM chain WHERE id = NEW.task_id
    ) THEN
        RAISE EXCEPTION 'dependency cycle detected'
            USING HINT = 'dependency_cycle';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_dependency_cycle() IS
'Forbids a cycle in the dependency graph.
The advisory lock prevents a race between A->B and B->A in concurrent
transactions.';

CREATE TRIGGER dependency_cycle
BEFORE INSERT OR UPDATE OF task_id, value ON dependency
FOR EACH ROW EXECUTE FUNCTION trg_dependency_cycle();




-- ----------------------------------------------------------------------------
-- comment: local id
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_comment_local_id()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('yartt.comment'), NEW.task_id);
    SELECT COALESCE(MAX(id), 0) + 1 INTO NEW.id
    FROM comment WHERE task_id = NEW.task_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_comment_local_id() IS
'Assigns comment.id = max+1 within task_id.
Advisory lock (space yartt.comment, key task_id), so that concurrent
inserts never get the same MAX(id)+1.';

CREATE TRIGGER comment_local_id
BEFORE INSERT ON comment
FOR EACH ROW EXECUTE FUNCTION trg_comment_local_id();


-- ----------------------------------------------------------------------------
-- comment: only by someone who sees the task
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_comment_author()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT can_see(NEW.task_id, NEW.created_by) THEN
        RAISE EXCEPTION 'employee % does not see task %', NEW.created_by, NEW.task_id
            USING HINT = 'no_access',
                  DETAIL = json_build_object('taskId', NEW.task_id)::text;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_comment_author() IS
'A comment is written only by someone who sees the task (can_see).';

CREATE TRIGGER comment_author
BEFORE INSERT ON comment
FOR EACH ROW EXECUTE FUNCTION trg_comment_author();


-- ----------------------------------------------------------------------------
-- comment: attachments exist, used_at is updated
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_comment_attachments()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM touch_attachments(NEW.attachment_ids || NEW.image_ids);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_comment_attachments() IS
'Checks that all attachment_ids and image_ids exist and updates their
used_at (touch_attachments locks them against the cleanup).';

CREATE TRIGGER comment_attachments
BEFORE INSERT ON comment
FOR EACH ROW
WHEN (cardinality(NEW.attachment_ids) + cardinality(NEW.image_ids) > 0)
EXECUTE FUNCTION trg_comment_attachments();


-- ----------------------------------------------------------------------------
-- attachment: an attachment in use cannot be deleted
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_attachment_in_use()
RETURNS TRIGGER AS $$
BEGIN
    IF attachment_in_use(OLD.id) THEN
        RAISE EXCEPTION 'attachment % is in use', OLD.id
            USING HINT = 'attachment_in_use',
                  DETAIL = json_build_object('attachmentId', OLD.id)::text;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_attachment_in_use() IS
'Forbids deleting an attachment a comment or a task context refers to.';

CREATE TRIGGER attachment_in_use
BEFORE DELETE ON attachment
FOR EACH ROW EXECUTE FUNCTION trg_attachment_in_use();


-- ----------------------------------------------------------------------------
-- mention: not oneself, and in a private task only an observer
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_mention_check()
RETURNS TRIGGER AS $$
DECLARE
    v_author_id INT;
BEGIN
    SELECT created_by INTO v_author_id FROM comment
     WHERE task_id = NEW.task_id AND id = NEW.comment_id;

    IF NEW.value = v_author_id THEN
        RAISE EXCEPTION 'self-mention is not allowed'
            USING HINT = 'self_mention';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM employee WHERE id = NEW.value AND dismissed_at IS NULL) THEN
        RAISE EXCEPTION 'employee % is unknown or dismissed', NEW.value
            USING HINT = 'not_found';
    END IF;

    IF NOT is_public(NEW.task_id) AND NOT is_observer(NEW.task_id, NEW.value) THEN
        RAISE EXCEPTION 'employee % is not an observer of task %', NEW.value, NEW.task_id
            USING HINT = 'mention_not_participant',
                  DETAIL = json_build_object('employeeId', NEW.value, 'taskId', NEW.task_id)::text;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_mention_check() IS
'Forbids self-mentions, mentioning a dismissed employee and, in a private
task, mentioning anyone who is not an active observer: someone is
brought in first (add_observer, approve_access), a mention only
addresses those already in. In a public task anyone may be mentioned and
no observer is added.';

CREATE TRIGGER mention_check
BEFORE INSERT ON mention
FOR EACH ROW EXECUTE FUNCTION trg_mention_check();


CREATE OR REPLACE FUNCTION mention_reaction(p_task_id INT, p_comment_id INT, p_value INT)
RETURNS TIMESTAMPTZ AS $$
    SELECT LEAST(m.closed_at,
                 (SELECT min(r.created_at) FROM comment r
                   WHERE r.task_id = m.task_id AND r.reply_to_id = m.comment_id
                     AND r.created_by = m.value AND r.created_at >= m.created_at))
      FROM mention m
     WHERE m.task_id = p_task_id AND m.comment_id = p_comment_id AND m.value = p_value
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION mention_reaction(INT, INT, INT) IS
'The first reaction to a mention: the mentioned employee''s first reply to
the mentioning comment after they were mentioned, or the closing,
whichever came first. NULL — none yet. The team''s reaction time counts
from mention.created_at to it.';


CREATE OR REPLACE FUNCTION trg_mention_delete_check()
RETURNS TRIGGER AS $$
BEGIN
    IF mention_reaction(OLD.task_id, OLD.comment_id, OLD.value) IS NOT NULL THEN
        RAISE EXCEPTION 'mention of % in comment % of task % has a reaction', OLD.value, OLD.comment_id, OLD.task_id
            USING HINT = 'mention_answered';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_mention_delete_check() IS
'A mention is deleted only until its first reaction (mention_reaction): a
mistake is corrected, an answered request is not erased.';

CREATE TRIGGER mention_delete_check
BEFORE DELETE ON mention
FOR EACH ROW EXECUTE FUNCTION trg_mention_delete_check();


CREATE OR REPLACE FUNCTION review_comment(p_task_id INT, p_comment_id INT, p_actor_id INT, p_until TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM comment WHERE task_id = p_task_id AND id = p_comment_id AND created_by = p_actor_id) THEN
        RAISE EXCEPTION 'comment % of task % is not by employee %', p_comment_id, p_task_id, p_actor_id
            USING HINT = 'forbidden';
    END IF;
    -- Up to what was shown, never past now, never back (GREATEST skips NULLs).
    -- The moment shown comes in milliseconds: it covers its whole millisecond.
    UPDATE comment
       SET reviewed_at = GREATEST(reviewed_at, LEAST(COALESCE(p_until + INTERVAL '999 microseconds', NOW()), NOW()))
     WHERE task_id = p_task_id AND id = p_comment_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION review_comment(INT, INT, INT, TIMESTAMPTZ) IS
'"No intervention needed" on a comment: its author has seen the reactions
to its mentions up to p_until, the newest one shown (NULL — now), so
whatever came later brings the comment back to Waiting for others
(decision 98). Never later than now, never back. Mentions still open
stay open: they wait in the TODO of those mentioned.';


-- ----------------------------------------------------------------------------
-- work: not in the future, frozen once scored, never shorter than its entries
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_work_check()
RETURNS TRIGGER AS $$
DECLARE
    v_time_zone TEXT;
    v_other work;
    v_logged INT;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
        SELECT 1 FROM score WHERE shift_id = OLD.id AND value IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'shift % is scored', OLD.id
            USING HINT = 'shift_scored';
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM spent_minutes WHERE shift_id = OLD.id) THEN
            RAISE EXCEPTION 'time is logged in shift %', OLD.id
                USING HINT = 'shift_has_entries';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.id <> OLD.id THEN
        RAISE EXCEPTION 'a shift keeps its number' USING HINT = 'forbidden';
    END IF;

    -- The end may be the end of the current minute: closing rounds it up.
    IF NEW.started_at > NOW()
       OR NEW.started_at + NEW.spent_minutes * INTERVAL '1 minute'
          > date_trunc('minute', NOW()) + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'shift cannot be in the future'
            USING HINT = 'shift_in_future';
    END IF;

    -- Said with the shift in the way, so the person knows which one to fix;
    -- excl_work_overlap still guards against two writes at once.
    SELECT time_zone INTO v_time_zone FROM employee WHERE id = NEW.employee_id;
    SELECT * INTO v_other FROM work w
     WHERE w.employee_id = NEW.employee_id
       AND (TG_OP = 'INSERT' OR w.id <> OLD.id)
       AND work_period(w.started_at, w.spent_minutes) && work_period(NEW.started_at, NEW.spent_minutes)
     ORDER BY w.started_at
     LIMIT 1;
    IF FOUND THEN
        IF v_other.spent_minutes IS NULL THEN
            RAISE EXCEPTION 'shift overlaps the open shift of employee %', NEW.employee_id
                USING HINT = 'shift_overlap_open',
                      DETAIL = json_build_object(
                          'from', to_char(v_other.started_at AT TIME ZONE v_time_zone, 'HH24:MI'))::text;
        END IF;
        RAISE EXCEPTION 'shift overlaps another shift of employee %', NEW.employee_id
            USING HINT = 'shift_overlap_with',
                  DETAIL = json_build_object(
                      'from', to_char(v_other.started_at AT TIME ZONE v_time_zone, 'HH24:MI'),
                      'to', to_char((v_other.started_at + v_other.spent_minutes * INTERVAL '1 minute')
                                    AT TIME ZONE v_time_zone, 'HH24:MI'))::text;
    END IF;

    -- The time logged in it must still fit.
    IF TG_OP = 'UPDATE' AND NEW.spent_minutes IS NOT NULL THEN
        SELECT COALESCE(sum(value), 0) INTO v_logged FROM spent_minutes WHERE shift_id = NEW.id;
        IF v_logged > NEW.spent_minutes THEN
            RAISE EXCEPTION 'shift % is shorter than the time logged in it', NEW.id
                USING HINT = 'shift_shorter_than_entries',
                      DETAIL = json_build_object(
                          'logged', (v_logged / 60) || ':' || lpad((v_logged % 60)::text, 2, '0'))::text;
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        NEW.updated_at := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_work_check() IS
'The timesheet is the employee''s until a shift is scored (decision 100):
  - any shift without a standing score can be added, changed or deleted,
    an open or a closed one; a scored one changes in no way
    (shift_scored), a withdrawn score (value NULL) frees it;
  - a shift does not start in the future nor end after the current minute
    (closing rounds the end up to the minute);
  - a shift may run past midnight; it lasts at most 24 hours
    (chk_work_length);
  - a shift overlapping another is refused with the other''s times
    (shift_overlap_with, or shift_overlap_open for the open one), so the person
    sees which shift is in the way;
  - a shift is never shorter than the time logged in it
    (shift_shorter_than_entries), nor deleted while time is logged in it
    (shift_has_entries); its number (id) never changes.
Updates updated_at on UPDATE.';


CREATE TRIGGER work_check
BEFORE INSERT OR UPDATE OR DELETE ON work
FOR EACH ROW EXECUTE FUNCTION trg_work_check();


CREATE OR REPLACE FUNCTION working_minutes(p_employee_id INT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS NUMERIC AS $$
    SELECT COALESCE(sum(extract(epoch FROM upper(r) - lower(r))), 0) / 60
      FROM (
        SELECT work_period(started_at, spent_minutes) * tstzrange(p_from, LEAST(p_to, NOW())) AS r
          FROM work
         WHERE employee_id = p_employee_id
           AND work_period(started_at, spent_minutes) && tstzrange(p_from, LEAST(p_to, NOW()))
      ) x
     WHERE NOT isempty(r)
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION working_minutes(INT, TIMESTAMPTZ, TIMESTAMPTZ) IS
'Minutes of the employee''s shifts between two moments (an open shift
counts up to now). Time someone did not work is not theirs to answer
for: a mention a minute after the shift ended, answered as the next
shift began, took 0 working minutes.';


CREATE OR REPLACE FUNCTION deadline_risk(p_task_id INT)
RETURNS TABLE (employee_id INT, planned_minutes INT, capacity_minutes INT) AS $$
    WITH f AS (
        SELECT value FROM finished_at WHERE task_id = p_task_id AND expired_at IS NULL AND value > NOW()
    ),
    people AS (
        SELECT es."by" AS employee_id, es.value AS planned,
               -- Their usual working minutes per calendar day: the last 28 days of
               -- the timesheet; without one, a 40-hour week.
               COALESCE(NULLIF((SELECT sum(w.spent_minutes) FROM work w
                                 WHERE w.employee_id = es."by" AND w.spent_minutes IS NOT NULL
                                   AND w.started_at > NOW() - INTERVAL '28 days'), 0) / 28.0,
                        40 * 60 / 7.0) AS per_day
          FROM estimate_minutes es
         WHERE es.task_id = p_task_id AND es.expired_at IS NULL
    )
    SELECT p.employee_id, p.planned,
           (p.per_day * extract(epoch FROM f.value - NOW()) / 86400)::int AS capacity
      FROM people p, f
     WHERE p.planned > p.per_day * extract(epoch FROM f.value - NOW()) / 86400
     ORDER BY p.planned - p.per_day * extract(epoch FROM f.value - NOW()) / 86400 DESC
     LIMIT 1
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION deadline_risk(INT) IS
'An open task whose deadline will not be met by its people''s plans: the
person whose "time left" (estimate_minutes) exceeds most their working
time until the deadline — their usual minutes per day (the last 28 days
of their timesheet, or a 40-hour week without one) times the days left.
No row — the task fits, has no deadline ahead or nobody planned it.
Each person is measured against their own time only; hours of different
people are never added up.';


CREATE OR REPLACE FUNCTION dependency_risk(p_task_id INT)
RETURNS TABLE (task_id INT, value INT, latest_at TIMESTAMPTZ, deadline TIMESTAMPTZ) AS $$
    SELECT d.task_id, d.value, d.latest_at, fv.value
      FROM dependency d
      LEFT JOIN finished_at fv ON fv.task_id = d.value AND fv.expired_at IS NULL
      LEFT JOIN finished_at ft ON ft.task_id = d.task_id AND ft.expired_at IS NULL
     WHERE (d.task_id = p_task_id OR d.value = p_task_id)
       AND d.latest_at IS NOT NULL
       AND ft.confirmed_at IS NULL
       AND (fv.value IS NULL OR fv.value > d.latest_at
            OR (fv.confirmed_at IS NULL AND d.latest_at < NOW()))
     ORDER BY d.task_id, d.value
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION dependency_risk(INT) IS
'Broken deadline constraints around the task, in both directions: a
dependency whose waiting task (task_id) is open while the deadline of the
task waited for (value) is later than the latest one the waiting task can
live with (latest_at), or not set, or that latest one has passed with the
task waited for still open (overdue). Where p_task_id is task_id it is late
because of value; where it is value it delays task_id.';


CREATE OR REPLACE FUNCTION at_risk(p_task_id INT)
RETURNS BOOLEAN AS $$
    SELECT NOT EXISTS (SELECT 1 FROM finished_at f
                        WHERE f.task_id = p_task_id AND f.expired_at IS NULL AND f.confirmed_at IS NOT NULL)
       AND (EXISTS (SELECT 1 FROM deadline_risk(p_task_id))
            OR EXISTS (SELECT 1 FROM dependency_risk(p_task_id)))
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION at_risk(INT) IS
'An open task at risk: someone''s plan does not fit before its deadline
(deadline_risk()), or a deadline constraint around it is broken
(dependency_risk()) — it is late because of a task it waits for, or it
delays a task that waits for it.';


-- ----------------------------------------------------------------------------
-- spent_minutes: for oneself, by an observer, within an unscored shift
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_shift_minutes(p_shift_id INT, p_task_id INT, p_minutes INT)
RETURNS VOID AS $$
DECLARE
    v_others INT;
    v_length INT;
BEGIN
    -- Two entries of the same shift written at once must not both pass.
    PERFORM pg_advisory_xact_lock(hashtext('yartt.spent'), p_shift_id);
    SELECT COALESCE(spent_minutes, ceil(extract(epoch FROM NOW() - started_at) / 60)::int) INTO v_length
      FROM work WHERE id = p_shift_id;
    SELECT COALESCE(sum(value), 0) INTO v_others FROM spent_minutes
     WHERE shift_id = p_shift_id AND task_id <> p_task_id;
    IF v_others + p_minutes > v_length THEN
        RAISE EXCEPTION 'more logged in shift % than it lasts', p_shift_id
            USING HINT = 'spent_over_shift',
                  DETAIL = json_build_object(
                      'logged', (v_others / 60) || ':' || lpad((v_others % 60)::text, 2, '0'),
                      'left', (GREATEST(v_length - v_others, 0) / 60) || ':'
                              || lpad((GREATEST(v_length - v_others, 0) % 60)::text, 2, '0'))::text;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION check_shift_minutes(INT, INT, INT) IS
'A shift holds the time logged in it: the entries of all tasks in one
shift together are at most its length — an open one''s, the time since it
began (decision 100). p_minutes — the new value of the entry of
p_task_id, which replaces the old one. Refused with spent_over_shift,
saying how much the other tasks of the shift already have and how much is
left.';


CREATE OR REPLACE FUNCTION trg_spent_minutes_check()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.task_id <> OLD.task_id OR NEW."by" <> OLD."by" OR NEW.shift_id <> OLD.shift_id) THEN
        RAISE EXCEPTION 'a time entry keeps its task, person and shift'
            USING HINT = 'spent_immutable';
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        IF EXISTS (SELECT 1 FROM score WHERE shift_id = OLD.shift_id AND value IS NOT NULL) THEN
            RAISE EXCEPTION 'shift % is scored', OLD.shift_id
                USING HINT = 'shift_scored';
        END IF;
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        PERFORM check_shift_minutes(NEW.shift_id, NEW.task_id, NEW.value);
        NEW.updated_at := NOW();
        RETURN NEW;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM work WHERE id = NEW.shift_id AND employee_id = NEW."by") THEN
        RAISE EXCEPTION 'shift % is not a shift of employee %', NEW.shift_id, NEW."by"
            USING HINT = 'not_found';
    END IF;

    IF NOT can_see(NEW.task_id, NEW."by") THEN
        RAISE EXCEPTION 'employee % does not see task %', NEW."by", NEW.task_id
            USING HINT = 'no_access',
                  DETAIL = json_build_object('taskId', NEW.task_id)::text;
    END IF;

    IF EXISTS (SELECT 1 FROM score WHERE shift_id = NEW.shift_id AND value IS NOT NULL) THEN
        RAISE EXCEPTION 'shift % is scored', NEW.shift_id
            USING HINT = 'shift_scored';
    END IF;
    PERFORM check_shift_minutes(NEW.shift_id, NEW.task_id, NEW.value);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_spent_minutes_check() IS
'Time entries: only by someone who sees the task, in a shift of their own,
not in a scored one, and at most the shift''s length on all tasks of the
shift together (check_shift_minutes()). An UPDATE sets the value of the
same task, person and shift (updated_at follows); a scored shift changes
in no way.';

CREATE TRIGGER spent_minutes_check
BEFORE INSERT OR UPDATE OR DELETE ON spent_minutes
FOR EACH ROW EXECUTE FUNCTION trg_spent_minutes_check();


-- ----------------------------------------------------------------------------
-- score: by the manager, for a closed shift; corrected, never deleted
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_score_check()
RETURNS TRIGGER AS $$
DECLARE
    v_employee_id INT;
    v_minutes INT;
BEGIN
    -- A withdrawn score goes with its shift (ON DELETE CASCADE); a standing one keeps it.
    IF TG_OP = 'DELETE' THEN
        IF OLD.value IS NULL AND NOT EXISTS (SELECT 1 FROM work WHERE id = OLD.shift_id) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'score cannot be deleted'
            USING HINT = 'score_final';
    END IF;

    SELECT employee_id, spent_minutes INTO v_employee_id, v_minutes FROM work WHERE id = NEW.shift_id;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.shift_id <> OLD.shift_id THEN
            RAISE EXCEPTION 'score cannot move to another shift'
                USING HINT = 'score_final';
        END IF;
        IF NEW."by" IS DISTINCT FROM (SELECT manager_id FROM employee WHERE id = v_employee_id) THEN
            RAISE EXCEPTION 'only current manager can correct the score of employee %', v_employee_id
                USING HINT = 'not_manager',
                      DETAIL = json_build_object('employeeId', v_employee_id)::text;
        END IF;
        NEW.updated_at := NOW();
        -- Withdrawing, or correcting a standing score: the shift was checked when scored.
        IF NEW.value IS NULL OR OLD.value IS NOT NULL THEN
            RETURN NEW;
        END IF;
    END IF;

    IF TG_OP = 'INSERT' AND NEW."by" IS DISTINCT FROM (SELECT manager_id FROM employee WHERE id = v_employee_id) THEN
        RAISE EXCEPTION 'only current manager can score employee %', v_employee_id
            USING HINT = 'not_manager',
                  DETAIL = json_build_object('employeeId', v_employee_id)::text;
    END IF;

    IF v_minutes IS NULL THEN
        RAISE EXCEPTION 'shift % is still open', NEW.shift_id
            USING HINT = 'shift_open';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_score_check() IS
'Score: only by the employee''s current manager, only for a closed shift
(decision 100). A correction or a withdrawal (UPDATE, value NULL) only by
the current manager, of the same shift; updated_at is set. Scoring a
withdrawn shift again checks it like a first score. DELETE is forbidden,
but for a withdrawn score going with its shift.';

CREATE TRIGGER score_check
BEFORE INSERT OR UPDATE OR DELETE ON score
FOR EACH ROW EXECUTE FUNCTION trg_score_check();


-- ----------------------------------------------------------------------------
-- tag_limit: never edited, never deleted
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_tag_limit_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a tag limit cannot be deleted' USING HINT = 'forbidden';
    END IF;
    IF OLD.expired_at IS NOT NULL
       OR NEW.expired_at IS NULL
       OR (NEW.id, NEW.employee_id, NEW.tag_ids, NEW.starts_on, NEW.ends_on, NEW.minutes, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.employee_id, OLD.tag_ids, OLD.starts_on, OLD.ends_on, OLD.minutes, OLD.created_at) THEN
        RAISE EXCEPTION 'tag limit % can only be closed, once', OLD.id USING HINT = 'forbidden';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trg_tag_limit_immutable() IS
'A tag limit is history: it is only closed — expired_at, and replaced_by
when a new row takes its place — once; never changed otherwise or deleted.';

CREATE TRIGGER tag_limit_immutable
BEFORE UPDATE OR DELETE ON tag_limit
FOR EACH ROW EXECUTE FUNCTION trg_tag_limit_immutable();


-- ============================================================================
-- FUNCTIONS (API)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- auth
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION issue_token(p_email CITEXT, p_browser TEXT)
RETURNS TEXT AS $$
DECLARE
    v_employee_id INT;
    v_token TEXT;
BEGIN
    SELECT e.id INTO v_employee_id
      FROM employee e JOIN human h ON h.employee_id = e.id
     WHERE e.email = p_email AND e.dismissed_at IS NULL AND h.idp_blocked_at IS NULL;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    -- At most 5 links in 15 minutes: beyond that, silently as for an unknown
    -- address, so an inbox cannot be flooded and nothing is revealed.
    IF (SELECT count(*) FROM token
         WHERE employee_id = v_employee_id AND sent_at > NOW() - INTERVAL '15 minutes') >= 5 THEN
        RETURN NULL;
    END IF;

    v_token := encode(gen_random_bytes(32), 'hex');
    INSERT INTO token (hash, employee_id, browser)
    VALUES (digest(v_token, 'sha256'), v_employee_id, digest(p_browser, 'sha256'));
    RETURN v_token;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION issue_token(CITEXT, TEXT) IS
'Issues a magic token for the sign-in link (sent to the webhook directly),
bound to the browser that asked (p_browser — the key of its cookie).
NULL — no such employee (or dismissed, or refused by the identity provider
— idp_blocked_at), or 5 links in the last 15 minutes
already (the same answer, so the limit reveals nothing).
The application should not reveal to the user that the email is unknown.';


CREATE OR REPLACE FUNCTION start_session(p_employee_id INT)
RETURNS TEXT AS $$
DECLARE
    v_session TEXT := encode(gen_random_bytes(32), 'hex');
BEGIN
    INSERT INTO session (hash, employee_id)
    VALUES (digest(v_session, 'sha256'), p_employee_id);
    RETURN v_session;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION start_session(INT) IS
'A new session for a person: returns the token for the cookie, keeps its
hash. Called once the person is known — by a sign-in link (login()) or
by the identity provider (sign_in_external(), confirm_external_email()).';


CREATE OR REPLACE FUNCTION login(p_token TEXT, p_browser TEXT)
RETURNS TEXT AS $$
DECLARE
    v_employee_id INT;
    v_browser BYTEA;
BEGIN
    SELECT employee_id, browser INTO v_employee_id, v_browser FROM token
     WHERE hash = digest(p_token, 'sha256')
       AND email IS NULL
       AND sent_at > NOW() - INTERVAL '10 minutes'
       FOR UPDATE;

    IF v_employee_id IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_browser IS NULL OR v_browser <> digest(p_browser, 'sha256') THEN
        RAISE EXCEPTION 'sign-in link opened outside the browser that asked for it'
            USING HINT = 'login_other_browser';
    END IF;
    DELETE FROM token WHERE hash = digest(p_token, 'sha256');
    RETURN start_session(v_employee_id);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION login(TEXT, TEXT) IS
'Redeems a magic token (at most 10 minutes old) in the browser that asked
for it (p_browser — the key of its cookie) and returns a session token for
the cookie. NULL — the token is invalid. Another browser gets
login_other_browser and the token stays: a mail scanner opening the link
first does not use it up. An email-change token never signs anyone in.';


CREATE OR REPLACE FUNCTION request_email_change(p_employee_id INT, p_email CITEXT)
RETURNS TEXT AS $$
DECLARE
    v_token TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM employee WHERE id = p_employee_id AND kind = 'human' AND dismissed_at IS NULL) THEN
        RAISE EXCEPTION 'employee % is unknown, dismissed or a bot', p_employee_id
            USING HINT = 'not_found';
    END IF;
    IF EXISTS (SELECT 1 FROM employee WHERE email = p_email AND dismissed_at IS NULL AND id <> p_employee_id) THEN
        RAISE EXCEPTION 'email % is taken', p_email
            USING HINT = 'email_taken';
    END IF;
    -- The same limit as sign-in links: a mailbox cannot be flooded.
    IF (SELECT count(*) FROM token
         WHERE employee_id = p_employee_id AND sent_at > NOW() - INTERVAL '15 minutes') >= 5 THEN
        RAISE EXCEPTION 'too many emails for employee %', p_employee_id
            USING HINT = 'too_many_requests';
    END IF;

    v_token := encode(gen_random_bytes(32), 'hex');
    INSERT INTO token (hash, employee_id, email)
    VALUES (digest(v_token, 'sha256'), p_employee_id, p_email);
    RETURN v_token;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION request_email_change(INT, CITEXT) IS
'A person asks to change their email: returns a token to send to the new
address (not through notification — the token must not lie in the
database in plain text). The email does not change until it is
followed (confirm_email_change()): a typo cannot lock anyone out.';


CREATE OR REPLACE FUNCTION confirm_email_change(p_token TEXT)
RETURNS INT AS $$
DECLARE
    v_employee_id INT;
    v_email CITEXT;
BEGIN
    DELETE FROM token
     WHERE hash = digest(p_token, 'sha256')
       AND email IS NOT NULL
       AND sent_at > NOW() - INTERVAL '1 day'
    RETURNING employee_id, email INTO v_employee_id, v_email;

    IF v_employee_id IS NULL THEN
        RAISE EXCEPTION 'email token is unknown, used or expired'
            USING HINT = 'invalid_token';
    END IF;
    UPDATE employee SET email = v_email WHERE id = v_employee_id AND dismissed_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee % is dismissed', v_employee_id
            USING HINT = 'invalid_token';
    END IF;
    -- Other links to other addresses are void now.
    DELETE FROM token WHERE employee_id = v_employee_id AND email IS NOT NULL;
    RETURN v_employee_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION confirm_email_change(TEXT) IS
'Redeems an email-change token (at most a day old): the new address
becomes the employee''s, and their other pending changes are dropped.
Signs nobody in. email_taken if someone working took the address since.';


CREATE OR REPLACE FUNCTION sign_in_external(
    p_sub TEXT,
    p_email CITEXT,
    p_full_name TEXT,
    p_locale TEXT,
    p_time_zone TEXT,
    p_refresh_token TEXT
)
RETURNS TEXT AS $$
DECLARE
    v_id INT;
    v_dismissed_at TIMESTAMPTZ;
BEGIN
    -- Two tabs coming back from the provider at once must not create two people.
    PERFORM pg_advisory_xact_lock(hashtext('yartt.sso'), hashtext(p_sub));

    SELECT e.id, e.dismissed_at INTO v_id, v_dismissed_at
      FROM human h JOIN employee e ON e.id = h.employee_id
     WHERE h.external_id = p_sub;
    IF v_id IS NULL THEN
        -- No address the provider vouches for: the person confirms one (decision 86).
        IF p_email IS NULL THEN
            RETURN NULL;
        END IF;
        -- Someone created before by their address — invited, or added by
        -- the administrator — signing in through the provider for the first time.
        SELECT e.id INTO v_id
          FROM employee e JOIN human h ON h.employee_id = e.id
         WHERE e.email = p_email AND e.dismissed_at IS NULL AND h.external_id IS NULL;
        IF v_id IS NULL THEN
            -- The address is someone's who signs in with another provider account: theirs to confirm.
            IF EXISTS (SELECT 1 FROM employee WHERE email = p_email AND dismissed_at IS NULL) THEN
                RETURN NULL;
            END IF;
            SELECT e.id, e.dismissed_at INTO v_id, v_dismissed_at
              FROM employee e JOIN human h ON h.employee_id = e.id
             WHERE e.email = p_email
             ORDER BY e.dismissed_at DESC
             LIMIT 1;
        END IF;
        IF v_id IS NULL THEN
            INSERT INTO employee (email, full_name, locale, time_zone)
            VALUES (p_email, p_full_name, p_locale, p_time_zone)
            RETURNING id INTO v_id;
            INSERT INTO human (employee_id) VALUES (v_id);
        END IF;
        IF v_dismissed_at IS NULL THEN
            UPDATE human SET external_id = p_sub WHERE employee_id = v_id;
        END IF;
    END IF;
    IF v_dismissed_at IS NOT NULL THEN
        RAISE EXCEPTION 'employee % is dismissed', v_id
            USING HINT = 'dismissed';
    END IF;

    UPDATE human
       SET idp_refresh_token = COALESCE(p_refresh_token, idp_refresh_token),
           idp_checked_at = NOW(),
           idp_blocked_at = NULL
     WHERE employee_id = v_id;
    RETURN start_session(v_id);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sign_in_external(TEXT, CITEXT, TEXT, TEXT, TEXT, TEXT) IS
'A person the company''s identity provider let in (OIDC): returns a
session token, or NULL — they confirm their email first
(begin_external_sign_in(), decision 86).
  1. Known by their provider id (human.external_id): signed in.
  2. Otherwise, with an address the provider vouches for (p_email; the
     application passes only a verified one inside the company''s
     domains): the employee with it who has no provider id yet — invited,
     or created before by their address — is them from now on; with
     nobody at that address someone new is created.
  3. No such address, or it is someone''s bound to another provider
     account: NULL.
A dismissed person is refused (dismissed): only their manager brings them
back. The email does not follow the provider''s afterwards: it is the
person''s, changed in the profile.';


CREATE OR REPLACE FUNCTION begin_external_sign_in(
    p_sub TEXT,
    p_suggested_email CITEXT,
    p_full_name TEXT,
    p_locale TEXT,
    p_time_zone TEXT,
    p_refresh_token TEXT
)
RETURNS TEXT AS $$
DECLARE
    v_token TEXT := encode(gen_random_bytes(32), 'hex');
BEGIN
    INSERT INTO external_sign_in (hash, sub, suggested_email, full_name, locale, time_zone, refresh_token)
    VALUES (digest(v_token, 'sha256'), p_sub, p_suggested_email, p_full_name, p_locale, p_time_zone, p_refresh_token);
    RETURN v_token;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION begin_external_sign_in(TEXT, CITEXT, TEXT, TEXT, TEXT, TEXT) IS
'Someone the provider let in is unknown here by their provider id:
keeps what the provider said (external_sign_in) and returns the token for
the browser''s cookie. They confirm their email next.';


CREATE OR REPLACE FUNCTION send_external_email(p_browser TEXT, p_email CITEXT)
RETURNS TEXT AS $$
DECLARE
    v_sends INT;
    v_token TEXT;
BEGIN
    SELECT sends INTO v_sends FROM external_sign_in
     WHERE hash = digest(p_browser, 'sha256') AND created_at > NOW() - INTERVAL '1 hour'
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'sign-in through the provider is unknown or expired'
            USING HINT = 'sso_failed';
    END IF;
    -- As many as sign-in links: a mailbox cannot be flooded, from one
    -- sign-in or from many.
    IF v_sends >= 5 OR (SELECT count(*) FROM external_sign_in
                         WHERE email = p_email AND sent_at > NOW() - INTERVAL '15 minutes') >= 5 THEN
        RAISE EXCEPTION 'too many links to %', p_email
            USING HINT = 'too_many_requests';
    END IF;

    v_token := encode(gen_random_bytes(32), 'hex');
    UPDATE external_sign_in
       SET email = p_email, email_hash = digest(v_token, 'sha256'), sends = sends + 1, sent_at = NOW()
     WHERE hash = digest(p_browser, 'sha256');
    RETURN v_token;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION send_external_email(TEXT, CITEXT) IS
'The person typed their email: returns the token of a link to it (sent
by email only, never through notification). A new link voids the one
before. sso_failed — the sign-in is unknown or over an hour old;
too_many_requests — 5 links from it already, or 5 to that address in 15
minutes. The application checks the address''s domain.';


CREATE OR REPLACE FUNCTION confirm_external_email(p_browser TEXT, p_token TEXT)
RETURNS TEXT AS $$
DECLARE
    r external_sign_in;
    v_id INT;
BEGIN
    SELECT * INTO r FROM external_sign_in
     WHERE email_hash = digest(p_token, 'sha256') AND created_at > NOW() - INTERVAL '1 hour'
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'email token is unknown, replaced or expired'
            USING HINT = 'invalid_token';
    END IF;
    IF p_browser IS NULL OR r.hash <> digest(p_browser, 'sha256') THEN
        RAISE EXCEPTION 'the link is opened outside the browser that signed in'
            USING HINT = 'sso_other_browser';
    END IF;
    -- Two tabs following the link at once must not create two people.
    PERFORM pg_advisory_xact_lock(hashtext('yartt.sso'), hashtext(r.sub));

    SELECT e.id INTO v_id
      FROM employee e JOIN human h ON h.employee_id = e.id
     WHERE e.email = r.email AND e.dismissed_at IS NULL;
    IF v_id IS NULL THEN
        IF EXISTS (SELECT 1 FROM employee WHERE email = r.email AND kind = 'human') THEN
            RAISE EXCEPTION 'employee with email % is dismissed', r.email
                USING HINT = 'dismissed';
        END IF;
        INSERT INTO employee (email, full_name, locale, time_zone)
        VALUES (r.email, r.full_name, r.locale, r.time_zone)
        RETURNING id INTO v_id;
        INSERT INTO human (employee_id) VALUES (v_id);
    END IF;

    -- One person per provider account: whoever held it lets go.
    UPDATE human SET external_id = NULL WHERE external_id = r.sub AND employee_id <> v_id;
    UPDATE human
       SET external_id = r.sub,
           idp_refresh_token = COALESCE(r.refresh_token, idp_refresh_token),
           idp_checked_at = NOW(),
           idp_blocked_at = NULL
     WHERE employee_id = v_id;
    DELETE FROM external_sign_in WHERE sub = r.sub;
    RETURN start_session(v_id);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION confirm_external_email(TEXT, TEXT) IS
'The link from send_external_email(), opened in the browser that signed
in (p_browser — its cookie): returns a session token. The working
employee with that email — invited, imported, or someone whose provider
account is new — is the person, and is known by the provider id from now
on; with nobody working at that address someone new is created, and a
dismissed one is refused (dismissed). invalid_token — unknown, replaced
or over an hour old; sso_other_browser — opened elsewhere, so a forwarded
link binds nobody''s account to the provider account of whoever asked.';


CREATE OR REPLACE FUNCTION idp_refused(p_employee_id INT)
RETURNS VOID AS $$
BEGIN
    UPDATE human SET idp_blocked_at = NOW(), idp_refresh_token = NULL WHERE employee_id = p_employee_id;
    DELETE FROM session WHERE employee_id = p_employee_id;
    DELETE FROM token WHERE employee_id = p_employee_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION idp_refused(INT) IS
'The identity provider no longer lets the person in (the idp_check cron):
their sessions and links end and their bots stop (authenticate_bot). Not
a dismissal — their manager decides that; My team shows it.';


CREATE OR REPLACE FUNCTION authenticate(p_session TEXT, p_lifetime INTERVAL DEFAULT NULL)
RETURNS INT AS $$
DECLARE
    v_employee_id INT;
BEGIN
    UPDATE session SET last_seen_at = NOW()
     WHERE hash = digest(p_session, 'sha256')
       AND last_seen_at < NOW() - INTERVAL '5 minutes'
       AND last_seen_at > NOW() - INTERVAL '30 days';

    SELECT employee_id INTO v_employee_id FROM session
     WHERE hash = digest(p_session, 'sha256')
       AND last_seen_at > NOW() - INTERVAL '30 days'
       AND (p_lifetime IS NULL OR created_at > NOW() - p_lifetime);
    RETURN v_employee_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION authenticate(TEXT, INTERVAL) IS
'Employee id for a cookie token, or NULL. Extends the session
(last_seen_at is written at most once every 5 minutes). p_lifetime — how
long a session lives from sign-in whatever the activity (a day with the
identity provider); NULL — only the 30 days of inactivity.';


-- ----------------------------------------------------------------------------
-- bots
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION new_bot_key()
RETURNS TEXT AS $$
    SELECT 'yartt_' || encode(gen_random_bytes(32), 'hex')
$$ LANGUAGE sql VOLATILE;

COMMENT ON FUNCTION new_bot_key() IS
'A fresh bot key: yartt_ and 32 random bytes in hex. Only its hash is kept.';


CREATE OR REPLACE FUNCTION create_bot(p_actor_id INT, p_full_name TEXT)
RETURNS TABLE (bot_id INT, key TEXT) AS $$
DECLARE
    v_id INT;
    v_key TEXT := new_bot_key();
BEGIN
    INSERT INTO employee (kind, full_name, manager_id, locale, time_zone)
    SELECT 'bot', btrim(p_full_name), e.id, e.locale, e.time_zone
      FROM employee e
     WHERE e.id = p_actor_id AND e.kind = 'human' AND e.dismissed_at IS NULL
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'employee % is unknown, dismissed or a bot', p_actor_id
            USING HINT = 'forbidden';
    END IF;
    INSERT INTO bot (employee_id, key_hash) VALUES (v_id, digest(v_key, 'sha256'));
    RETURN QUERY SELECT v_id, v_key;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_bot(INT, TEXT) IS
'A person creates a bot under themselves: its manager, its language and
time zone are theirs, it may change nothing yet (no permissions) and has
no webhook. Returns its id and key — the only time the key is seen.';


CREATE OR REPLACE FUNCTION check_bot_manager(p_bot_id INT, p_actor_id INT)
RETURNS VOID AS $$
DECLARE
    v_manager_id INT;
BEGIN
    SELECT manager_id INTO v_manager_id FROM employee
     WHERE id = p_bot_id AND kind = 'bot' AND dismissed_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'bot % is unknown or dismissed', p_bot_id
            USING HINT = 'not_found';
    END IF;
    IF v_manager_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION 'only the direct manager runs bot %', p_bot_id
            USING HINT = 'not_manager',
                  DETAIL = json_build_object('employeeId', p_bot_id)::text;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION check_bot_manager(INT, INT) IS
'Raises not_found for an unknown or dismissed bot and not_manager unless
p_actor_id is its direct manager — the only one who changes it.';


CREATE OR REPLACE FUNCTION reset_bot_key(p_bot_id INT, p_actor_id INT)
RETURNS TEXT AS $$
DECLARE
    v_key TEXT := new_bot_key();
BEGIN
    PERFORM check_bot_manager(p_bot_id, p_actor_id);
    UPDATE bot SET key_hash = digest(v_key, 'sha256'), key_issued_at = NOW()
     WHERE employee_id = p_bot_id;
    RETURN v_key;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reset_bot_key(INT, INT) IS
'The direct manager replaces the bot''s key: the old one stops at once,
the new one is returned — the only time it is seen.';


CREATE OR REPLACE FUNCTION transfer_bot(p_bot_id INT, p_actor_id INT, p_to_id INT)
RETURNS VOID AS $$
BEGIN
    PERFORM check_bot_manager(p_bot_id, p_actor_id);
    IF NOT EXISTS (SELECT 1 FROM employee WHERE id = p_to_id AND kind = 'human' AND dismissed_at IS NULL) THEN
        RAISE EXCEPTION 'employee % is unknown, dismissed or a bot', p_to_id
            USING HINT = 'not_found';
    END IF;
    UPDATE employee SET manager_id = p_to_id WHERE id = p_bot_id;
    UPDATE bot SET key_hash = digest(new_bot_key(), 'sha256'), key_issued_at = NOW()
     WHERE employee_id = p_bot_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION transfer_bot(INT, INT, INT) IS
'The direct manager hands the bot to another person, at once, without
their consent — like tasks of someone dismissed. The new manager is
notified (new_report) and sees its tasks; the key is replaced with one
nobody knows, so the new manager issues the next (reset_bot_key()).';


CREATE OR REPLACE FUNCTION authenticate_bot(p_key TEXT)
RETURNS INT AS $$
    SELECT b.employee_id
      FROM bot b
      JOIN employee e ON e.id = b.employee_id
      JOIN human m ON m.employee_id = e.manager_id
     WHERE b.key_hash = digest(p_key, 'sha256') AND e.dismissed_at IS NULL AND m.idp_blocked_at IS NULL
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION authenticate_bot(TEXT) IS
'The bot a key belongs to, or NULL (unknown, replaced, the bot dismissed,
or its manager refused by the identity provider — whoever runs a bot must
be someone the company still lets in).';


CREATE OR REPLACE FUNCTION count_bot_request(p_bot_id INT, p_refused BOOLEAN)
RETURNS VOID AS $$
    INSERT INTO bot_usage (bot_id, day, requests, refused, last_request_at)
    VALUES (p_bot_id, local_today(p_bot_id), 1, p_refused::int, NOW())
    ON CONFLICT (bot_id, day) DO UPDATE
       SET requests = bot_usage.requests + 1,
           refused = bot_usage.refused + EXCLUDED.refused,
           last_request_at = EXCLUDED.last_request_at
$$ LANGUAGE sql;

COMMENT ON FUNCTION count_bot_request(INT, BOOLEAN) IS
'Counts one API call of the bot today; p_refused — refused for lack of
permission or access.';


CREATE OR REPLACE FUNCTION count_bot_delivery(p_bot_id INT, p_failed BOOLEAN)
RETURNS VOID AS $$
    INSERT INTO bot_usage (bot_id, day, deliveries, failed_deliveries)
    VALUES (p_bot_id, local_today(p_bot_id), 1, p_failed::int)
    ON CONFLICT (bot_id, day) DO UPDATE
       SET deliveries = bot_usage.deliveries + 1,
           failed_deliveries = bot_usage.failed_deliveries + EXCLUDED.failed_deliveries
$$ LANGUAGE sql;

COMMENT ON FUNCTION count_bot_delivery(INT, BOOLEAN) IS
'Counts one attempt to post a notification to the bot''s webhook today.';


CREATE OR REPLACE FUNCTION send_bot_key_reminders()
RETURNS INT AS $$
DECLARE
    v_bot RECORD;
    v_sent INT := 0;
BEGIN
    FOR v_bot IN
        SELECT b.employee_id, e.manager_id, b.key_issued_at
          FROM bot b JOIN employee e ON e.id = b.employee_id
         WHERE e.dismissed_at IS NULL
           AND b.key_issued_at <= NOW() - INTERVAL '1 year'
           AND (b.key_reminded_at IS NULL OR b.key_reminded_at < b.key_issued_at
                OR b.key_reminded_at <= NOW() - INTERVAL '1 year')
           FOR UPDATE OF b SKIP LOCKED
    LOOP
        UPDATE bot SET key_reminded_at = NOW() WHERE employee_id = v_bot.employee_id;
        PERFORM notify(v_bot.manager_id, NULL, jsonb_build_object(
            'kind', 'bot_key_old', 'employeeId', v_bot.employee_id,
            'issuedAt', to_char(v_bot.key_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
        v_sent := v_sent + 1;
    END LOOP;
    RETURN v_sent;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION send_bot_key_reminders() IS
'Cron, every day: the manager of a working bot whose key is a year old or
more is told so (bot_key_old), once a year of its age. Nothing stops: the
key works until the manager replaces it. Safe with several workers.';


-- ----------------------------------------------------------------------------
-- dismiss_employee — dismissal
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dismiss_employee(p_employee_id INT, p_actor_id INT)
RETURNS VOID AS $$
DECLARE
    v_dismissed_at TIMESTAMPTZ;
    v_manager_id INT;
    v_task_id INT;
BEGIN
    SELECT dismissed_at, manager_id INTO v_dismissed_at, v_manager_id
      FROM employee WHERE id = p_employee_id
       FOR UPDATE;

    IF NOT FOUND OR v_dismissed_at IS NOT NULL THEN
        RAISE EXCEPTION 'employee % is unknown or already dismissed', p_employee_id
            USING HINT = 'not_found';
    END IF;
    IF v_manager_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION 'only the direct manager can dismiss employee %', p_employee_id
            USING HINT = 'not_manager',
                  DETAIL = json_build_object('employeeId', p_employee_id)::text;
    END IF;

    -- The direct manager is the heir: they are active, they are acting.
    PERFORM set_config('yartt.actor', p_actor_id::text, TRUE);
    FOR v_task_id IN
        UPDATE task SET owner_id = v_manager_id
         WHERE owner_id = p_employee_id
        RETURNING id
    LOOP
        PERFORM notify(v_manager_id, v_task_id, jsonb_build_object(
            'kind', 'owner_change', 'from', p_employee_id));
    END LOOP;

    -- The leaver knew their bots' keys: the bots move on with keys nobody knows.
    UPDATE bot SET key_hash = digest(new_bot_key(), 'sha256'), key_issued_at = NOW()
     WHERE employee_id IN (SELECT id FROM employee WHERE manager_id = p_employee_id AND kind = 'bot');
    -- In a ring the dismissing manager may be a report too: they are left without one.
    UPDATE employee SET manager_id = NULLIF(v_manager_id, id) WHERE manager_id = p_employee_id;

    UPDATE employee SET dismissed_at = NOW() WHERE id = p_employee_id;
    UPDATE human SET next_day = NULL WHERE employee_id = p_employee_id;

    DELETE FROM token WHERE employee_id = p_employee_id;
    DELETE FROM session WHERE employee_id = p_employee_id;
    DELETE FROM remind WHERE employee_id = p_employee_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION dismiss_employee(INT, INT) IS
'Dismisses an employee. Only the direct manager (p_actor_id) can do it;
an employee without a manager cannot be dismissed.
  1. All tasks (open and closed — a closed one can be reopened) go to the
     manager with a notification.
  2. Reports move to the manager (who is notified: new_report); the keys
     of their bots are replaced with ones nobody knows. In a ring
     (decision 90) the manager may be one of them: they are left
     without a manager.
  3. dismissed_at = NOW() — signing in is impossible. The email and
     manager_id are kept, so the same manager can bring the employee back
     as they were.
  4. Sessions, magic tokens and reminders are deleted; a dismissed bot''s
     key stops working (authenticate_bot).
History (scores, time entries, comments) is kept.';


-- ----------------------------------------------------------------------------
-- dismiss_with_heir — the installation administrator dismisses anyone
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dismiss_with_heir(p_employee_id INT, p_heir_id INT)
RETURNS VOID AS $$
DECLARE
    v_manager_id INT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('yartt.hierarchy'));
    SELECT manager_id INTO v_manager_id FROM employee WHERE id = p_employee_id AND dismissed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee % is unknown or already dismissed', p_employee_id
            USING HINT = 'not_found';
    END IF;
    IF p_heir_id = p_employee_id OR NOT EXISTS (SELECT 1 FROM employee WHERE id = p_heir_id AND dismissed_at IS NULL) THEN
        RAISE EXCEPTION 'heir % is unknown, dismissed or the employee themselves', p_heir_id
            USING HINT = 'not_found';
    END IF;

    -- An heir from the employee's own subtree steps out of it first: their place is above.
    -- Already the employee's manager (a ring, decision 90), they have it.
    IF p_heir_id IN (SELECT subordinates(p_employee_id)) AND v_manager_id IS DISTINCT FROM p_heir_id THEN
        UPDATE employee SET manager_id = v_manager_id WHERE id = p_heir_id;
    END IF;
    UPDATE employee SET manager_id = p_heir_id WHERE id = p_employee_id;
    PERFORM dismiss_employee(p_employee_id, p_heir_id);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION dismiss_with_heir(INT, INT) IS
'For the installation administrator (server/admin.ts), not the API: the
way to dismiss someone who will not hand over — in particular someone at
the top, whom nobody in the product can dismiss. The heir becomes the
employee''s manager and dismisses them (dismiss_employee): the tasks and
the team, dismissed reports included, go to the heir, the only one who
can bring the employee back. An heir from the employee''s own subtree
first leaves it for the employee''s place (under their manager, or at
the top): otherwise they would stay in a ring with the team they take
over.';


CREATE OR REPLACE FUNCTION restore_employee(p_employee_id INT, p_actor_id INT, p_email CITEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_dismissed_at TIMESTAMPTZ;
    v_manager_id INT;
BEGIN
    SELECT dismissed_at, manager_id INTO v_dismissed_at, v_manager_id
      FROM employee WHERE id = p_employee_id
       FOR UPDATE;

    IF NOT FOUND OR v_dismissed_at IS NULL THEN
        RAISE EXCEPTION 'employee % is unknown or not dismissed', p_employee_id
            USING HINT = 'not_found';
    END IF;
    IF v_manager_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION 'only the direct manager can bring back employee %', p_employee_id
            USING HINT = 'not_manager',
                  DETAIL = json_build_object('employeeId', p_employee_id)::text;
    END IF;

    UPDATE employee SET email = COALESCE(p_email, email), dismissed_at = NULL WHERE id = p_employee_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION restore_employee(INT, INT, CITEXT) IS
'Brings a dismissed employee back under the same manager, with the email
they had — or p_email, when the address changed or someone working holds
it now (uq_employee_email). Only their direct manager (p_actor_id) can do it: the one at the
time of dismissal, or the manager above when that one left too. Moving to
another manager is then the employee''s own choice (manager_id is theirs
to set), never the manager''s. History was kept; tasks and reports that
were handed over stay where they went.';


-- ----------------------------------------------------------------------------
-- task access
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_owner(p_task_id INT, p_actor_id INT)
RETURNS VOID AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM task WHERE id = p_task_id) THEN
        RAISE EXCEPTION 'task % not found', p_task_id
            USING HINT = 'not_found';
    END IF;
    IF p_actor_id IS DISTINCT FROM (SELECT owner_id FROM task WHERE id = p_task_id) THEN
        RAISE EXCEPTION 'only the owner of task % can do this', p_task_id
            USING HINT = 'forbidden';
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION check_owner(INT, INT) IS
'Raises not_found for an unknown task and forbidden unless p_actor_id owns it.';


CREATE OR REPLACE FUNCTION add_observer(
    p_task_id INT,
    p_employee_id INT,
    p_actor_id INT
)
RETURNS VOID AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM task WHERE id = p_task_id) THEN
        RAISE EXCEPTION 'task % not found', p_task_id
            USING HINT = 'not_found';
    END IF;
    IF is_public(p_task_id) THEN
        RAISE EXCEPTION 'task % is public', p_task_id
            USING HINT = 'task_public',
                  DETAIL = json_build_object('taskId', p_task_id)::text;
    END IF;
    -- Like a copy in an email: anyone in the task brings someone in; the owner removes.
    IF NOT is_observer(p_task_id, p_actor_id) THEN
        RAISE EXCEPTION 'only participants of task % add participants', p_task_id
            USING HINT = 'forbidden';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM employee WHERE id = p_employee_id AND dismissed_at IS NULL) THEN
        RAISE EXCEPTION 'employee % is unknown or dismissed', p_employee_id
            USING HINT = 'not_found';
    END IF;
    IF is_observer(p_task_id, p_employee_id) THEN
        RETURN;
    END IF;

    PERFORM grant_observer(p_task_id, p_employee_id, p_actor_id);
    PERFORM notify(p_employee_id, p_task_id, jsonb_build_object(
        'kind', 'access_opened', 'by', p_actor_id));
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION add_observer(INT, INT, INT) IS
'A participant (active observer — the owner among them) adds an observer
to a private task, or brings a former one back, the way a copy is added
to an email: whoever needs someone in brings them in, and the owner
removes whoever came in by mistake (remove_observer). Access is active at
once, a pending request is approved, and the employee is notified
(access_opened, by — who added them). A public task has no observers:
make it private first.';


CREATE OR REPLACE FUNCTION remove_observer(
    p_task_id INT,
    p_employee_id INT,
    p_actor_id INT
)
RETURNS VOID AS $$
BEGIN
    PERFORM check_owner(p_task_id, p_actor_id);

    UPDATE observer
       SET deleted_at = NOW(),
           deleted_by = p_actor_id
     WHERE task_id = p_task_id
       AND value = p_employee_id
       AND added_at IS NOT NULL
       AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee % is not an observer of task %', p_employee_id, p_task_id
            USING HINT = 'not_observer',
                  DETAIL = json_build_object('employeeId', p_employee_id, 'taskId', p_task_id)::text;
    END IF;

    PERFORM notify(p_employee_id, p_task_id, jsonb_build_object(
        'kind', 'access_closed', 'by', p_actor_id));
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION remove_observer(INT, INT, INT) IS
'The owner removes ("hides") an observer, who is notified (access_closed).
The owner and a manager of an observing report cannot be removed
(observer_leave).';


CREATE OR REPLACE FUNCTION leave_task(p_task_id INT, p_employee_id INT)
RETURNS VOID AS $$
BEGIN
    UPDATE observer
       SET deleted_at = NOW(),
           deleted_by = p_employee_id
     WHERE task_id = p_task_id
       AND value = p_employee_id
       AND added_at IS NOT NULL
       AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee % is not an observer of task %', p_employee_id, p_task_id
            USING HINT = 'not_observer',
                  DETAIL = json_build_object('employeeId', p_employee_id, 'taskId', p_task_id)::text;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION leave_task(INT, INT) IS
'An observer leaves a task. The owner and a manager of an observing report
cannot (observer_leave). Nobody is notified.';


CREATE OR REPLACE FUNCTION request_access(
    p_task_id INT,
    p_employee_id INT
)
RETURNS VOID AS $$
DECLARE
    v_owner_id INT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM task WHERE id = p_task_id) THEN
        RAISE EXCEPTION 'task % not found', p_task_id
            USING HINT = 'not_found';
    END IF;
    IF is_public(p_task_id) THEN
        RAISE EXCEPTION 'task % is public', p_task_id
            USING HINT = 'task_public',
                  DETAIL = json_build_object('taskId', p_task_id)::text;
    END IF;
    IF EXISTS (
        SELECT 1 FROM observer
         WHERE task_id = p_task_id
           AND value = p_employee_id
           AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'employee % already has access or a pending request to task %',
            p_employee_id, p_task_id
            USING HINT = 'already_observer',
                  DETAIL = json_build_object('employeeId', p_employee_id, 'taskId', p_task_id)::text;
    END IF;

    INSERT INTO observer (task_id, value, added_by, added_at)
    VALUES (p_task_id, p_employee_id, NULL, NULL);

    SELECT owner_id INTO v_owner_id FROM task WHERE id = p_task_id;
    IF v_owner_id IS NOT NULL THEN
        PERFORM notify(v_owner_id, p_task_id, jsonb_build_object(
            'kind', 'access_request', 'employeeId', p_employee_id));
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION request_access(INT, INT) IS
'An employee requests access to a private task: added_by = NULL,
added_at = NULL. The owner is notified and calls approve_access or
reject_access.';


CREATE OR REPLACE FUNCTION withdraw_access(p_task_id INT, p_employee_id INT)
RETURNS VOID AS $$
BEGIN
    UPDATE observer
       SET deleted_at = NOW(),
           deleted_by = p_employee_id
     WHERE task_id = p_task_id
       AND value = p_employee_id
       AND added_at IS NULL
       AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no pending request from % to task %', p_employee_id, p_task_id
            USING HINT = 'no_pending_request',
                  DETAIL = json_build_object('employeeId', p_employee_id, 'taskId', p_task_id)::text;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION withdraw_access(INT, INT) IS
'The requester withdraws their own pending request.';


CREATE OR REPLACE FUNCTION approve_access(
    p_task_id INT,
    p_employee_id INT,
    p_actor_id INT
)
RETURNS VOID AS $$
BEGIN
    PERFORM check_owner(p_task_id, p_actor_id);

    UPDATE observer
       SET added_at = NOW(),
           added_by = p_actor_id
     WHERE task_id = p_task_id
       AND value = p_employee_id
       AND added_at IS NULL
       AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no pending request from % to task %', p_employee_id, p_task_id
            USING HINT = 'no_pending_request',
                  DETAIL = json_build_object('employeeId', p_employee_id, 'taskId', p_task_id)::text;
    END IF;

    PERFORM notify(p_employee_id, p_task_id, jsonb_build_object(
        'kind', 'access_opened', 'by', p_actor_id));
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION approve_access(INT, INT, INT) IS
'The owner approves a request: added_at = NOW(), added_by = the owner.
The requester is notified (access_opened).';


CREATE OR REPLACE FUNCTION reject_access(
    p_task_id INT,
    p_employee_id INT,
    p_actor_id INT
)
RETURNS VOID AS $$
BEGIN
    PERFORM check_owner(p_task_id, p_actor_id);

    UPDATE observer
       SET deleted_at = NOW(),
           deleted_by = p_actor_id
     WHERE task_id = p_task_id
       AND value = p_employee_id
       AND added_at IS NULL
       AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no pending request from % to task %', p_employee_id, p_task_id
            USING HINT = 'no_pending_request',
                  DETAIL = json_build_object('employeeId', p_employee_id, 'taskId', p_task_id)::text;
    END IF;

    PERFORM notify(p_employee_id, p_task_id, jsonb_build_object(
        'kind', 'access_closed', 'by', p_actor_id));
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reject_access(INT, INT, INT) IS
'The owner rejects a request: deleted_at = NOW(), deleted_by = the owner.
The requester is notified (access_closed).';


CREATE OR REPLACE FUNCTION make_public(p_task_id INT, p_actor_id INT)
RETURNS VOID AS $$
DECLARE
    v_employee_id INT;
BEGIN
    PERFORM check_owner(p_task_id, p_actor_id);

    PERFORM set_config('yartt.public_task', p_task_id::text, TRUE);
    UPDATE observer
       SET deleted_at = NOW(),
           deleted_by = p_actor_id
     WHERE task_id = p_task_id
       AND added_at IS NOT NULL
       AND deleted_at IS NULL;
    PERFORM set_config('yartt.public_task', '', TRUE);

    -- Waiting requests are answered: everyone sees the task now.
    FOR v_employee_id IN
        UPDATE observer
           SET deleted_at = NOW(),
               deleted_by = p_actor_id
         WHERE task_id = p_task_id
           AND added_at IS NULL
           AND deleted_at IS NULL
        RETURNING value
    LOOP
        PERFORM notify(v_employee_id, p_task_id, jsonb_build_object(
            'kind', 'access_opened', 'by', p_actor_id));
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION make_public(INT, INT) IS
'The owner makes a task public: every observer row is closed (their time
left and reminders stay — they still see the task), waiting requesters
are notified that the task is open (access_opened).';


CREATE OR REPLACE FUNCTION make_private(p_task_id INT, p_actor_id INT)
RETURNS INT[] AS $$
DECLARE
    v_employee_id INT;
    v_left_out INT[] := '{}';
BEGIN
    PERFORM check_owner(p_task_id, p_actor_id);
    IF NOT is_public(p_task_id) THEN
        RETURN v_left_out;
    END IF;

    -- The owner first: their managers follow (observer_add_manager).
    PERFORM grant_observer(p_task_id, p_actor_id, NULL);

    FOR v_employee_id IN
        SELECT DISTINCT m.value
          FROM mention m JOIN employee e ON e.id = m.value
         WHERE m.task_id = p_task_id
           AND m.closed_at IS NULL
           AND e.dismissed_at IS NULL
    LOOP
        PERFORM grant_observer(p_task_id, v_employee_id, NULL);
    END LOOP;

    FOR v_employee_id IN
        SELECT DISTINCT c.created_by
          FROM comment c JOIN employee e ON e.id = c.created_by
         WHERE c.task_id = p_task_id
           AND e.dismissed_at IS NULL
           AND NOT is_observer(p_task_id, c.created_by)
         ORDER BY c.created_by
    LOOP
        v_left_out := v_left_out || v_employee_id;
        PERFORM notify(v_employee_id, p_task_id, jsonb_build_object(
            'kind', 'access_closed', 'by', p_actor_id));
    END LOOP;

    RETURN v_left_out;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION make_private(INT, INT) IS
'The owner makes a public task private. Stay: the owner, their managers
and everyone with an open mention (and their managers). Those who
commented and are not among them are notified (access_closed) and
returned, so the interface can offer to bring them back
(add_observer). A private task is left as it is.';


CREATE OR REPLACE FUNCTION mark_reviewed(p_task_id INT, p_actor_id INT, p_until TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
    PERFORM check_owner(p_task_id, p_actor_id);
    -- Handed over and not accepted yet: accepting takes away the handover only.
    UPDATE task SET reviewed_at = handed_at
     WHERE id = p_task_id AND reviewed_at IS NULL AND handed_at IS NOT NULL;
    IF FOUND THEN
        RETURN;
    END IF;
    -- Up to what was shown, never past now, never back (GREATEST skips NULLs).
    -- The moment shown comes in milliseconds: it covers its whole millisecond.
    UPDATE task
       SET reviewed_at = GREATEST(reviewed_at, handed_at,
                                  LEAST(COALESCE(p_until + INTERVAL '999 microseconds', NOW()), NOW()))
     WHERE id = p_task_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION mark_reviewed(INT, INT, TIMESTAMPTZ) IS
'"No intervention needed": the owner confirms that nothing in the task
waits for their decision. reviewed_at goes to p_until — the newest notice
of the review they were shown — so whatever came later stays (decision
94); NULL — now. Never later than now, never back. Access requests do
not hold it up: they are a group of their own, answered apart, and stay.
A task handed over and not accepted yet (reviewed_at NULL, handed_at
set) is accepted instead: reviewed_at goes to handed_at, whatever
p_until. It never closes the task — that is close_task() (decision 93).';


CREATE OR REPLACE FUNCTION close_task(p_task_id INT, p_actor_id INT)
RETURNS VOID AS $$
DECLARE
    v_plans INT;
    r RECORD;
BEGIN
    PERFORM check_owner(p_task_id, p_actor_id);
    IF EXISTS (SELECT 1 FROM finished_at
                WHERE task_id = p_task_id AND expired_at IS NULL AND confirmed_at IS NOT NULL) THEN
        RETURN;
    END IF;
    -- Work still planned is not done: whoever planned it clears it first.
    SELECT count(*) INTO v_plans FROM estimate_minutes WHERE task_id = p_task_id AND expired_at IS NULL;
    IF v_plans > 0 THEN
        RAISE EXCEPTION 'task % has % plans left', p_task_id, v_plans
            USING HINT = 'plans_left',
                  DETAIL = json_build_object('taskId', p_task_id, 'count', v_plans)::text;
    END IF;

    -- An overdue task is closed at the deadline it missed, so that stays
    -- visible; any other one now.
    IF NOT EXISTS (SELECT 1 FROM finished_at
                    WHERE task_id = p_task_id AND expired_at IS NULL AND value <= NOW()) THEN
        PERFORM change_deadline(p_task_id, NOW());
    END IF;
    UPDATE finished_at SET confirmed_at = NOW() WHERE task_id = p_task_id AND expired_at IS NULL;

    -- Closed: done for what waits for it, whose owners hear it.
    FOR r IN
        UPDATE dependency d SET done_at = NOW()
          FROM task t
         WHERE d.value = p_task_id AND t.id = d.task_id AND d.done_at IS NULL
        RETURNING d.task_id, t.owner_id
    LOOP
        IF r.owner_id IS NOT NULL AND r.owner_id <> p_actor_id THEN
            PERFORM notify(r.owner_id, r.task_id, jsonb_build_object(
                'kind', 'dependency_done', 'dependencyId', p_task_id));
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION close_task(INT, INT) IS
'The owner closes the task (decision 93) — the only way a task closes.
An overdue one (its deadline passed) is closed at that deadline, so
closing late stays visible (confirmed_at later than value); any other
one gets the deadline now, closed at once. Refused while someone still
has time planned on it (plans_left — whoever planned it clears it). The
tasks waiting for it are done for from then on (dependency.done_at),
their owners notified (dependency_done). A closed task is left as it is.';


-- ----------------------------------------------------------------------------
-- deadlines
-- ----------------------------------------------------------------------------
-- send_weekly_digests — Monday morning email for managers
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION send_weekly_digests(p_now TIMESTAMPTZ DEFAULT NOW())
RETURNS INT AS $$
DECLARE
    v_manager RECORD;
    v_unscored INT;
    v_overdue INT;
    v_at_risk INT;
    v_blocked INT;
    v_sent INT := 0;
BEGIN
    FOR v_manager IN
        SELECT e.id, e.time_zone FROM employee e JOIN human h ON h.employee_id = e.id
         WHERE e.dismissed_at IS NULL
           AND EXISTS (SELECT 1 FROM employee r
                        WHERE r.manager_id = e.id AND r.kind = 'human' AND r.dismissed_at IS NULL)
           AND extract(isodow FROM p_now AT TIME ZONE e.time_zone) = 1
           AND (p_now AT TIME ZONE e.time_zone)::time >= TIME '09:00'
           AND (h.weekly_digest_on IS NULL OR h.weekly_digest_on < (p_now AT TIME ZONE e.time_zone)::date)
         FOR UPDATE OF h SKIP LOCKED
    LOOP
        -- Days of direct reports (the last 30, today aside) with a closed shift and no standing score on it.
        SELECT count(DISTINCT (d.employee_id, d.day)) INTO v_unscored
          FROM shift_day d JOIN employee r ON r.id = d.employee_id
         WHERE r.manager_id = v_manager.id AND r.dismissed_at IS NULL AND d.closed
           AND d.day < (p_now AT TIME ZONE v_manager.time_zone)::date
           AND d.day >= (p_now AT TIME ZONE v_manager.time_zone)::date - 30
           AND NOT EXISTS (SELECT 1 FROM score s WHERE s.shift_id = d.shift_id AND s.value IS NOT NULL);
        -- Tasks of the team overdue now: the deadline passed and nobody closed them.
        SELECT count(*) INTO v_overdue
          FROM task k JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
         WHERE k.owner_id IN (SELECT subordinates(v_manager.id))
           AND f.value <= p_now AND f.confirmed_at IS NULL;
        SELECT count(*) INTO v_at_risk
          FROM task k
         WHERE k.owner_id IN (SELECT subordinates(v_manager.id))
           AND at_risk(k.id);
        -- Direct reports the identity provider no longer lets in, not dismissed yet.
        SELECT count(*) INTO v_blocked
          FROM employee r JOIN human h ON h.employee_id = r.id
         WHERE r.manager_id = v_manager.id AND r.dismissed_at IS NULL AND h.idp_blocked_at IS NOT NULL;

        UPDATE human SET weekly_digest_on = (p_now AT TIME ZONE v_manager.time_zone)::date WHERE employee_id = v_manager.id;
        -- Nothing to say, nothing sent: a quiet week needs no email.
        IF v_unscored + v_overdue + v_at_risk + v_blocked > 0 THEN
            INSERT INTO notification (employee_id, task_id, payload)
            VALUES (v_manager.id, NULL, jsonb_build_object(
                'kind', 'weekly_digest', 'unscored', v_unscored, 'overdue', v_overdue, 'atRisk', v_at_risk,
                'blocked', v_blocked));
            v_sent := v_sent + 1;
        END IF;
    END LOOP;
    RETURN v_sent;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION send_weekly_digests(TIMESTAMPTZ) IS
'Cron, every hour: on Monday from 09:00 in each manager''s time zone,
once a week, a summary of what waits for them — days of direct reports
with a shift waiting for a score (the last 30), tasks of the subtree overdue now,
tasks of the subtree at risk now, direct reports
the identity provider no longer lets in (to dismiss). Sent only if
something is there; not copied to anyone (it is about their own team).
Only for someone with people under them (bots do not count).
Safe with several workers (SKIP LOCKED, weekly_digest_on). p_now is the
moment to act as of — NOW() for the cron, a chosen Monday in tests.';


-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_dependents(p_task_id INT)
RETURNS VOID AS $$
DECLARE
    v_actor_id INT;
    v_dependent_id INT;
    v_owner_id INT;
BEGIN
    SELECT owner_id INTO v_actor_id FROM task WHERE id = p_task_id;

    FOR v_dependent_id, v_owner_id IN
        SELECT t.id, t.owner_id
          FROM dependency d JOIN task t ON t.id = d.task_id
         WHERE d.value = p_task_id
           AND t.owner_id IS NOT NULL
           AND t.owner_id IS DISTINCT FROM v_actor_id
    LOOP
        PERFORM notify(v_owner_id, v_dependent_id, jsonb_build_object(
            'kind', 'finished_at_change', 'dependencyId', p_task_id,
            'late', EXISTS (SELECT 1 FROM dependency_risk(v_dependent_id) r
                             WHERE r.task_id = v_dependent_id AND r.value = p_task_id)));
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION notify_dependents(INT) IS
'Notifies owners of the tasks that depend on p_task_id (except the owner
of p_task_id itself); late — the deadline is now later than the latest
one their task can live with, or gone.';


CREATE OR REPLACE FUNCTION deadline_settles()
RETURNS INTERVAL AS $$
    SELECT INTERVAL '1 minute';
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION deadline_settles() IS
'How long a deadline change stays a draft: another change within it
replaces it in the history (change_deadline()), and the owners of
dependent tasks are told only once it has passed without one (the worker
holds finished_at_change notifications this long).';


CREATE OR REPLACE FUNCTION change_deadline(p_task_id INT, p_value TIMESTAMPTZ)
RETURNS VOID AS $$
DECLARE
    v_entered_at TIMESTAMPTZ;
    v_changed BOOLEAN;
BEGIN
    -- The last change, made less than deadline_settles() ago, is undone:
    -- the new one replaces it, so of a person picking a date only the
    -- last pick stays.
    SELECT entered_at INTO v_entered_at FROM finished_at
     WHERE task_id = p_task_id AND expired_at IS NULL
       FOR UPDATE;
    IF FOUND THEN
        IF v_entered_at > NOW() - deadline_settles() THEN
            DELETE FROM finished_at WHERE task_id = p_task_id AND expired_at IS NULL;
            UPDATE finished_at SET expired_at = NULL
             WHERE task_id = p_task_id AND expired_at = v_entered_at;
        END IF;
    ELSE
        -- No deadline: the last change was a clear, the row closed last.
        UPDATE finished_at SET expired_at = NULL
         WHERE task_id = p_task_id
           AND expired_at > NOW() - deadline_settles()
           AND expired_at = (SELECT max(expired_at) FROM finished_at WHERE task_id = p_task_id);
    END IF;

    -- The change against what was there before: the same value is no change.
    IF p_value IS NULL THEN
        UPDATE finished_at SET expired_at = NOW()
         WHERE task_id = p_task_id AND expired_at IS NULL;
        v_changed := FOUND;
    ELSE
        v_changed := NOT EXISTS (SELECT 1 FROM finished_at
                                  WHERE task_id = p_task_id AND expired_at IS NULL AND value = p_value);
        IF v_changed THEN
            UPDATE finished_at SET expired_at = NOW()
             WHERE task_id = p_task_id AND expired_at IS NULL;
            INSERT INTO finished_at (task_id, value) VALUES (p_task_id, p_value);
        END IF;
    END IF;

    -- Told about the settled deadline only: what waits to be sent about the
    -- replaced change is dropped, and nothing is sent when it came back.
    DELETE FROM notification
     WHERE sent_at IS NULL
       AND added_at > NOW() - deadline_settles()
       AND payload->>'kind' = 'finished_at_change'
       AND payload->>'dependencyId' = p_task_id::text;
    IF v_changed THEN
        PERFORM notify_dependents(p_task_id);
        -- A new deadline is not closed: what waits for it waits again until
        -- its owner closes it (close_task()).
        UPDATE dependency SET done_at = NULL WHERE value = p_task_id AND done_at IS NOT NULL;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION change_deadline(INT, TIMESTAMPTZ) IS
'Sets, moves or (p_value NULL) clears the deadline. A change less than
deadline_settles() after the previous one replaces it: that row is
removed and the one before it reopened, then the new change is made — so
the history keeps the last decision, dated by it, and a value changed
back is no change at all. Owners of dependent tasks get one notification
for the settled deadline (notify_dependents(); unsent ones about the
replaced change are dropped). Any change opens a closed task again: the
new row is not confirmed, and the tasks waiting for it are not done for
any more (done_at cleared). Closing is close_task().';


CREATE OR REPLACE FUNCTION set_finished_at(p_task_id INT, p_value TIMESTAMPTZ)
RETURNS VOID AS $$
BEGIN
    PERFORM change_deadline(p_task_id, p_value);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION set_finished_at(INT, TIMESTAMPTZ) IS
'Sets or moves the deadline (later or earlier) — change_deadline().
Permissions — in the application. Never forbidden by dependencies: a
deadline later than one a dependent task can live with puts both at risk
(at_risk()).';


CREATE OR REPLACE FUNCTION clear_finished_at(p_task_id INT)
RETURNS VOID AS $$
BEGIN
    PERFORM change_deadline(p_task_id, NULL);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION clear_finished_at(INT) IS
'Clears the deadline — change_deadline(). Permissions — in the
application. Dependent tasks with a latest deadline for this one are then
at risk (at_risk()).';


-- ----------------------------------------------------------------------------
-- reminders
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION send_due_reminds()
RETURNS VOID AS $$
DECLARE
    r remind;
BEGIN
    FOR r IN
        UPDATE remind SET sent_at = NOW() WHERE at <= NOW() AND sent_at IS NULL RETURNING *
    LOOP
        PERFORM notify(r.employee_id, r.task_id, jsonb_build_object(
            'kind', 'remind', 'text', r.value));
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION send_due_reminds() IS
'Cron, every minute: due reminders -> notification, once (sent_at); the
reminder stays until its author removes or moves it.';


CREATE OR REPLACE FUNCTION keep_attachment(p_attachment_id INT, p_employee_id INT)
RETURNS VOID AS $$
BEGIN
    UPDATE attachment SET held_by = held_by || p_employee_id
     WHERE id = p_attachment_id AND value IS NOT NULL AND NOT held_by @> ARRAY[p_employee_id];
    IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM attachment WHERE id = p_attachment_id AND held_by @> ARRAY[p_employee_id]) THEN
        RAISE EXCEPTION 'attachment % has no content to keep', p_attachment_id
            USING HINT = 'file_purged';
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION keep_attachment(INT, INT) IS
'Someone keeps a file — one they see in a task (the application checks
that and the quota): it counts in their quota and stays while they hold
it, whoever else lets it go. Kept already — nothing changes.';


CREATE OR REPLACE FUNCTION release_attachment(p_attachment_id INT, p_employee_id INT)
RETURNS VOID AS $$
BEGIN
    UPDATE attachment SET held_by = array_remove(held_by, p_employee_id)
     WHERE id = p_attachment_id AND held_by @> ARRAY[p_employee_id];
    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee % does not hold attachment %', p_employee_id, p_attachment_id
            USING HINT = 'not_found';
    END IF;
    -- Nobody holds it any more: the content goes, the row and the links stay.
    UPDATE attachment SET value = NULL, purged_at = NOW()
     WHERE id = p_attachment_id AND cardinality(held_by) = 0;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION release_attachment(INT, INT) IS
'Someone lets a file they hold go, to free their quota. While anyone
else holds it, it stays as it is; let go by the last one, its content is
deleted. The row stays, and so do the comments that refer to it: their
link says the file is gone; the same bytes uploaded again bring it back.';


CREATE OR REPLACE FUNCTION can_see_tag_limit(p_limit_id INT, p_employee_id INT)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM tag_limit l
         WHERE l.id = p_limit_id
           AND (l.employee_id = p_employee_id
                OR l.employee_id IN (SELECT subordinates(p_employee_id))
                OR p_employee_id IN (SELECT subordinates(l.employee_id)))
    )
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION can_see_tag_limit(INT, INT) IS
'Whether the employee sees the tag limit: they set it, they manage (up the
chain) who set it, or it is set by a manager of theirs — it counts their
hours, so they keep to it. Other people''s limits are theirs alone.';
