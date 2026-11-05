-- 0.6 -> 0.7

-- "Related" of a task (decision 107): the tasks its context mentions by
-- number are kept, and a number written in a comment mentions a task like
-- the button does. What was written before counts too; nobody is told of it.
-- A task closed first tells the owner of what it was waiting for.

CREATE TABLE context_mention (
    task_id INT NOT NULL REFERENCES task(id),
    value INT NOT NULL REFERENCES task(id),
    PRIMARY KEY (task_id, value),

    CONSTRAINT chk_context_mention_not_self CHECK (value <> task_id)
);
CREATE INDEX idx_context_mention_value ON context_mention(value);


COMMENT ON TABLE context_mention IS
'A task the context of another task mentions by number, if the owner sees
it. Replaced whenever the context is saved, so what the text no longer
mentions is gone. Nobody is notified: a context is edited many times. With
task_mention it feeds "Related" (decision 107).';

COMMENT ON COLUMN context_mention.task_id IS
'The task whose context it is.';

COMMENT ON COLUMN context_mention.value IS
'The task mentioned.';

INSERT INTO context_mention (task_id, value)
SELECT DISTINCT k.id, r.id
  FROM task k
 CROSS JOIN LATERAL regexp_matches(regexp_replace(regexp_replace(regexp_replace(regexp_replace(k.context, '<pre[^>]*>.*?</pre>', ' ', 'gi'), '<code[^>]*>.*?</code>', ' ', 'gi'), '<a[ >].*?</a>', ' ', 'gi'), '<[^>]+>', ' ', 'g'), '(?<![[:alnum:]_/#&])#([0-9]{1,9})(?![[:alnum:]_])', 'g') AS m
  JOIN task r ON r.id = m[1]::int
 WHERE k.context IS NOT NULL AND r.id <> k.id AND k.owner_id IS NOT NULL AND can_see(r.id, k.owner_id);

INSERT INTO task_mention (task_id, comment_id, value)
SELECT DISTINCT c.task_id, c.id, r.id
  FROM comment c
 CROSS JOIN LATERAL regexp_matches(regexp_replace(regexp_replace(regexp_replace(regexp_replace(c.value, '<pre[^>]*>.*?</pre>', ' ', 'gi'), '<code[^>]*>.*?</code>', ' ', 'gi'), '<a[ >].*?</a>', ' ', 'gi'), '<[^>]+>', ' ', 'g'), '(?<![[:alnum:]_/#&])#([0-9]{1,9})(?![[:alnum:]_])', 'g') AS m
  JOIN task r ON r.id = m[1]::int
 WHERE r.id <> c.task_id AND can_see(r.id, c.created_by)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE task_mention IS
'A task attached to a comment of another task, by the button or by its
number written in the text (the number only if the author sees that task).
idx_task_mention_value serves backlinks ("where this task is mentioned").
The owner of the attached task is notified (unless they wrote the
comment). With context_mention it feeds "Related" (decision 107).';

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

    -- Closed first: what it waited for may not be needed any more.
    PERFORM notify(v.owner_id, v.id, jsonb_build_object('kind', 'waiter_closed', 'dependentId', p_task_id))
       FROM dependency d
       JOIN task v ON v.id = d.value
       LEFT JOIN finished_at f ON f.task_id = v.id AND f.expired_at IS NULL
      WHERE d.task_id = p_task_id AND v.owner_id IS NOT NULL AND v.owner_id <> p_actor_id
        AND f.confirmed_at IS NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION close_task(INT, INT) IS
'The owner closes the task (decision 93) — the only way a task closes.
An overdue one (its deadline passed) is closed at that deadline, so
closing late stays visible (confirmed_at later than value); any other
one gets the deadline now, closed at once. Refused while someone still
has time planned on it (plans_left — whoever planned it clears it). The
tasks waiting for it are done for from then on (dependency.done_at),
their owners notified (dependency_done). A closed task is left as it is.
The owners of the open tasks it was waiting for are told too (waiter_closed).';

COMMENT ON TABLE dependency IS
'The dependency graph. task_id depends on value.
Linking binds nobody (decision 94): anyone who sees both tasks links them
— an existing task or a new one, made with it — and the
owners of both other than whoever added it are notified (waits_added,
dependency_added) and see it in their review. latest_at is the owner of
task_id''s alone; a dependency is removed by the owner of task_id or by
whoever added it. Checked by the application.
Cycles are forbidden (trigger). Self-dependency is forbidden (CHECK).
When finished_at of value is set, moved or cleared, owners of all
dependent tasks are notified.
The row outlives closing: waiting is shown while both tasks are open, after
that under "Related" on both (decisions 107, 113), and reopening brings it
back. A removed link moves to dependency_removed.';


