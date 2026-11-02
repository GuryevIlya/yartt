import { z } from 'zod';
import type { History } from '#shared/myDay.ts';
import type { DayStats, Member, MemberDay, PeriodStats, ScoreInput, Stats } from '#shared/team.ts';
import { AppError } from '../errors.ts';
import { sql, type Sql } from '../pg.ts';
import { shiftsWithin } from './Task.ts';
import * as MyDay from './MyDay.ts';

const Bool = z.object({ value: z.boolean() });
const StatsRow = z.object({
  employeeId: z.number(),
  workMinutes: z.number(),
  workDays: z.number(),
  spentMinutes: z.number(),
  scoredDays: z.number(),
  weightedScore: z.number().nullable(),
});
const MemberRow = z.object({ id: z.number(), direct: z.boolean(), self: z.boolean() });
const ExtraRow = z.object({
  employeeId: z.number(),
  unscoredDays: z.number(),
  finished: z.number(),
  late: z.number(),
  openTasks: z.number(),
  atRisk: z.number(),
  recordDelayMinutes: z.number().nullable(),
  replyMinutes: z.number().nullable(),
  unanswered: z.number(),
  backlogMinutes: z.number(),
  backlogGrowthMinutes: z.number(),
  lastSeenAt: z.date().nullable(),
});
const MemberDayRow = z.object({
  employeeId: z.number(),
  day: z.string(),
  workMinutes: z.number(),
  spentMinutes: z.number(),
  score: z.number().nullable(),
  backlogMinutes: z.number(),
});
const DelayRow = z.object({
  kind: z.enum(['record', 'reply']),
  employeeId: z.number(),
  day: z.string(),
  minutes: z.number(),
});

/** An employee's days are seen by themselves and every manager above them (decision 12). */
export async function assertCanView(viewerId: number, employeeId: number): Promise<void> {
  if (viewerId === employeeId) return;
  const [row] = Bool.array().parse(await sql`
    SELECT ${employeeId} IN (SELECT subordinates(${viewerId})) AS value
  `);
  if (!row?.value) throw new AppError('forbidden');
}

/**
 * Whose My day to show (decision 83): one's own, or a report's for a
 * manager above them — read-only, the client keeps the buttons away.
 */
export async function viewAs(viewerId: number, as: number | undefined): Promise<number> {
  if (as === undefined || as === viewerId) return viewerId;
  await assertCanView(viewerId, as);
  return as;
}

/** The last N days (today included) in each employee's own time zone, or fixed days. */
export type Range = { days: number } | { from: string; to: string };

/**
 * Metrics of a range. Workload and quality stay apart; the score is weighted
 * by the minutes of the scored shifts within the range. A shift past
 * midnight counts in each of its days by its share (decision 100).
 */
export async function stats(ids: number[], range: Range, db: Sql = sql): Promise<Map<number, Stats>> {
  if (ids.length === 0) return new Map();
  const bounds = 'days' in range
    ? db`local_today(id) - ${range.days - 1}::int AS since, local_today(id) AS until`
    : db`${range.from}::date AS since, ${range.to}::date AS until`;
  const rows = StatsRow.array().parse(await db`
    WITH e AS (
      SELECT id, time_zone, ${bounds}
        FROM employee WHERE id = ANY(${ids})
    ),
    -- Each person's closed shifts by day, within the range only.
    wr AS (
      SELECT d.employee_id, d.day, sum(d.minutes) AS minutes
        FROM shift_day d JOIN e ON e.id = d.employee_id
       WHERE d.closed AND d.day BETWEEN e.since AND e.until
         AND d.started_at >= e.since - 2 AND d.started_at < e.until + 2
       GROUP BY 1, 2
    ),
    -- Grouped once per person, not a subquery per person: the summary has hundreds.
    wa AS (SELECT employee_id, sum(minutes)::int AS minutes, count(*)::int AS days FROM wr GROUP BY 1),
    sa AS (
      SELECT s."by" AS employee_id, sum(s.minutes)::int AS minutes
        FROM spent_day s JOIN e ON e.id = s."by"
       WHERE s.day BETWEEN e.since AND e.until
         AND s.started_at >= e.since - 2 AND s.started_at < e.until + 2
       GROUP BY 1
    ),
    sc AS (
      SELECT d.employee_id, count(DISTINCT d.day)::int AS days,
             (sum(s.value * d.minutes) / NULLIF(sum(d.minutes), 0))::float8 AS weighted
        FROM shift_day d JOIN e ON e.id = d.employee_id
        JOIN score s ON s.shift_id = d.shift_id AND s.value IS NOT NULL
       WHERE d.day BETWEEN e.since AND e.until
         AND d.started_at >= e.since - 2 AND d.started_at < e.until + 2
       GROUP BY 1
    )
    SELECT e.id AS employee_id,
           COALESCE(wa.minutes, 0) AS work_minutes, COALESCE(wa.days, 0) AS work_days,
           COALESCE(sa.minutes, 0) AS spent_minutes,
           COALESCE(sc.days, 0) AS scored_days, sc.weighted AS weighted_score
      FROM e
      LEFT JOIN wa ON wa.employee_id = e.id
      LEFT JOIN sa ON sa.employee_id = e.id
      LEFT JOIN sc ON sc.employee_id = e.id
  `);
  return new Map(rows.map(({ employeeId, ...rest }) => [employeeId, rest]));
}

