import { randomUUID } from 'node:crypto';
import { sql } from '../server/pg.ts';
import trpc from '../server/trpc/index.ts';
import type { Context } from '../server/ctx.ts';
import { createCallerFactory } from '../server/trpc.ts';

const createCaller = createCallerFactory(trpc);

export type TestClient = ReturnType<typeof createCaller> & {
  cookie: { value: string | null };
};

// Client with a "browser" cookie: login() sets it, logout() clears it.
export async function client(employeeId: number | null = null, sessionToken: string | null = null, bot: Context['bot'] = null): Promise<TestClient> {
  const cookie = { value: sessionToken };
  const ctx: Context = {
    employeeId,
    bot,
    sessionToken,
    setSessionCookie: (token) => { cookie.value = token; },
    clearSessionCookie: () => { cookie.value = null; },
    ssoPending: null,
    setSsoPendingCookie: () => {},
    clearSsoPendingCookie: () => {},
  };
  // The caller is a Proxy where any property is a procedure path; expose cookie ourselves.
  return new Proxy(createCaller(ctx), {
    get: (target, prop, receiver) => (prop === 'cookie' ? cookie : Reflect.get(target, prop, receiver)),
  }) as TestClient;
}

// Client authenticated by a session token, the way ctx.ts does it.
export async function clientBySession(sessionToken: string): Promise<TestClient> {
  const [row] = await sql<{ id: number | null }[]>`SELECT authenticate(${sessionToken}) AS id`;
  return client(row?.id ?? null, sessionToken);
}

export async function createEmployee(fields: { managerId?: number } = {}) {
  const email = `${randomUUID()}@yartt.test`;
  const [row] = await sql<{ id: number }[]>`
    WITH e AS (
      INSERT INTO employee (email, full_name, manager_id)
      VALUES (${email}, ${'Test ' + email.slice(0, 8)}, ${fields.managerId ?? null})
      RETURNING id
    )
    INSERT INTO human (employee_id) SELECT id FROM e RETURNING employee_id AS id
  `;
  return { id: row!.id, email };
}

/**
 * A shift of the employee on their local day `day` that time can be logged
 * in (decision 100): the first one there, or one written for it — a past
 * day's 00:00 to the next midnight, today's open since midnight.
 */
export async function shiftOn(employeeId: number, day: string): Promise<number> {
  const [found] = await sql<{ id: number }[]>`
    SELECT w.id FROM work w JOIN employee e ON e.id = w.employee_id
     WHERE w.employee_id = ${employeeId} AND (w.started_at AT TIME ZONE e.time_zone)::date = ${day}::date
     ORDER BY w.started_at LIMIT 1
  `;
  if (found) return found.id;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO work (employee_id, started_at, spent_minutes)
    SELECT id, ${day}::date::timestamp AT TIME ZONE time_zone, CASE WHEN ${day}::date < local_today(id) THEN 24 * 60 END
      FROM employee WHERE id = ${employeeId}
    RETURNING id
  `;
  return row!.id;
}

/** Logs the employee's time on a task for a day, in their shift of that day (shiftOn). */
export async function logTime(employeeId: number, taskId: number, day: string, minutes: number): Promise<void> {
  await (await client(employeeId)).Time.set({ taskId, shiftId: await shiftOn(employeeId, day), minutes });
}

/** The employee's local day `daysAgo` days back, YYYY-MM-DD. */
export async function dayAgo(employeeId: number, daysAgo: number): Promise<string> {
  const [row] = await sql<{ d: string }[]>`SELECT (local_today(${employeeId}) - ${daysAgo}::int)::text AS d`;
  return row!.d;
}