COMMENT ON COLUMN notification.payload IS
'JSONB context. Contains kind:
  comment | mention | task_mention | remind | access_request |
  access_opened | access_closed | finished_at_change | dependency_added |
  dependency_done | waiter_closed | waits_added |
  owner_change | owner_handed |
  score | invite | welcome | new_report | weekly_digest | bot_key_old.
Payload keys are camelCase (employeeId, dependencyId, ...).
A copy for an absent employee''s manager has for = the recipient id.';

-- A person's own webhooks (decision 110). The company's WEBHOOK_URL is gone, so
-- a webhook no longer fails a person's notification: only the email is tried again.

CREATE TABLE webhook (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES human(employee_id),
    url TEXT NOT NULL,
    secret TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    levels JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_at TIMESTAMPTZ,
    last_error TEXT
);
CREATE INDEX idx_webhook_employee ON webhook(employee_id);


COMMENT ON TABLE webhook IS
'A place a person sends their notifications to, besides the email and the
bell: a receiver for Telegram gives them an address, they paste it (decision
110). Each sees only what its owner is notified of. Sign-in and confirmation
links never come here. It is someone''s program and may be down: a failure is
tried again a few times, apart from the queue (webhook_retry). Where they may go is the administrator''s
(WEBHOOK_ALLOWED_URLS); by default only outside the company''s network, so
nobody can make the server call inside it. A bot has its own (bot.webhook_url).';

COMMENT ON COLUMN webhook.employee_id IS
'Whose it is: only they see and change it.';
COMMENT ON COLUMN webhook.url IS
'Where to POST. It may carry the receiver''s id for the person, so it is secret.';
COMMENT ON COLUMN webhook.secret IS
'Signs every body (HMAC-SHA256), for a receiver that checks.';
COMMENT ON COLUMN webhook.levels IS
'For each group of events (WebhookLevels in shared/webhook.ts): off, event
(that it happened, with a link), title, text.';
COMMENT ON COLUMN webhook.created_at IS
'When it was added.';
COMMENT ON COLUMN webhook.last_at IS
'The last attempt.';
COMMENT ON COLUMN webhook.last_error IS
'What the last attempt failed with; NULL — it went through, or none yet.';

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
    waiting for it (dependency_done), and the owners of the open tasks it
    was waiting for (waiter_closed): nobody may need their work any more.
  - a link removed -> the owner of the open task it waited for, unless they
    removed it (waiter_closed).
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

Delivery: an email in the employee.locale language (SMTP_URL), and whatever
webhooks the person set up (webhook); a bot gets its own webhook only.';

COMMENT ON TABLE notification_failure IS
'A person''s notification that could not be delivered: the mail server
refused it (a mailbox deleted, a full one).
It waits here for its next attempt while the queue goes on: one broken
address never holds the others. Attempts after 1, 5 and 15 minutes, then
every hour, for three days (fail_notification()); then it is given up
and stays for the administrator to see (node server/admin.ts
deliveries). Delivered at last, the row goes. A webhook is not here: it
has its own attempts (webhook_retry), and a failure is noted for its owner
(webhook.last_error, bot_usage).';

ALTER TABLE notification_failure DROP COLUMN mailed;

DROP FUNCTION fail_notification(BIGINT, TEXT, BOOLEAN);
CREATE OR REPLACE FUNCTION fail_notification(p_id BIGINT, p_error TEXT)
RETURNS TIMESTAMPTZ AS $$
DECLARE
    v_attempts INT;
    v_first TIMESTAMPTZ;
    v_next TIMESTAMPTZ;
BEGIN
    INSERT INTO notification_failure AS f (notification_id, attempts, error)
    VALUES (p_id, 1, p_error)
    ON CONFLICT (notification_id) DO UPDATE
       SET attempts = f.attempts + 1, last_failed_at = NOW(),
           error = EXCLUDED.error
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

COMMENT ON FUNCTION fail_notification(BIGINT, TEXT) IS
'Records a failed attempt to deliver a person''s notification and
returns when to try again: after 1, 5 and 15 minutes, then every hour;
NULL — three days have passed since the first failure, it is given up.';

-- A message a webhook did not take is tried again, apart from the queue.

