import { z } from 'zod';
import type { TagLimitInput, TagLimits } from '#shared/tagLimit.ts';
import { forecast, TagLimit, TagLimitVersion } from '#shared/tagLimit.ts';
import { Tag } from '#shared/task.ts';
import { AppError } from '../errors.ts';
import { sql } from '../pg.ts';

const LimitRow = TagLimit.omit({ tags: true, days: true, cumulative: true, aheadMinutes: true, forecastMinutes: true }).extend({
  tagIds: z.number().array(),
  today: z.string(),
  /** Logged on its tasks by its people in the last 28 days, today included. */
  paceMinutes: z.number().int(),
  /** Days of the period still ahead, today included. */
  daysAhead: z.number().int(),
});
const VersionRow = TagLimitVersion.omit({ tags: true }).extend({ tagIds: z.number().array() });
const DayRow = z.object({ id: z.number(), day: z.string(), minutes: z.number() });

async function tagMap(viewerId: number, ids: number[]): Promise<Map<number, Tag>> {
  if (ids.length === 0) return new Map();
  const rows = Tag.array().parse(await sql`
    SELECT t.id, t.name, u.color FROM tag t
      LEFT JOIN user_tag u ON u.tag_id = t.id AND u.employee_id = ${viewerId}
     WHERE t.id = ANY(${ids})
  `);
  return new Map(rows.map((t) => [t.id, t]));
}

/** YYYY-MM-DD `days` days after `day`. */
const plus = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The current limits the viewer sees (can_see_tag_limit) — optionally only
 * those a task falls under — each with what its people (who set it and
 * everyone under them) logged in the period on the tasks carrying all its
 * tags, what they still plan on those open, what they get through by its
 * end at their pace of the last 28 days, the forecast, and the spending
 * day by day.
 */
async function current(viewerId: number, taskId: number | null): Promise<TagLimit[]> {
  const scope = sql`
    WITH l AS (
      SELECT l.* FROM tag_limit l
       WHERE l.expired_at IS NULL AND can_see_tag_limit(l.id, ${viewerId})
         ${taskId === null ? sql`` : sql`AND (SELECT k.tag_ids FROM task k WHERE k.id = ${taskId}) @> l.tag_ids`}
    ),
    people AS (
      SELECT l.id, p.person FROM l, LATERAL (SELECT l.employee_id AS person UNION SELECT subordinates(l.employee_id)) p
    )
  `;
  const rows = LimitRow.array().parse(await sql`
    ${scope}
    SELECT l.id, l.employee_id, l.tag_ids, l.starts_on::text, l.ends_on::text, l.minutes, l.created_at,
           EXISTS (SELECT 1 FROM tag_limit p WHERE p.replaced_by = l.id) AS changed,
           EXISTS (SELECT 1 FROM people WHERE people.id = l.id AND people.person = ${viewerId}) AS includes_me,
           t.today::text AS today,
           (SELECT COALESCE(sum(s.minutes), 0) FROM spent_day s JOIN task k ON k.id = s.task_id
             WHERE k.tag_ids @> l.tag_ids AND s.day BETWEEN l.starts_on AND l.ends_on
               AND s."by" IN (SELECT person FROM people WHERE people.id = l.id))::int AS spent_minutes,
           (SELECT COALESCE(sum(e.value), 0) FROM estimate_minutes e JOIN task k ON k.id = e.task_id
              LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
             WHERE e.expired_at IS NULL AND k.tag_ids @> l.tag_ids AND f.confirmed_at IS NULL
               AND e."by" IN (SELECT person FROM people WHERE people.id = l.id))::int AS left_minutes,
           (SELECT COALESCE(sum(s.minutes), 0) FROM spent_day s JOIN task k ON k.id = s.task_id
             WHERE k.tag_ids @> l.tag_ids AND s.day > t.today - 28 AND s.day <= t.today
               AND s."by" IN (SELECT person FROM people WHERE people.id = l.id))::int AS pace_minutes,
           GREATEST(0, l.ends_on - GREATEST(t.today, l.starts_on) + 1) AS days_ahead
      FROM l, LATERAL (SELECT local_today(${viewerId}) AS today) t
     ORDER BY l.ends_on, l.id
  `);
  const daily = DayRow.array().parse(await sql`
    ${scope}
    SELECT l.id, s.day::text, sum(s.minutes)::int AS minutes
      FROM l JOIN spent_day s ON s.day BETWEEN l.starts_on AND l.ends_on
      JOIN task k ON k.id = s.task_id AND k.tag_ids @> l.tag_ids
     WHERE s."by" IN (SELECT person FROM people WHERE people.id = l.id)
     GROUP BY l.id, s.day
  `);
  const tags = await tagMap(viewerId, [...new Set(rows.flatMap((r) => r.tagIds))]);
  return rows.map(({ tagIds, today, paceMinutes, daysAhead, ...r }) => {
    const last = r.endsOn < today ? r.endsOn : today;
    const days: string[] = [];
    for (let d = r.startsOn; d <= last; d = plus(d, 1)) days.push(d);
    let sum = 0;
    const cumulative = days.map((day) => (sum += daily.find((x) => x.id === r.id && x.day === day)?.minutes ?? 0));
    // Once the period is over nothing more counts: what was spent is what it came to.
    const aheadMinutes = daysAhead === 0 ? 0 : paceMinutes === 0 ? null : Math.round((paceMinutes / 28) * daysAhead);
    return {
      ...r,
      tags: tagIds.flatMap((id) => tags.get(id) ?? []),
      aheadMinutes,
      forecastMinutes: forecast({ spentMinutes: r.spentMinutes, aheadMinutes }, r.leftMinutes),
      days,
      cumulative,
    };
  });
}

