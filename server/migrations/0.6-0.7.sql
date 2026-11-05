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
Deletion is physical. No audit.
When finished_at of value is set, moved or cleared, owners of all
dependent tasks are notified.
The row outlives closing: waiting is shown while both tasks are open, after
that under "Related" (decision 107), and reopening brings it back.';


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
links never come here. One attempt per notification: it is someone''s program,
and may be down for days. Where they may go is the administrator''s
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
gets one attempt, a failure is noted for its owner (webhook.last_error,
bot_usage).';

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
