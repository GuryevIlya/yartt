-- 0.5 -> 0.6

-- A mention is closed without a reply too (decision 95), and a comment
-- waits for its author's "No intervention needed" (decision 98). The author adds mentions to a comment later and
-- deletes one until its first reaction; mentioning everyone leaves no copy
-- to a manager mentioned in the same comment. Every change of a task's
-- owner is kept and shown in its feed (decision 96). Shifts may run past
-- midnight; time is logged and scored by shift (decision 100). A
-- sign-in link works only in the browser that asked for it (decision 101).
-- A notification that cannot be delivered no longer holds the queue
-- (decision 102). A change sent again by the browser's outbox is not
-- applied twice (decision 103).

ALTER TABLE mention ADD COLUMN created_at TIMESTAMPTZ;
UPDATE mention m SET created_at = c.created_at
  FROM comment c WHERE c.task_id = m.task_id AND c.id = m.comment_id;
ALTER TABLE mention ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN created_at SET DEFAULT NOW();

-- Comments are never edited, but their author reviews the reactions.
ALTER TABLE comment ADD COLUMN reviewed_at TIMESTAMPTZ;
DROP TRIGGER comment_forbid_change ON comment;
CREATE TRIGGER comment_forbid_change
BEFORE DELETE OR UPDATE OF task_id, id, created_by, value, attachment_ids, attachment_names, image_ids, created_at, reply_to_id
ON comment
FOR EACH ROW EXECUTE FUNCTION trg_forbid_delete();

COMMENT ON FUNCTION trg_forbid_delete() IS
'Forbids DELETE (and, for comment, an UPDATE of anything but its
reviewed_at). An employee is dismissed, a task is closed, a comment
stays forever and is never edited.';

-- Before 0.6 a mention was closed only after a reply, and it left the
-- author's list: a comment whose mentions are all closed is reviewed up to
-- its last reaction.
UPDATE comment c
   SET reviewed_at = r.at
  FROM (SELECT m.task_id, m.comment_id,
               GREATEST(max(m.closed_at),
                        (SELECT max(x.created_at) FROM comment x
                          WHERE x.task_id = m.task_id AND x.reply_to_id = m.comment_id
                            AND x.created_by = ANY(array_agg(m.value)))) AS at
          FROM mention m
         GROUP BY m.task_id, m.comment_id
        HAVING bool_and(m.closed_at IS NOT NULL)) r
 WHERE c.task_id = r.task_id AND c.id = r.comment_id;

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

COMMENT ON COLUMN comment.reviewed_at IS
'Up to when the author has seen the reactions to the comment''s mentions:
replies by the mentioned and closings ("No intervention needed",
review_comment(), decision 98). A comment with mentions waits in its
author''s Waiting for others while it was never reviewed or has a
reaction after it; one reviewed with mentions still unanswered leaves
the list until someone reacts. Never moves back. NULL — never reviewed.';

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

COMMENT ON COLUMN mention.created_at IS
'When the person was mentioned: the comment''s moment, or later if the
author added the mention afterwards. The reaction is counted from it, and
only replies after it answer the mention.';


DROP TRIGGER mention_close_check ON mention;
DROP FUNCTION trg_mention_close_check();

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

DROP FUNCTION notify(INT, INT, JSONB);

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

-- Every change of a task's owner is kept (decision 96).
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

-- Before 0.6 a change of the owner was kept only in its notifications (a
-- year of them): the changes are restored from them. A handover by a
-- manager told the previous owner (owner_handed) with who did it; any other
-- told the new owner (owner_change), made by the previous owner or, if that
-- one was dismissed then, by the new owner, their manager. The last change,
-- whatever it was, is task.handed_at.
WITH n AS (
    SELECT task_id, added_at AS at, employee_id, payload
      FROM notification
     WHERE payload->>'kind' IN ('owner_change', 'owner_handed') AND NOT payload ? 'for' AND task_id IS NOT NULL
),
handed AS (
    SELECT task_id, at, employee_id AS from_id, (payload->>'employeeId')::int AS to_id, (payload->>'by')::int AS "by"
      FROM n WHERE payload->>'kind' = 'owner_handed'
),
changed AS (
    SELECT n.task_id, n.at, (n.payload->>'from')::int AS from_id, n.employee_id AS to_id,
           CASE WHEN e.dismissed_at = n.at THEN n.employee_id ELSE (n.payload->>'from')::int END AS "by"
      FROM n LEFT JOIN employee e ON e.id = (n.payload->>'from')::int
     WHERE n.payload->>'kind' = 'owner_change'
       AND NOT EXISTS (SELECT 1 FROM handed h WHERE h.task_id = n.task_id AND h.at = n.at)
)
INSERT INTO owner_change (task_id, at, from_id, to_id, "by")
SELECT task_id, at, from_id, to_id, "by" FROM handed
UNION ALL
SELECT task_id, at, from_id, to_id, "by" FROM changed
ORDER BY at, task_id;

