import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WEBHOOK_GROUPS, type WebhookLevels } from '#shared/webhook.ts';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message } from '../server/delivery.ts';
import env from '../server/env.ts';
import { sql } from '../server/pg.ts';
import { deliverNotifications, runJobNamed } from '../server/worker.ts';
import { client, createEmployee } from './helpers.ts';

const sent: (Message & { mail: boolean })[] = [];
let failNext = false;
/** Deliveries to these people fail, as to a mailbox the mail server refuses. */
const broken = new Set<number>();
vi.mock('../server/delivery.ts', () => ({
  deliver: async (message: Message, options: { mail?: boolean } = {}) => {
    if (failNext || (message.to.employeeId !== null && broken.has(message.to.employeeId))) {
      failNext = false;
      throw new Error('550 mailbox unavailable');
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

  test('a person\'s webhook gets as much as they chose, a failure is tried again a few times', async () => {
    const received: Record<string, unknown>[] = [];
    let answer = 200;
    const hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => { received.push(JSON.parse(body) as Record<string, unknown>); res.writeHead(answer).end(); });
    }).listen(0);
    await new Promise((resolve) => hook.once('listening', resolve));
    try {
      const me = await createEmployee();
      const levels = { mentions: 'text', comments: 'title', deadlines: 'off', links: 'event', access: 'event', handover: 'event', reminders: 'event', scores: 'event', other: 'event' };
      const api = await client(me.id);
      const webhook = await api.Webhook.create({ url: `http://localhost:${(hook.address() as AddressInfo).port}/h`, levels: levels as never });
      const task = await api.Task.create({ tags: [`w-${randomUUID().slice(0, 8)}`] });
      const other = await createEmployee();
      await api.Observer.add({ taskId: task, employeeId: other.id });
      const otherApi = await client(other.id);
      const commentId = await otherApi.Comment.create({ taskId: task, html: '<p>Секрет задачи</p>', replyToId: null, files: [], mentionIds: [me.id], everyone: false, exceptIds: [], taskIds: [] });
      await deliverNotifications(sql);

      const mention = received.find((b) => b.kind === 'mention')!;
      expect(mention).toMatchObject({ version: 2, taskId: task, comment: 'Секрет задачи' });
      const comment = received.find((b) => b.kind === 'comment')!;
      expect(comment.subject).toBeTruthy();
      expect(comment.comment).toBeUndefined();
      expect(comment.text).toBeUndefined();
      expect(commentId).toBeGreaterThan(0);

      // Off: nothing. A failure is noted for its owner, and the notification is not held.
      received.length = 0;
      answer = 500;
      await otherApi.Comment.create({ taskId: task, html: '<p>Ещё</p>', replyToId: null, files: [], mentionIds: [], everyone: false, exceptIds: [], taskIds: [] });
      await deliverNotifications(sql);
      expect(await unsent()).toBe(0);
      expect((await api.Webhook.list()).find((w: { id: number }) => w.id === webhook.id)?.lastError).toContain('500');
      // Tried again apart from the queue; once taken, it is gone and the error with it.
      const [waiting] = await sql<{ id: string }[]>`SELECT id FROM webhook_retry WHERE webhook_id = ${webhook.id}`;
      expect(waiting).toBeTruthy();
      answer = 200;
      await sql`UPDATE webhook_retry SET next_at = NOW() WHERE webhook_id = ${webhook.id}`;
      received.length = 0;
      await runJobNamed(sql, 'webhook_retries');
      expect(received).toHaveLength(1);
      expect((await sql`SELECT 1 FROM webhook_retry WHERE webhook_id = ${webhook.id}`).length).toBe(0);
      expect((await api.Webhook.list()).find((w: { id: number }) => w.id === webhook.id)?.lastError).toBeNull();
      // After the last attempt it is dropped.
      answer = 500;
      await sql`INSERT INTO webhook_retry (webhook_id, body, attempts, next_at) VALUES (${webhook.id}, '{}', 4, NOW())`;
      await runJobNamed(sql, 'webhook_retries');
      expect((await sql`SELECT 1 FROM webhook_retry WHERE webhook_id = ${webhook.id}`).length).toBe(0);
      // Someone else's webhook is out of reach.
      await expect(otherApi.Webhook.remove({ id: webhook.id })).rejects.toMatchObject({ message: 'not_found' });
    } finally {
      hook.close();
    }
  });

  test('an address the administrator does not allow is refused', async () => {
    const api = await client((await createEmployee()).id);
    const levels = Object.fromEntries(WEBHOOK_GROUPS.map((g) => [g, 'event'])) as WebhookLevels;
    await expect(api.Webhook.create({ url: 'https://evil.example/h', levels })).rejects.toMatchObject({ message: 'webhook_url_not_allowed' });
    await expect(api.Webhook.create({ url: 'http://localhost.evil.example/h', levels })).rejects.toMatchObject({ message: 'webhook_url_not_allowed' });
    await expect(api.Webhook.create({ url: 'http://localhost@evil.example/h', levels })).rejects.toMatchObject({ message: 'webhook_url_not_allowed' });
  });
});
