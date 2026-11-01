import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message } from '../server/delivery.ts';
import env from '../server/env.ts';
import { sql } from '../server/pg.ts';
import { deliverNotifications } from '../server/worker.ts';
import { createEmployee } from './helpers.ts';

const sent: (Message & { mail: boolean })[] = [];
let failNext = false;
/** Deliveries to these people fail, as to a mailbox the mail server refuses. */
const broken = new Set<number>();
/** The email of the next delivery goes, then its webhook fails. */
let webhookFailsNext = false;
vi.mock('../server/delivery.ts', () => ({
  deliver: async (message: Message, options: { mail?: boolean } = {}) => {
    if (failNext || (message.to.employeeId !== null && broken.has(message.to.employeeId))) {
      failNext = false;
      throw new Error('550 mailbox unavailable');
    }
    if (webhookFailsNext) {
      webhookFailsNext = false;
      sent.push({ ...message, mail: options.mail !== false });
      throw Object.assign(new Error('Webhook responded with 500'), { mailed: options.mail !== false });
    }
    sent.push({ ...message, mail: options.mail !== false });
  },
}));

beforeEach(async () => {
  sent.length = 0;
  broken.clear();
  // Other test files leave notifications behind; start from an empty queue.
  await sql`UPDATE notification SET sent_at = NOW() WHERE sent_at IS NULL`;
  await sql`DELETE FROM notification_failure`;
});

const unsent = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification WHERE sent_at IS NULL`)[0]!.n;

describe('notification delivery', () => {
  test('parsed payloads are delivered and marked as sent', async () => {
    const boss = await createEmployee();
    const dev = await createEmployee();
    await sql`UPDATE employee SET locale = 'en' WHERE id = ${boss.id}`;
    await sql`UPDATE employee SET manager_id = ${boss.id} WHERE id = ${dev.id}`;

    expect(await deliverNotifications(sql)).toBe(1);
    expect(sent).toEqual([
      {
        to: expect.objectContaining({ employeeId: boss.id, locale: 'en' }),
        taskId: null,
        payload: { kind: 'new_report', employeeId: dev.id },
        mail: true,
      },
    ]);
    expect(await unsent()).toBe(0);
  });

  test('a deadline change waits a minute to settle before it goes out', async () => {
    const me = await createEmployee();
    await sql`SELECT notify(${me.id}, NULL, ${sql.json({ kind: 'finished_at_change', dependencyId: 1, late: false })})`;
    expect(await deliverNotifications(sql)).toBe(0);
    expect(await unsent()).toBe(1);

    await sql`UPDATE notification SET added_at = added_at - INTERVAL '1 minute' WHERE employee_id = ${me.id}`;
    expect(await deliverNotifications(sql)).toBe(1);
    expect(sent.map((m) => m.payload.kind)).toEqual(['finished_at_change']);
  });

  test('the demo sends nothing: its people are made up, the queue is only marked sent', async () => {
    const boss = await createEmployee();
    const dev = await createEmployee();
    await sql`UPDATE employee SET manager_id = ${boss.id} WHERE id = ${dev.id}`;
    env.DEMO_DATA = 'ru';
    try {
      await deliverNotifications(sql);
    } finally {
      env.DEMO_DATA = undefined;
    }
    expect(sent).toEqual([]);
    expect(await unsent()).toBe(0);
    const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification WHERE employee_id = ${boss.id} AND closed_at IS NULL`;
    expect(left!.n).toBe(1); // still in the bell
  });

  test('a failed delivery waits for its next attempt, an invalid payload is skipped', async () => {
    const me = await createEmployee();
    await sql`INSERT INTO notification (employee_id, payload) VALUES (${me.id}, ${sql.json({ kind: 'nonsense' })})`;
    await sql`SELECT notify(${me.id}, NULL, ${sql.json({ kind: 'invite', by: me.id })})`;

    failNext = true;
    expect(await deliverNotifications(sql)).toBe(2);
    expect(await unsent()).toBe(1); // the invalid one skipped, the failed one waits
    expect(await deliverNotifications(sql)).toBe(0); // not before its time

    await sql`UPDATE notification_failure SET next_attempt_at = NOW()`;
    expect(await deliverNotifications(sql)).toBe(1);
    expect(sent.map((m) => m.payload.kind)).toEqual(['invite']);
    expect(await unsent()).toBe(0);
    expect(await sql`SELECT 1 FROM notification_failure`).toHaveLength(0);
  });

  test('one broken address never holds the queue: the others go on', async () => {
    const lost = await createEmployee();
    const fine = await createEmployee();
    broken.add(lost.id);
    await sql`SELECT notify(${lost.id}, NULL, ${sql.json({ kind: 'invite', by: fine.id })})`;
    await sql`SELECT notify(${fine.id}, NULL, ${sql.json({ kind: 'invite', by: lost.id })})`;

    await deliverNotifications(sql);
    expect(sent.map((m) => m.to.employeeId)).toEqual([fine.id]);
    const [failure] = await sql<{ attempts: number; error: string; inMinutes: number }[]>`
      SELECT attempts, error, round(extract(epoch FROM next_attempt_at - NOW()) / 60)::int AS in_minutes FROM notification_failure
    `;
    expect(failure).toEqual({ attempts: 1, error: '550 mailbox unavailable', inMinutes: 1 });
  });

  test('attempts come after 1, 5 and 15 minutes, then hourly, and stop after three days', async () => {
    const me = await createEmployee();
    broken.add(me.id);
    await sql`SELECT notify(${me.id}, NULL, ${sql.json({ kind: 'invite', by: me.id })})`;
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      await sql`UPDATE notification_failure SET next_attempt_at = NOW()`;
      await deliverNotifications(sql);
      const [row] = await sql<{ m: number }[]>`SELECT round(extract(epoch FROM next_attempt_at - NOW()) / 60)::int AS m FROM notification_failure`;
      waits.push(row!.m);
    }
    expect(waits).toEqual([1, 5, 15, 60, 60]);

    await sql`UPDATE notification_failure SET first_failed_at = NOW() - INTERVAL '3 days', next_attempt_at = NOW()`;
    await deliverNotifications(sql);
    const [given] = await sql<{ next: Date | null; attempts: number }[]>`SELECT next_attempt_at AS next, attempts FROM notification_failure`;
    expect(given).toEqual({ next: null, attempts: 6 });
    // Given up: never taken again, kept for the administrator.
    await deliverNotifications(sql);
    expect(await unsent()).toBe(1);
    expect((await sql<{ attempts: number }[]>`SELECT attempts FROM notification_failure`)[0]!.attempts).toBe(6);
  });

  test('when the webhook fails after the email went, the next attempt does not mail again', async () => {
    const me = await createEmployee();
    await sql`SELECT notify(${me.id}, NULL, ${sql.json({ kind: 'invite', by: me.id })})`;
    webhookFailsNext = true;
    await deliverNotifications(sql);
    await sql`UPDATE notification_failure SET next_attempt_at = NOW()`;
    await deliverNotifications(sql);
    expect(sent.map((m) => m.mail)).toEqual([true, false]);
    expect(await unsent()).toBe(0);
  });
});