INSERT INTO owner_change (task_id, at, from_id, to_id, "by")
SELECT k.id, k.handed_at, NULL, k.owner_id, NULL
  FROM task k
 WHERE k.handed_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM owner_change o WHERE o.task_id = k.id AND o.at = k.handed_at)
 ORDER BY k.handed_at, k.id;

COMMENT ON COLUMN task.handed_at IS
'When the task last came to its current owner (trigger on owner_id): the
moment of its last owner_change.
Until they accept it (reviewed_at NULL, mark_reviewed()) their review
shows the handover alone; accepted, reviewed_at is handed_at, and only
what came after it is new to them. NULL — never handed over: the creator
owns it.';

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

-- Shifts may run past midnight, and time is logged and scored by shift
-- (decision 100). The old checks go first: the data is moved under none.
DROP TRIGGER spent_minutes_check ON spent_minutes;
DROP TRIGGER score_check ON score;
DROP TRIGGER work_check ON work;
DROP FUNCTION check_day_minutes(INT, DATE, INT, INT);

ALTER TABLE work ADD COLUMN id SERIAL NOT NULL;
ALTER TABLE work ADD CONSTRAINT work_id_key UNIQUE (id);
ALTER TABLE work ADD CONSTRAINT chk_work_length CHECK (spent_minutes <= 24 * 60);

-- Time logged on a day without a shift gets one: from 09:00 (earlier if
-- it would run past midnight, or end after now), as long as the time.
INSERT INTO work (employee_id, started_at, spent_minutes)
SELECT d.employee_id,
       LEAST((LEAST(d.day + TIME '09:00', (d.day + 1)::timestamp - d.minutes * INTERVAL '1 minute')) AT TIME ZONE d.time_zone,
             date_trunc('minute', NOW()) - d.minutes * INTERVAL '1 minute'),
       d.minutes
  FROM (SELECT s."by" AS employee_id, s.day, e.time_zone, LEAST(sum(s.value), 24 * 60)::int AS minutes
          FROM spent_minutes s JOIN employee e ON e.id = s."by"
         WHERE NOT EXISTS (SELECT 1 FROM work w
                            WHERE w.employee_id = s."by" AND (w.started_at AT TIME ZONE e.time_zone)::date = s.day)
         GROUP BY 1, 2, 3) d
 ORDER BY d.employee_id, d.day;

-- An entry of a day goes to that day's longest shift.
ALTER TABLE spent_minutes ADD COLUMN shift_id INT;
UPDATE spent_minutes s
   SET shift_id = (SELECT w.id FROM work w JOIN employee e ON e.id = w.employee_id
                    WHERE w.employee_id = s."by" AND (w.started_at AT TIME ZONE e.time_zone)::date = s.day
                    ORDER BY w.spent_minutes DESC NULLS LAST, w.started_at
                    LIMIT 1);
ALTER TABLE spent_minutes ALTER COLUMN shift_id SET NOT NULL;
ALTER TABLE spent_minutes ADD CONSTRAINT spent_minutes_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES work(id);
ALTER TABLE spent_minutes DROP CONSTRAINT uq_spent_minutes_day;
DROP INDEX idx_spent_minutes_by_day;
ALTER TABLE spent_minutes DROP COLUMN day;
ALTER TABLE spent_minutes ADD CONSTRAINT uq_spent_minutes_shift UNIQUE (task_id, "by", shift_id);
CREATE INDEX idx_spent_minutes_shift ON spent_minutes(shift_id);
CREATE INDEX idx_spent_minutes_by ON spent_minutes(by);

