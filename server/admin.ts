// Installation administrator commands, run in the image next to the server:
//   node server/admin.ts dismiss <email> --heir <email>
//   node server/admin.ts deliveries [--retry]
// Not in the API on purpose: there are no admins in the product (AGENTS.md);
// whoever runs the installation already holds its database. See docs/admin/install.md.
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { sql } from './pg.ts';

const Row = z.object({ id: z.number(), fullName: z.string() });

async function byEmail(email: string) {
  const [row] = Row.array().parse(await sql`SELECT id, full_name FROM employee WHERE email = ${email} AND dismissed_at IS NULL`);
  if (!row) throw new Error(`No active employee with email ${email}`);
  return row;
}

const Failure = z.object({
  id: z.string(),
  email: z.string().nullable(),
  kind: z.string().nullable(),
  attempts: z.number(),
  firstFailedAt: z.date(),
  nextAttemptAt: z.date().nullable(),
  error: z.string(),
});

/**
 * People's notifications that could not be delivered (notification_failure):
 * waiting for another attempt, or given up. `retry` — try all of them now,
 * once the mail server or the webhook is fixed.
 */
async function deliveries(retry: boolean): Promise<void> {
  if (retry) {
    const updated = await sql`UPDATE notification_failure SET next_attempt_at = NOW(), first_failed_at = NOW()`;
    console.log(`${updated.count} notifications will be tried again now.`);
    return;
  }
  const rows = Failure.array().parse(await sql`
    SELECT f.notification_id AS id, e.email, n.payload->>'kind' AS kind, f.attempts, f.first_failed_at, f.next_attempt_at, f.error
      FROM notification_failure f
      JOIN notification n ON n.id = f.notification_id
      JOIN employee e ON e.id = n.employee_id
     ORDER BY f.first_failed_at
  `);
  if (rows.length === 0) {
    console.log('Every notification was delivered.');
    return;
  }
  for (const r of rows) {
    const state = r.nextAttemptAt ? `next attempt ${r.nextAttemptAt.toISOString()}` : 'given up';
    console.log(`#${r.id} ${r.kind ?? '?'} to ${r.email ?? '(no email)'}: ${r.attempts} attempts since ${r.firstFailedAt.toISOString()}, ${state}\n    ${r.error}`);
  }
  const given = rows.filter((r) => r.nextAttemptAt === null).length;
  console.log(`${rows.length} not delivered, ${given} given up. Fixed the cause? node server/admin.ts deliveries --retry`);
}

const usage = 'Usage:\n  node server/admin.ts dismiss <email> --heir <email>\n  node server/admin.ts deliveries [--retry]';
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { heir: { type: 'string' }, retry: { type: 'boolean' } },
});
let code = 0;
try {
  const [command, email] = positionals;
  if (command === 'deliveries') {
    await deliveries(values.retry === true);
  } else {
    if (command !== 'dismiss' || !email || !values.heir) throw new Error(usage);
    const employee = await byEmail(email);
    const heir = await byEmail(values.heir);
    await sql`SELECT dismiss_with_heir(${employee.id}, ${heir.id})`;
    console.log(`Dismissed ${employee.fullName}; their tasks and team went to ${heir.fullName}, who can bring them back.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  code = 1;
}
await sql.end({ timeout: 5 });
process.exit(code);