/**
 * Every day of a range for each of these people, oldest first: timesheet,
 * time logged, the score, the backlog at the day's end — the sparklines of
 * My team and the chart of an employee page.
 */
async function memberDays(ids: number[], from: string, to: string): Promise<z.infer<typeof MemberDayRow>[]> {
  return MemberDayRow.array().parse(await sql`
    WITH e AS (SELECT id, time_zone FROM employee WHERE id = ANY(${ids})),
         d AS (SELECT e.id, e.time_zone, g::date AS day
                 FROM e, generate_series(${from}::date, ${to}::date, INTERVAL '1 day') g),
         w AS (
           SELECT employee_id, day, sum(minutes) AS minutes,
                  -- The day's score: its scored shifts, weighted by their minutes in it.
                  sum(sc.value * minutes) FILTER (WHERE sc.value IS NOT NULL)
                    / NULLIF(sum(minutes) FILTER (WHERE sc.value IS NOT NULL), 0) AS score
             FROM shift_day
             LEFT JOIN score sc USING (shift_id)
            WHERE employee_id = ANY(${ids}) AND closed AND day BETWEEN ${from}::date AND ${to}::date
              AND ${shiftsWithin(sql`shift_day`, from, to)}
            GROUP BY 1, 2
         ),
         s AS (
           SELECT "by" AS employee_id, day, sum(minutes) AS minutes FROM spent_day
            WHERE "by" = ANY(${ids}) AND day BETWEEN ${from}::date AND ${to}::date
              AND ${shiftsWithin(sql`spent_day`, from, to)}
            GROUP BY 1, 2
         )
    SELECT d.id AS employee_id, d.day::text, COALESCE(w.minutes, 0)::int AS work_minutes,
           COALESCE(s.minutes, 0)::int AS spent_minutes, round(w.score)::int AS score,
           b.minutes AS backlog_minutes
      FROM d
      JOIN backlog_by_day(${ids}, ${from}::date, ${to}::date) b ON b.employee_id = d.id AND b.day = d.day
      LEFT JOIN w ON w.employee_id = d.id AND w.day = d.day
      LEFT JOIN s ON s.employee_id = d.id AND s.day = d.day
     ORDER BY d.id, d.day
  `);
}

/**
 * The delays of each day of a range, for the charts under My team: the
 * median lateness of the day's timesheet, of replies to the day's mentions
 * (working time only), and of the person's scores of their reports'
 * shifts begun that day, from each shift's end. The same measures as the
 * summary's, day by day.
 */
