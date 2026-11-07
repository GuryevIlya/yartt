import { z } from 'zod';
import { OpenShift, type AddShiftInput, type CloseShiftInput, type UpdateShiftInput } from '#shared/myDay.ts';
import { AppError } from '../errors.ts';
import { sql, type Sql } from '../pg.ts';

// The timesheet is the employee's until a shift is scored: the triggers
// forbid a shift in the future and any change of a scored one. Moments are
// cut to the minute and never later than now, so a clock a few seconds
// ahead in the browser does not make a shift "future".
const at = (db: Sql, value: Date) => db`LEAST(date_trunc('minute', ${value}::timestamptz), date_trunc('minute', NOW()))`;
// An end may be the end of the current minute: closing rounds it up, so a
// shift started a moment ago is one minute, not zero.
const endAt = (db: Sql, value: Date) =>
  db`LEAST(date_trunc('minute', ${value}::timestamptz), date_trunc('minute', NOW()) + INTERVAL '1 minute')`;

const Minutes = z.object({ minutes: z.number() });

async function minutesBetween(from: Date, to: Date, db: Sql): Promise<number> {
  const [row] = Minutes.array().parse(await db`
    SELECT (extract(epoch FROM ${endAt(db, to)} - ${at(db, from)}) / 60)::int AS minutes
  `);
  if (!row || row.minutes <= 0) throw new AppError('invalid_data');
  return row.minutes;
}

/** My open shift (at most one), or null. */
export async function open(employeeId: number): Promise<OpenShift> {
  const rows = OpenShift.unwrap().array().parse(await sql`
    SELECT started_at FROM work WHERE employee_id = ${employeeId} AND spent_minutes IS NULL
  `);
  return rows[0] ?? null;
}

/**
 * Opens a shift; there is at most one open shift (EXCLUDE: shift_overlap).
 * Started again in the minute a shift was closed, that shift goes on: closing
 * rounded its end up to the end of this minute, so a new shift from now would
 * overlap it, and a person who changed their mind could not go back to work
 * until the next minute.
 */
export async function start(employeeId: number, startedAt: Date): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const resumed = await db`
      UPDATE work SET spent_minutes = NULL
       WHERE employee_id = ${employeeId} AND spent_minutes IS NOT NULL
         AND ${at(db, startedAt)} = date_trunc('minute', NOW())
         AND started_at <= date_trunc('minute', NOW())
         AND started_at + spent_minutes * INTERVAL '1 minute' = date_trunc('minute', NOW()) + INTERVAL '1 minute'
      RETURNING id
    `;
    if (resumed.length === 0) await db`INSERT INTO work (employee_id, started_at) VALUES (${employeeId}, ${at(db, startedAt)})`;
  });
}

/** Closes the open shift with what was done; its start may be corrected. */
export async function close(employeeId: number, input: CloseShiftInput): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const minutes = await minutesBetween(input.startedAt, input.endedAt, db);
    const rows = await db`
      UPDATE work SET started_at = ${at(db, input.startedAt)}, spent_minutes = ${minutes}, about = ${input.about || null}
       WHERE employee_id = ${employeeId} AND spent_minutes IS NULL
      RETURNING employee_id
    `;
    if (rows.length === 0) throw new AppError('not_found');
  });
}

/** Adds a closed shift at once: a suggestion confirmed, a forgotten shift. */
export async function add(employeeId: number, input: AddShiftInput): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const minutes = await minutesBetween(input.startedAt, input.endedAt, db);
    await db`
      INSERT INTO work (employee_id, started_at, spent_minutes, about)
      VALUES (${employeeId}, ${at(db, input.startedAt)}, ${minutes}, ${input.about || null})
    `;
  });
}

/** Corrects a closed shift not scored: its start, end and what was done. */
export async function update(employeeId: number, input: UpdateShiftInput): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const minutes = await minutesBetween(input.newStartedAt, input.endedAt, db);
    const rows = await db`
      UPDATE work SET started_at = ${at(db, input.newStartedAt)}, spent_minutes = ${minutes}, about = ${input.about || null}
       WHERE employee_id = ${employeeId} AND started_at = ${at(db, input.startedAt)} AND spent_minutes IS NOT NULL
      RETURNING employee_id
    `;
    if (rows.length === 0) throw new AppError('not_found');
  });
}

/** Deletes a shift, open or closed, not scored and with no time logged in it. */
export async function remove(employeeId: number, startedAt: Date): Promise<void> {
  const rows = await sql`
    DELETE FROM work WHERE employee_id = ${employeeId} AND started_at = ${at(sql, startedAt)} RETURNING employee_id
  `;
  if (rows.length === 0) throw new AppError('not_found');
}