/** The limits the viewer sees: the current ones with their figures, and the removed ones. */
export async function list(viewerId: number): Promise<TagLimits> {
  const removed = VersionRow.array().parse(await sql`
    SELECT l.id, l.employee_id, l.tag_ids, l.starts_on::text, l.ends_on::text, l.minutes, l.created_at, l.expired_at
      FROM tag_limit l
     WHERE l.expired_at IS NOT NULL AND l.replaced_by IS NULL AND can_see_tag_limit(l.id, ${viewerId})
     ORDER BY l.expired_at DESC
  `);
  const tags = await tagMap(viewerId, [...new Set(removed.flatMap((r) => r.tagIds))]);
  return {
    current: await current(viewerId, null),
    removed: removed.map(({ tagIds, ...r }) => ({ ...r, tags: tagIds.flatMap((id) => tags.get(id) ?? []) })),
  };
}

/** The current limits a task falls under — it carries all their tags — that the viewer sees. */
export async function forTask(viewerId: number, taskId: number): Promise<TagLimit[]> {
  return current(viewerId, taskId);
}

/** Every version of a limit, the latest first, back from the given one. */
export async function history(viewerId: number, id: number): Promise<TagLimitVersion[]> {
  const rows = VersionRow.array().parse(await sql`
    WITH RECURSIVE chain AS (
      SELECT l.* FROM tag_limit l WHERE l.id = ${id} AND can_see_tag_limit(l.id, ${viewerId})
      UNION ALL
      SELECT p.* FROM tag_limit p JOIN chain c ON p.replaced_by = c.id
    )
    SELECT id, employee_id, tag_ids, starts_on::text, ends_on::text, minutes, created_at, expired_at
      FROM chain ORDER BY created_at DESC, id DESC
  `);
  if (rows.length === 0) throw new AppError('not_found');
  const tags = await tagMap(viewerId, [...new Set(rows.flatMap((r) => r.tagIds))]);
  return rows.map(({ tagIds, ...r }) => ({ ...r, tags: tagIds.flatMap((tid) => tags.get(tid) ?? []) }));
}

/** The one who set a current limit, or not_found / forbidden. */
async function assertOwn(tx: typeof sql, actorId: number, id: number): Promise<void> {
  const [row] = z.object({ employeeId: z.number(), expiredAt: z.date().nullable() }).array().parse(await tx`
    SELECT employee_id, expired_at FROM tag_limit WHERE id = ${id} FOR UPDATE
  `);
  if (!row || row.expiredAt !== null) throw new AppError('not_found');
  if (row.employeeId !== actorId) throw new AppError('forbidden');
}

/**
 * Sets a limit for oneself and one's people; a change is a new row that
 * replaces the old one, which is closed — the history stays (decision 69).
 */
export async function set(actorId: number, input: TagLimitInput): Promise<number> {
  const tagIds = [...new Set(input.tagIds)].sort((a, b) => a - b);
  return sql.begin(async (tx) => {
    if (input.replaces !== null) await assertOwn(tx as unknown as typeof sql, actorId, input.replaces);
    const [known] = z.object({ n: z.number() }).array().parse(await tx`SELECT count(*)::int AS n FROM tag WHERE id = ANY(${tagIds})`);
    if (known!.n !== tagIds.length) throw new AppError('not_found');
    const [row] = z.object({ id: z.number() }).array().parse(await tx`
      INSERT INTO tag_limit (employee_id, tag_ids, starts_on, ends_on, minutes)
      VALUES (${actorId}, ${tagIds}, ${input.startsOn}, ${input.endsOn}, ${input.minutes})
      RETURNING id
    `);
    if (input.replaces !== null) {
      await tx`UPDATE tag_limit SET expired_at = NOW(), replaced_by = ${row!.id} WHERE id = ${input.replaces}`;
    }
    return row!.id;
  });
}

/** Removes one's own limit: it is closed, not deleted. */
export async function remove(actorId: number, id: number): Promise<void> {
  await sql.begin(async (tx) => {
    await assertOwn(tx as unknown as typeof sql, actorId, id);
    await tx`UPDATE tag_limit SET expired_at = NOW() WHERE id = ${id}`;
  });
}