async function delaysByDay(ids: number[], from: string, to: string): Promise<z.infer<typeof DelayRow>[]> {
  return DelayRow.array().parse(await sql`
    WITH e AS (SELECT id, time_zone FROM employee WHERE id = ANY(${ids})),
         rec AS (
           SELECT w.employee_id, (w.started_at AT TIME ZONE e.time_zone)::date AS day,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(0,
                    extract(epoch FROM w.updated_at - (w.started_at + w.spent_minutes * INTERVAL '1 minute')) / 60)) AS minutes
             FROM work w JOIN e ON e.id = w.employee_id
            WHERE w.spent_minutes IS NOT NULL
              AND w.started_at >= (${from}::date - 2)::timestamptz AND w.started_at < (${to}::date + 2)::timestamptz
            GROUP BY 1, 2
         ),
         rep AS (
           SELECT m.value AS employee_id, (m.created_at AT TIME ZONE e.time_zone)::date AS day,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY wm.minutes) AS minutes
             FROM mention m
             JOIN e ON e.id = m.value
             CROSS JOIN LATERAL (SELECT mention_reaction(m.task_id, m.comment_id, m.value) AS replied_at) r
             CROSS JOIN LATERAL working_minutes(m.value, m.created_at, r.replied_at) wm
            WHERE r.replied_at IS NOT NULL
              AND m.created_at >= (${from}::date - 2)::timestamptz AND m.created_at < (${to}::date + 2)::timestamptz
              AND EXISTS (SELECT 1 FROM work w WHERE w.employee_id = m.value)
            GROUP BY 1, 2
         )
    SELECT 'record' AS kind, employee_id, day::text, minutes::float8 FROM rec WHERE day BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'reply', employee_id, day::text, minutes::float8 FROM rep WHERE day BETWEEN ${from}::date AND ${to}::date
  `);
}

/**
 * The team summary: me first (my own report), then the whole subtree of my
 * reports, direct ones first — without those invited after the range or
 * dismissed before it — for a range of their days — workload and
 * score, days not scored, tasks closed in time and after the deadline
 * (decision 32). People are compared by shares, not hours (decision 68).
 */