CREATE TABLE webhook_retry (
    id BIGSERIAL PRIMARY KEY,
    webhook_id INT REFERENCES webhook(id) ON DELETE CASCADE,
    bot_id INT REFERENCES bot(employee_id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    attempts INT NOT NULL DEFAULT 1,
    next_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT chk_webhook_retry_target CHECK ((webhook_id IS NULL) <> (bot_id IS NULL))
);
CREATE INDEX idx_webhook_retry_next ON webhook_retry(next_at);

COMMENT ON TABLE webhook_retry IS
'A message a webhook did not take, waiting for another attempt apart from the
queue: one broken receiver never holds the others (decision 110). Attempts after
1, 5 and 15 minutes and an hour, then it is dropped and the error stays where the
owner sees it: a message hours old only gets in the way, and the email and the
bell have told the person anyway. The row goes as soon as it is delivered or
dropped, since the body may hold the text of a task.';

COMMENT ON COLUMN webhook_retry.webhook_id IS
'A person''s webhook. Removed, the message goes with it.';

COMMENT ON COLUMN webhook_retry.bot_id IS
'Or a bot, to its current webhook.';

COMMENT ON COLUMN webhook_retry.body IS
'What to send, as first built; it is signed anew at each attempt.';

COMMENT ON COLUMN webhook_retry.attempts IS
'How many attempts failed.';

COMMENT ON COLUMN webhook_retry.next_at IS
'When to try again.';

-- A person's keys to the public API (decision 111).

CREATE TABLE api_key (
    id SERIAL PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES human(employee_id),
    name TEXT NOT NULL,
    hash BYTEA NOT NULL UNIQUE,
    rights TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,

    CONSTRAINT chk_api_key_rights CHECK (
        cardinality(rights) > 0
        AND rights <@ ARRAY['tasks.read', 'tasks.write', 'comments.write', 'participants.write', 'reports.read']
    )
);
CREATE INDEX idx_api_key_employee ON api_key(employee_id);

COMMENT ON TABLE api_key IS
'A key a person makes to automate their own work: a program acts in their name
(decision 111), within what they see and only with the rights ticked. Unlike a
bot''s key it always ends: a leaked key of a manager shows their people''s data.
It stops at once when revoked, expired, or when its owner is dismissed or
refused by the identity provider (authenticate_api_key()). The key itself is
never stored, only its SHA-256, and it is shown once. A key neither makes keys
nor reaches the interface''s API: it works only at /api/v1, where writing
shifts, time entries and scores does not exist.';

COMMENT ON COLUMN api_key.name IS
'What it is for, in its owner''s words.';

COMMENT ON COLUMN api_key.hash IS
'SHA-256 of the key.';

COMMENT ON COLUMN api_key.rights IS
'What it may do (ApiRight in shared/apiKey.ts); nothing else.';

COMMENT ON COLUMN api_key.expires_at IS
'When it ends by itself.';

COMMENT ON COLUMN api_key.last_used_at IS
'For its owner to see whether it is still in use; updated at most every five minutes.';

COMMENT ON COLUMN api_key.revoked_at IS
'When its owner ended it. Rows stay: who had what key is worth knowing later.';

COMMENT ON COLUMN api_key.employee_id IS
'Whose it is, and in whose name it acts.';

COMMENT ON COLUMN api_key.created_at IS
'When it was made.';


CREATE OR REPLACE FUNCTION create_api_key(p_employee_id INT, p_name TEXT, p_rights TEXT[], p_days INT)
RETURNS TABLE (id INT, key TEXT) AS $$
DECLARE
    v_key TEXT := 'yartt_k_' || encode(gen_random_bytes(32), 'hex');
    v_id INT;
BEGIN
    INSERT INTO api_key (employee_id, name, hash, rights, expires_at)
    VALUES (p_employee_id, p_name, digest(v_key, 'sha256'), p_rights, NOW() + make_interval(days => p_days))
    RETURNING api_key.id INTO v_id;
    RETURN QUERY SELECT v_id, v_key;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_api_key(INT, TEXT, TEXT[], INT) IS
'Makes a key and returns it: the only time it is seen.';


CREATE OR REPLACE FUNCTION authenticate_api_key(p_key TEXT)
RETURNS TABLE (employee_id INT, rights TEXT[]) AS $$
BEGIN
    UPDATE api_key k SET last_used_at = NOW()
     WHERE k.hash = digest(p_key, 'sha256')
       AND (k.last_used_at IS NULL OR k.last_used_at < NOW() - INTERVAL '5 minutes');
    RETURN QUERY
    SELECT k.employee_id, k.rights
      FROM api_key k
      JOIN employee e ON e.id = k.employee_id
      JOIN human h ON h.employee_id = k.employee_id
     WHERE k.hash = digest(p_key, 'sha256') AND k.revoked_at IS NULL AND k.expires_at > NOW()
       AND e.dismissed_at IS NULL AND h.idp_blocked_at IS NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION authenticate_api_key(TEXT) IS
'Whose key it is and what it may do; no row if unknown, revoked, expired, or
its owner is dismissed or refused by the identity provider.';

-- Descriptions of tags along the reporting line (decision 112).

CREATE TABLE tag_description (
    employee_id INT NOT NULL REFERENCES human(employee_id),
    tag_id INT NOT NULL REFERENCES tag(id),
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (employee_id, tag_id)
);
CREATE INDEX idx_tag_description_tag ON tag_description(tag_id);

COMMENT ON TABLE tag_description IS
'What a tag means, in someone''s words: what a group of tasks has in common,
the rules for it, a link to the regulation (decision 112). The same tag may
mean different things in different departments, and a tag has no owner, so a
description belongs to a person and applies along the reporting line. A task
shows the descriptions of its tags along its OWNER''s chain, from the top down
and each with its author, the same for everyone who sees the task: whose task
it is, in that sense it was made. Nobody below can hide what is above, and
nothing has to be resolved, since a description forbids nothing. A dismissed
author''s go to their manager, unless the manager has one for that tag.';

COMMENT ON COLUMN tag_description.employee_id IS
'Whose words these are.';

COMMENT ON COLUMN tag_description.tag_id IS
'Which tag. One tag each: a combination is described by a tag of its own.';

COMMENT ON COLUMN tag_description.value IS
'Sanitized HTML, without images: a description is seen by more people than its
author could give access to.';

COMMENT ON COLUMN tag_description.updated_at IS
'When it last changed.';


CREATE OR REPLACE FUNCTION employee_chain(p_employee_id INT)
RETURNS TABLE (id INT, depth INT) AS $$
    WITH RECURSIVE chain(id, depth, seen) AS (
        SELECT p_employee_id, 0, ARRAY[p_employee_id]
        UNION ALL
        SELECT e.manager_id, c.depth + 1, c.seen || e.manager_id
          FROM chain c JOIN employee e ON e.id = c.id
         WHERE e.manager_id IS NOT NULL AND NOT e.manager_id = ANY(c.seen)
    )
    SELECT id, depth FROM chain
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION employee_chain(INT) IS
'The employee and their managers up the chain, 0 — themselves; once round a
ring of managers at most (decision 90).';

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

    -- What they wrote about tags stays with whoever takes their people.
    INSERT INTO tag_description (employee_id, tag_id, value, updated_at)
    SELECT v_manager_id, tag_id, value, updated_at FROM tag_description WHERE employee_id = p_employee_id
    ON CONFLICT (employee_id, tag_id) DO NOTHING;
    DELETE FROM tag_description WHERE employee_id = p_employee_id;

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
                   RETURNING id, in_storage; and the objects of those in_storage.
  - every minute, with an object storage: move files from value there;
                  delete the objects of purged files.
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

-- A removed link stays known to both tasks (decision 113).

CREATE TABLE dependency_removed (
    task_id INT NOT NULL REFERENCES task(id),
    value INT NOT NULL REFERENCES task(id),
    added_at TIMESTAMPTZ,
    removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_by INT NOT NULL REFERENCES employee(id),
    PRIMARY KEY (task_id, value)
);
CREATE INDEX idx_dependency_removed_value ON dependency_removed(value);

COMMENT ON TABLE dependency_removed IS
'A link that was removed: task_id waited for value from added_at to removed_at
(decision 113). Both tasks keep it under "Related", so whoever started a task
because someone needed it can still tell why. Linked again, the row goes, and
the link is in dependency once more.';

COMMENT ON COLUMN dependency_removed.task_id IS
'The task that waited.';

COMMENT ON COLUMN dependency_removed.value IS
'The task it waited for.';

COMMENT ON COLUMN dependency_removed.added_at IS
'When the waiting began. NULL — not known (a link made before 0.5).';

COMMENT ON COLUMN dependency_removed.removed_at IS
'When the link was removed.';

COMMENT ON COLUMN dependency_removed.removed_by IS
'Who removed it.';
