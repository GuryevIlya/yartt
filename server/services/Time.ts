import { z } from 'zod';
import type { MyTime } from '#shared/observer.ts';
import { AppError } from '../errors.ts';
import { sql, type Sql } from '../pg.ts';
import { assertCanSee } from './Task.ts';

const MyTimeRow = z.object({ spentMinutes: z.number(), leftMinutes: z.number().nullable(), leftAbout: z.string().nullable() });
const EntryRow = z.object({ shiftId: z.number(), startedAt: z.date(), shiftMinutes: z.number().nullable(), minutes: z.number(), updatedAt: z.date() });
const ShiftRow = z.object({ id: z.number(), startedAt: z.date(), spentMinutes: z.number().nullable(), loggedMinutes: z.number() });

export async function myTime(employeeId: number, taskId: number): Promise<MyTime> {
  await assertCanSee(taskId, employeeId);
  const [row] = MyTimeRow.array().parse(await sql`
    SELECT (SELECT COALESCE(sum(value), 0)::int FROM spent_minutes
             WHERE task_id = ${taskId} AND "by" = ${employeeId}) AS spent_minutes,
           (SELECT value FROM estimate_minutes
             WHERE task_id = ${taskId} AND "by" = ${employeeId} AND expired_at IS NULL) AS left_minutes,
           (SELECT about FROM estimate_minutes
             WHERE task_id = ${taskId} AND "by" = ${employeeId} AND expired_at IS NULL) AS left_about
  `);
  const entries = EntryRow.array().parse(await sql`
    SELECT s.shift_id, w.started_at, w.spent_minutes AS shift_minutes, s.value AS minutes, s.updated_at
      FROM spent_minutes s JOIN work w ON w.id = s.shift_id
     WHERE s.task_id = ${taskId} AND s."by" = ${employeeId}
     ORDER BY w.started_at DESC
  `);
  // The shifts time can still go to: the recent ones, a scored one aside.
  const shifts = ShiftRow.array().parse(await sql`
    SELECT w.id, w.started_at, w.spent_minutes,
           (SELECT COALESCE(sum(s.value), 0)::int FROM spent_minutes s WHERE s.shift_id = w.id) AS logged_minutes
      FROM work w
     WHERE w.employee_id = ${employeeId} AND w.started_at > NOW() - INTERVAL '14 days'
       AND NOT EXISTS (SELECT 1 FROM score sc WHERE sc.shift_id = w.id AND sc.value IS NOT NULL)
     ORDER BY w.started_at DESC
  `);
  return { ...row!, entries, shifts };
}

/**
 * Sets own time on a task in one of one's shifts — the shift's whole time
 * on it, replacing what was there; 0 removes the entry (decision 100). The
 * trigger checks the shift, access, the shift's length and its score.
 */
export async function setShift(employeeId: number, taskId: number, shiftId: number, minutes: number): Promise<void> {
  if (minutes === 0) {
    await sql`DELETE FROM spent_minutes WHERE task_id = ${taskId} AND "by" = ${employeeId} AND shift_id = ${shiftId}`;
    return;
  }
  await sql`
    INSERT INTO spent_minutes (task_id, "by", shift_id, value) VALUES (${taskId}, ${employeeId}, ${shiftId}, ${minutes})
    ON CONFLICT (task_id, "by", shift_id) DO UPDATE SET value = EXCLUDED.value
  `;
}

/** Sets own time left and what it is for; NULL clears it. History is kept: the old value expires. */
export async function setLeft(employeeId: number, taskId: number, minutes: number | null, about: string | null = null): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    await assertCanSee(taskId, employeeId, db);
    await db`
      UPDATE estimate_minutes SET expired_at = NOW()
       WHERE task_id = ${taskId} AND "by" = ${employeeId} AND expired_at IS NULL
    `;
    if (minutes !== null) {
      await db`INSERT INTO estimate_minutes (task_id, "by", value, about) VALUES (${taskId}, ${employeeId}, ${minutes}, ${about})`;
    }
  });
}
