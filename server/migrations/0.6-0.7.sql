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

Delivery: an email in the employee.locale language (SMTP_URL) and/or the
outgoing webhook (WEBHOOK_URL), whose receiver picks other channels
(Telegram, Slack, ...); a bot gets its own webhook only.';

COMMENT ON COLUMN notification.payload IS
'JSONB context. Contains kind:
  comment | mention | task_mention | remind | access_request |
  access_opened | access_closed | finished_at_change | dependency_added |
  dependency_done | waiter_closed | waits_added |
  owner_change | owner_handed |
  score | invite | welcome | new_report | weekly_digest | bot_key_old.
Payload keys are camelCase (employeeId, dependencyId, ...).
A copy for an absent employee''s manager has for = the recipient id.';