export async function summary(viewerId: number, from: string, to: string): Promise<Member[]> {
  const rows = MemberRow.array().parse(await sql`
    SELECT e.id, COALESCE(e.manager_id = ${viewerId}, FALSE) AS direct, e.id = ${viewerId} AS self
      FROM employee e
     WHERE (e.id IN (SELECT subordinates(${viewerId})) OR e.id = ${viewerId})
       -- Bots have none of these metrics; they have a block of their own (Bot.list).
       AND e.kind = 'human'
       -- Someone invited after the range or dismissed before it did not work in it.
       AND (e.created_at AT TIME ZONE e.time_zone)::date <= ${to}::date
       AND (e.dismissed_at IS NULL OR (e.dismissed_at AT TIME ZONE e.time_zone)::date >= ${from}::date)
     ORDER BY (e.id = ${viewerId}) DESC, (e.manager_id = ${viewerId}) DESC, e.dismissed_at IS NOT NULL, e.full_name, e.id
  `);
  const ids = rows.map((r) => r.id);
  // The parts do not depend on each other: asked at once, the summary takes as long as the slowest.
  const statsOf = stats(ids, { from, to });
  // The current deadline row tells how a task closed (decision 93): closed by its owner at or
  // before the deadline — in time; after it, overdue first — late.
  const extraOf = sql`
    WITH e AS (SELECT id, time_zone, local_today(id) AS today FROM employee WHERE id = ANY(${ids})),
         -- Days of the range before today with a closed shift not scored (decision 100).
         unscored AS (
           SELECT d.employee_id, count(DISTINCT d.day)::int AS n
             FROM shift_day d JOIN e ON e.id = d.employee_id
            WHERE d.closed AND d.day < e.today AND d.day BETWEEN ${from}::date AND ${to}::date
              AND ${shiftsWithin(sql`d`, from, to)}
              AND NOT EXISTS (SELECT 1 FROM score s WHERE s.shift_id = d.shift_id AND s.value IS NOT NULL)
            GROUP BY 1
         ),
         asked AS (
           -- The reaction: the first reply or the closing, from when they were mentioned (decision 95).
           SELECT m.value AS employee_id, m.created_at AS asked_at,
                  mention_reaction(m.task_id, m.comment_id, m.value) AS replied_at
             FROM mention m
             JOIN e ON e.id = m.value
            WHERE m.created_at >= ${from}::date - 2 AND m.created_at < ${to}::date + 2
              AND (m.created_at AT TIME ZONE e.time_zone)::date BETWEEN ${from}::date AND ${to}::date
         ),
         -- The reaction counts only the person's working time: hours off are not theirs to answer for.
         -- Without a timesheet there is no working time to measure against: no value.
         replies AS (
           SELECT a.employee_id,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY wm.minutes)
                    FILTER (WHERE a.replied_at IS NOT NULL AND EXISTS (SELECT 1 FROM work w WHERE w.employee_id = a.employee_id))
                    AS minutes,
                  count(*) FILTER (WHERE a.replied_at IS NULL)::int AS unanswered
             FROM asked a
             LEFT JOIN LATERAL (SELECT minutes FROM working_minutes(a.employee_id, a.asked_at, a.replied_at)
                                 WHERE a.replied_at IS NOT NULL) wm ON TRUE
            GROUP BY 1
         ),
         closed AS (
           SELECT k.owner_id, count(*) FILTER (WHERE f.confirmed_at <= f.value)::int AS finished,
                  count(*) FILTER (WHERE f.confirmed_at > f.value)::int AS late
             FROM task k
             JOIN e ON e.id = k.owner_id
             JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
            WHERE (f.confirmed_at AT TIME ZONE e.time_zone)::date BETWEEN ${from}::date AND ${to}::date
            GROUP BY 1
         ),
         -- Only an open task is at risk: at_risk() is not asked of the closed ones.
         open AS (
           SELECT k.owner_id, count(*)::int AS n, count(*) FILTER (WHERE at_risk(k.id))::int AS at_risk
             FROM task k
             JOIN e ON e.id = k.owner_id
             LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
            WHERE f.confirmed_at IS NULL
            GROUP BY 1
         )
    SELECT e.id AS employee_id,
           COALESCE(u.n, 0) AS unscored_days,
           COALESCE(c.finished, 0) AS finished,
           COALESCE(c.late, 0) AS late,
           COALESCE(o.n, 0) AS open_tasks,
           COALESCE(o.at_risk, 0) AS at_risk,
           (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(0,
                     extract(epoch FROM w.updated_at - (w.started_at + w.spent_minutes * INTERVAL '1 minute')) / 60))
              FROM work w
             WHERE w.employee_id = e.id AND w.spent_minutes IS NOT NULL AND ${shiftsWithin(sql`w`, from, to)}
               AND (w.started_at AT TIME ZONE e.time_zone)::date BETWEEN ${from}::date AND ${to}::date
           )::float8 AS record_delay_minutes,
           r.minutes::float8 AS reply_minutes,
           COALESCE(r.unanswered, 0) AS unanswered,
           backlog_minutes(e.id, NOW()) AS backlog_minutes,
           backlog_minutes(e.id, LEAST(NOW(), (${to}::date + 1)::timestamp AT TIME ZONE e.time_zone))
             - backlog_minutes(e.id, ${from}::date::timestamp AT TIME ZONE e.time_zone) AS backlog_growth_minutes,
           GREATEST((SELECT max(v.at) FROM visit v WHERE v.employee_id = e.id),
                    (SELECT max(s.last_seen_at) FROM session s WHERE s.employee_id = e.id)) AS last_seen_at
      FROM e
      LEFT JOIN unscored u ON u.employee_id = e.id
      LEFT JOIN closed c ON c.owner_id = e.id
      LEFT JOIN open o ON o.owner_id = e.id
      LEFT JOIN replies r ON r.employee_id = e.id
  `.then((rows) => new Map(ExtraRow.array().parse(rows).map(({ employeeId, ...rest }) => [employeeId, rest])));
  const [byId, extra, days, delays] = await Promise.all([statsOf, extraOf, memberDays(ids, from, to), delaysByDay(ids, from, to)]);
  const delayOf = new Map(delays.map((d) => [`${d.employeeId}/${d.day}/${d.kind}`, d.minutes]));
  const daysOf = new Map<number, MemberDay[]>();
  for (const { employeeId, ...day } of days) {
    const delay = (kind: z.infer<typeof DelayRow>['kind']) => delayOf.get(`${employeeId}/${day.day}/${kind}`) ?? null;
    const item = { ...day, recordDelayMinutes: delay('record'), replyMinutes: delay('reply') };
    daysOf.set(employeeId, [...(daysOf.get(employeeId) ?? []), item]);
  }
  return rows.map((r) => ({
    employeeId: r.id, direct: r.direct, self: r.self, stats: byId.get(r.id)!, ...extra.get(r.id)!, days: daysOf.get(r.id) ?? [],
  }));
}