-- A day's score goes to each of its closed shifts.
CREATE TEMP TABLE score_moved ON COMMIT DROP AS
SELECT w.id AS shift_id, o."by", o.value, o.reason, o.added_at, o.updated_at
  FROM score o
  JOIN employee e ON e.id = o.employee_id
  JOIN work w ON w.employee_id = o.employee_id AND (w.started_at AT TIME ZONE e.time_zone)::date = o.day
             AND w.spent_minutes IS NOT NULL;
DROP TABLE score;
CREATE TABLE score (
    shift_id INT PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
    by INT NOT NULL REFERENCES human(employee_id),
    value INT CHECK (value BETWEEN 0 AND 100),
    reason TEXT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);
INSERT INTO score (shift_id, "by", value, reason, added_at, updated_at)
SELECT shift_id, "by", value, reason, added_at, updated_at FROM score_moved ORDER BY shift_id;

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

COMMENT ON CONSTRAINT chk_work_length ON work IS
'A shift lasts at most 24 hours.';

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

COMMENT ON COLUMN spent_minutes.shift_id IS
'The shift of by the time is logged in.';

COMMENT ON COLUMN spent_minutes.value IS
'Minutes spent in that shift on the task, all of them. CHECK > 0: none is no row.';

COMMENT ON CONSTRAINT uq_spent_minutes_shift ON spent_minutes IS
'One entry per task, person and shift: time is set for the shift, not added up.';

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

CREATE VIEW spent_day AS
SELECT s.id AS entry_id, s.task_id, s."by", s.shift_id, d.day, s.value * d.share AS minutes, s.added_at, s.updated_at
  FROM spent_minutes s
  JOIN shift_day d ON d.shift_id = s.shift_id;

COMMENT ON VIEW spent_day IS
'Each time entry by the days of its shift, with the share of its minutes
that falls on each (decision 100): sums of time by day take it from here.';

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

-- A sign-in link works only in the browser that asked for it (decision
-- 101). Links sent before are unbound: they go, a new one takes a minute.
DELETE FROM token WHERE email IS NULL;
ALTER TABLE token ADD COLUMN browser BYTEA,
    ADD CONSTRAINT chk_token_browser CHECK ((email IS NULL) = (browser IS NOT NULL));

COMMENT ON COLUMN token.browser IS
'SHA-256 of the key the browser that asked for a sign-in link keeps in its
cookie: login() signs in only there. NULL for an email-change token: it
signs nobody in, so any browser may follow it.';

COMMENT ON CONSTRAINT chk_token_browser ON token IS
'A sign-in token is always bound to a browser, an email-change token never.';

DROP FUNCTION issue_token(CITEXT);
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


DROP FUNCTION login(TEXT);
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


-- A notification that cannot be delivered waits for its next attempt
-- aside, and the queue goes on (decision 102).
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


-- A change sent again by the browser's outbox is not applied twice
-- (decision 103).
CREATE TABLE sent_change (
    id UUID PRIMARY KEY,
    employee_id INT NOT NULL REFERENCES employee(id),
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sent_change_at ON sent_change(at);

COMMENT ON TABLE sent_change IS
'Changes the interface sent, by the id the browser gave each one
(decision 103). A change whose answer was lost on the way waits in the
browser''s outbox and is sent again; its id here says it was applied,
so it is not applied twice (a second task, a second comment). Written
before the change runs and removed if it fails, so a refused change can
be sent again. Bots send no id. Cron deletes ids older than 90 days:
an outbox does not wait that long.';

COMMENT ON COLUMN sent_change.id IS
'The id the browser gave the change (the X-Yartt-Change header).';

COMMENT ON COLUMN sent_change.employee_id IS
'Who sent it.';

COMMENT ON COLUMN sent_change.at IS
'When it was applied.';

COMMENT ON INDEX idx_sent_change_at IS
'For the cron cleanup of old ids.';

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
                     AND NOT attachment_in_use(a.id);
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
                     AND NOT EXISTS (SELECT 1 FROM user_tag WHERE tag_id = t.id);
  - every day:    UPDATE human SET next_day = NULL
                   WHERE next_day <= local_today(employee_id);
';
