-- 0.7 -> 0.8

-- The content of files leaves the attachment table for attachment_content
-- (decision 116), and in_storage goes: no row there and not purged means
-- the file is in the object storage. With an object storage the worker
-- moves the rows there and then drops the table; nothing in the schema
-- refers to it, the application does. The database no longer deletes
-- content itself: release_attachment says the file is purged, and the
-- application deletes its content wherever it is.
--
-- An object of a purged file still waiting for the worker of 0.7 to delete
-- it (in_storage with purged_at, minutes at most) stays in the bucket.

CREATE TABLE attachment_content (
    attachment_id INT PRIMARY KEY REFERENCES attachment(id) ON DELETE CASCADE,
    value BYTEA NOT NULL
);

COMMENT ON TABLE attachment_content IS
'The content of the files kept in PostgreSQL: a row per file that has
content and is not in the object storage. No row and not purged — the
file is the object attachments/<id> (decision 116).
With an object storage (S3_BUCKET) the worker moves the rows there, one
at a time, and when none is left it DROPS THIS TABLE: files never come
back from the storage, and nothing should stay to say they could. So on
such an installation the table does not exist, and everything that uses
it must allow for that:
  - no function, trigger or view of this schema refers to it, only the
    application, which checks that it exists;
  - a migration that touches it says IF EXISTS;
  - a tool that writes into this database directly (an import) puts the
    content into the object storage when the table is gone, and keeps to
    the triggers of the tables it writes.
Without the table the application refuses to start without S3_BUCKET:
the files would be unreadable.';

COMMENT ON COLUMN attachment_content.value IS
'The bytes of the file.';

INSERT INTO attachment_content (attachment_id, value)
SELECT id, value FROM attachment WHERE value IS NOT NULL;

ALTER TABLE attachment DROP CONSTRAINT chk_attachment_purged;
DROP INDEX idx_attachment_in_storage;
ALTER TABLE attachment DROP COLUMN value, DROP COLUMN in_storage;

DROP FUNCTION release_attachment(INT, INT);
CREATE FUNCTION release_attachment(p_attachment_id INT, p_employee_id INT)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE attachment SET held_by = array_remove(held_by, p_employee_id)
     WHERE id = p_attachment_id AND held_by @> ARRAY[p_employee_id];
    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee % does not hold attachment %', p_employee_id, p_attachment_id
            USING HINT = 'not_found';
    END IF;
    -- Nobody holds it any more: it is purged, the row and the links stay.
    UPDATE attachment SET purged_at = NOW()
     WHERE id = p_attachment_id AND cardinality(held_by) = 0;
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION release_attachment(INT, INT) IS
'Someone lets a file they hold go, to free their quota. While anyone
else holds it, it stays as it is; let go by the last one, it is purged
and TRUE is returned: the application then deletes its content, wherever
it is (attachment_content, decision 116), in the same transaction. The
row stays, and so do the comments that refer to it: their link says the
file is gone; the same bytes uploaded again bring it back.';

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
hash and size and compares the bytes when they are in attachment_content
(or finds one whose content was deleted); on a match it returns the existing id, puts the content back if
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
size, the names in comments — and the content goes (purged_at): a link
to it says the file is gone. Anyone uploading the same bytes again (the
same hash and size) restores it in place, so every link to it works again.

Where the content is (decisions 104, 116): a row of attachment_content,
or — with an object storage configured (S3_BUCKET) — its object
attachments/<id>. Nothing in the database knows more than that: the
application puts, reads and deletes the content, in the same transaction
as the row, so a failure of the storage changes nothing.';

COMMENT ON COLUMN attachment.purged_at IS
'When the content was deleted — the last holder let it go. NULL — the
content is there: a row of attachment_content, or the object.';

-- The specification (COMMENT ON SCHEMA) as of this version.
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
                     AND NOT attachment_in_use(a.id)
                   RETURNING id; and their content, wherever it is.
  - every minute, with an object storage: move the files of
                  attachment_content there; with none left, drop the table.
  - every day:    DELETE FROM visit WHERE at < NOW() - INTERVAL ''1 year'';
  - every day:    DELETE FROM sent_change WHERE at < NOW() - INTERVAL ''90 days'';
  - every day:    DELETE FROM bot_usage WHERE day < CURRENT_DATE - 366;
  - every hour:   ask the identity provider about people last checked a
                  day ago or more (human.idp_refresh_token); a refusal ->
                  SELECT idp_refused(employee_id).
  - every day:    SELECT send_bot_key_reminders();
  - every day:    DELETE FROM tag t
                   WHERE created_at < NOW() - INTERVAL ''1 day''
                     AND NOT EXISTS (SELECT 1 FROM task WHERE tag_ids @> ARRAY[t.id])
                     AND NOT EXISTS (SELECT 1 FROM user_tag WHERE tag_id = t.id)
                     AND NOT EXISTS (SELECT 1 FROM tag_description WHERE tag_id = t.id);
  - every day:    UPDATE human SET next_day = NULL
                   WHERE next_day <= local_today(employee_id);
';