/** Metrics of a range and every day of it, for the chart. */
export async function employeeStats(viewerId: number, employeeId: number, from: string, to: string): Promise<PeriodStats> {
  await assertCanView(viewerId, employeeId);
  const result = (await stats([employeeId], { from, to })).get(employeeId);
  if (!result) throw new AppError('not_found');
  const days: DayStats[] = (await memberDays([employeeId], from, to)).map(({ employeeId: _, ...day }) => day);
  return { stats: result, days };
}

/** The same History as in their My day: shifts, time logged, visits, scores. */
export async function history(viewerId: number, employeeId: number, page: number, size: number): Promise<History> {
  await assertCanView(viewerId, employeeId);
  return MyDay.history(employeeId, page, size);
}

const ScoreRow = z.object({ value: z.number().nullable(), reason: z.string().nullable() });
const ShiftOf = z.object({ id: z.number(), day: z.string(), startedAt: z.date(), minutes: z.number().nullable() });
const Now = z.object({ at: z.date() });

/** The report's shifts by id, with the day each began; not_found if one is not theirs. */
async function shiftsOf(db: Sql, employeeId: number, shiftIds: number[]): Promise<z.infer<typeof ShiftOf>[]> {
  const rows = ShiftOf.array().parse(await db`
    SELECT w.id, (w.started_at AT TIME ZONE e.time_zone)::date::text AS day, w.started_at, w.spent_minutes AS minutes
      FROM work w JOIN employee e ON e.id = w.employee_id
     WHERE w.id = ANY(${shiftIds}) AND w.employee_id = ${employeeId}
     ORDER BY w.started_at
  `);
  if (rows.length !== new Set(shiftIds).size) throw new AppError('not_found');
  return rows;
}

/**
 * The direct manager scores closed shifts of a report — a day's at once —
 * or corrects their scores (decision 100; the trigger checks the manager
 * and the shift). Every version goes to the employee with its time, reason
 * and the previous value, one email per shift: their mail keeps the
 * history, the table only the current value. An unchanged score is a no-op.
 */
export async function score(viewerId: number, input: ScoreInput): Promise<void> {
  const reason = input.reason || null;
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    for (const shift of await shiftsOf(db, input.employeeId, input.shiftIds)) {
      const [previous] = ScoreRow.array().parse(await db`
        SELECT value, reason FROM score WHERE shift_id = ${shift.id} FOR UPDATE
      `);
      if (previous && previous.value === input.value && previous.reason === reason) continue;
      if (previous) {
        await db`UPDATE score SET value = ${input.value}, reason = ${reason}, "by" = ${viewerId} WHERE shift_id = ${shift.id}`;
      } else {
        await db`INSERT INTO score (shift_id, "by", value, reason) VALUES (${shift.id}, ${viewerId}, ${input.value}, ${reason})`;
      }
      await notifyScore(db, viewerId, input.employeeId, shift, input.value, reason, previous ?? null);
    }
  });
}

async function notifyScore(
  db: Sql, by: number, employeeId: number, shift: z.infer<typeof ShiftOf>, value: number | null, reason: string | null,
  previous: { value: number | null; reason: string | null } | null,
): Promise<void> {
  const [now] = Now.array().parse(await db`SELECT NOW() AS at`);
  await db`SELECT notify(${employeeId}, NULL, ${db.json({
    kind: 'score', by, day: shift.day, startedAt: shift.startedAt.toISOString(), minutes: shift.minutes ?? 0,
    value, reason, at: now!.at.toISOString(), previous,
  })})`;
}

/**
 * The direct manager withdraws a shift's score so the employee can correct
 * the shift and its time entries; the reason stays and shows up when it is
 * scored again. Mailed like every version. A shift without a standing
 * score is a no-op.
 */
export async function unscore(viewerId: number, employeeId: number, shiftId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const [shift] = await shiftsOf(db, employeeId, [shiftId]);
    const [previous] = ScoreRow.array().parse(await db`
      SELECT value, reason FROM score WHERE shift_id = ${shiftId} FOR UPDATE
    `);
    if (!previous || previous.value === null) return;
    await db`UPDATE score SET value = NULL, "by" = ${viewerId} WHERE shift_id = ${shiftId}`;
    await notifyScore(db, viewerId, employeeId, shift!, null, previous.reason, previous);
  });
}
