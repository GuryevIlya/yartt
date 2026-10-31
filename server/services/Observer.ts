import { z } from 'zod';
import type { Mentionable, People, Period, Person } from '#shared/observer.ts';
import { sql, type Sql } from '../pg.ts';
import { assertCanSee } from './Task.ts';

export const PAGE_SIZE = 10;

const PersonRow = z.object({
  employeeId: z.number(),
  lastVisit: z.date().nullable(),
  spentMinutes: z.number(),
  leftMinutes: z.number().nullable(),
  active: z.boolean(),
  isOwner: z.boolean(),
  observingReport: z.number().nullable(),
  openMention: z.boolean(),
  total: z.number(),
});
const PeriodRow = z.object({
  value: z.number(),
  addedAt: z.date(),
  deletedAt: z.date().nullable(),
  addedBy: z.number().nullable(),
  deletedBy: z.number().nullable(),
});
const RequestRow = z.object({ employeeId: z.number() });
const Bool = z.object({ value: z.boolean() });

/**
 * People of a task with their time. A private task: everyone who ever
 * observed it; a public one: everyone who opened it or logged time.
 * Sorted by the last visit, newest first.
 */
export async function list(viewerId: number, taskId: number, page: number): Promise<People> {
  await assertCanSee(taskId, viewerId);
  const [pub] = Bool.array().parse(await sql`SELECT is_public(${taskId}) AS value`);

  const people = pub!.value
    ? sql`SELECT employee_id AS id FROM visit WHERE task_id = ${taskId}
          UNION SELECT "by" FROM spent_minutes WHERE task_id = ${taskId}`
    : sql`SELECT DISTINCT value AS id FROM observer WHERE task_id = ${taskId} AND added_at IS NOT NULL`;

  const rows = PersonRow.array().parse(await sql`
    WITH people AS (${people})
    SELECT p.id AS employee_id,
           (SELECT max(at) FROM visit v WHERE v.task_id = ${taskId} AND v.employee_id = p.id) AS last_visit,
           (SELECT COALESCE(sum(value), 0)::int FROM spent_minutes s
             WHERE s.task_id = ${taskId} AND s."by" = p.id) AS spent_minutes,
           (SELECT value FROM estimate_minutes m
             WHERE m.task_id = ${taskId} AND m."by" = p.id AND m.expired_at IS NULL) AS left_minutes,
           is_observer(${taskId}, p.id) AS active,
           (k.owner_id IS NOT DISTINCT FROM p.id) AS is_owner,
           (SELECT o.value FROM observer o
             WHERE o.task_id = ${taskId} AND o.added_at IS NOT NULL AND o.deleted_at IS NULL
               AND o.value IN (SELECT subordinates(p.id))
             ORDER BY o.value LIMIT 1) AS observing_report,
           EXISTS (SELECT 1 FROM mention m
                    WHERE m.task_id = ${taskId} AND m.value = p.id AND m.closed_at IS NULL) AS open_mention,
           count(*) OVER ()::int AS total
      FROM people p
      JOIN task k ON k.id = ${taskId}
     ORDER BY last_visit DESC NULLS LAST, p.id
     LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
  `);

  const periods = PeriodRow.array().parse(await sql`
    SELECT value, added_at, deleted_at, added_by, deleted_by
      FROM observer
     WHERE task_id = ${taskId} AND added_at IS NOT NULL AND value = ANY(${rows.map((r) => r.employeeId)})
     ORDER BY added_at
  `);
  const periodsOf = (id: number): Period[] =>
    periods
      .filter((p) => p.value === id)
      // Leaving by oneself is not "removed by".
      .map((p) => ({ from: p.addedAt, to: p.deletedAt, addedBy: p.addedBy, removedBy: p.deletedBy === id ? null : p.deletedBy }));

  const items: Person[] = rows.map((r) => ({
    employeeId: r.employeeId,
    lastVisit: r.lastVisit,
    spentMinutes: r.spentMinutes,
    leftMinutes: r.leftMinutes,
    active: r.active,
    lockedBy: !r.active ? null : r.isOwner ? 'owner' : r.observingReport,
    openMention: r.openMention,
    periods: pub!.value ? [] : periodsOf(r.employeeId),
  }));

  const requests = RequestRow.array().parse(await sql`
    SELECT value AS employee_id FROM observer
     WHERE task_id = ${taskId} AND added_at IS NULL AND deleted_at IS NULL
     ORDER BY id
  `);
  const [sums] = z.object({ spentMinutes: z.number(), leftMinutes: z.number() }).array().parse(await sql`
    SELECT (SELECT COALESCE(sum(value), 0) FROM spent_minutes WHERE task_id = ${taskId})::int AS spent_minutes,
           (SELECT COALESCE(sum(value), 0) FROM estimate_minutes WHERE task_id = ${taskId} AND expired_at IS NULL)::int AS left_minutes
  `);
  return { requests, items, total: rows[0]?.total ?? 0, ...sums! };
}

/** Whom a comment may mention: a private task's active participants, or anyone in a public one. */
export async function mentionable(viewerId: number, taskId: number, db: Sql = sql): Promise<Mentionable> {
  await assertCanSee(taskId, viewerId, db);
  const [pub] = Bool.array().parse(await db`SELECT is_public(${taskId}) AS value`);
  const rows = z.object({ id: z.number() }).array().parse(await db`
    SELECT value AS id FROM observer WHERE task_id = ${taskId} AND added_at IS NOT NULL AND deleted_at IS NULL
  `);
  // Everyone in the task, or everyone working in a public one: people, not bots (decision 95).
  const people = z.object({ id: z.number() }).array().parse(await db`
    SELECT id FROM employee
     WHERE kind = 'human' AND dismissed_at IS NULL
       AND (${pub!.value} OR id = ANY(${rows.map((r) => r.id)}))
     ORDER BY id
  `);
  return { everyone: pub!.value, ids: pub!.value ? [] : rows.map((r) => r.id), people: people.map((r) => r.id) };
}

export async function add(actorId: number, taskId: number, employeeId: number): Promise<void> {
  await sql`SELECT add_observer(${taskId}, ${employeeId}, ${actorId})`;
}

export async function remove(actorId: number, taskId: number, employeeId: number): Promise<void> {
  await sql`SELECT remove_observer(${taskId}, ${employeeId}, ${actorId})`;
}

export async function leave(employeeId: number, taskId: number): Promise<void> {
  await sql`SELECT leave_task(${taskId}, ${employeeId})`;
}

export async function request(employeeId: number, taskId: number): Promise<void> {
  await sql`SELECT request_access(${taskId}, ${employeeId})`;
}

export async function withdraw(employeeId: number, taskId: number): Promise<void> {
  await sql`SELECT withdraw_access(${taskId}, ${employeeId})`;
}

export async function approve(actorId: number, taskId: number, employeeId: number): Promise<void> {
  await sql`SELECT approve_access(${taskId}, ${employeeId}, ${actorId})`;
}

export async function reject(actorId: number, taskId: number, employeeId: number): Promise<void> {
  await sql`SELECT reject_access(${taskId}, ${employeeId}, ${actorId})`;
}
