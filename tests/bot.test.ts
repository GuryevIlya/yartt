import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import api from '../server/api.ts';
import { sql } from '../server/pg.ts';
import env from '../server/env.ts';
import { isPrivateAddress } from '../server/webhook.ts';
import { deliverNotifications } from '../server/worker.ts';
import { client, createEmployee } from './helpers.ts';

describe('bots', () => {
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let url: string;
  beforeAll(async () => {
    server = express().use('/api', api).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(() => {
    server.close();
  });

  /** A raw HTTP call to the public API, as a script would make it. */
  async function call(key: string, method: string, path: string, body?: unknown) {
    const response = await fetch(`${url}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as { error?: { code: string; params?: unknown } } & Record<string, unknown> };
  }
  const me = async (key: string) => {
    const answer = await call(key, 'GET', '/me');
    return answer.status === 200 ? answer.body : null;
  };
  const newBot = (permissions: ('task' | 'task.transfer' | 'comment' | 'observers')[] = []) =>
    ({ fullName: 'CI bot', pronoun: null, about: null, permissions, webhookUrl: null });

  test('a person creates a bot; it comments and mentions over HTTP within its permissions', async () => {
    const lead = await createEmployee();
    const leadApi = await client(lead.id);
    const { id, key } = await leadApi.Bot.create(newBot(['comment']));
    expect(key).toMatch(/^yartt_[0-9a-f]{64}$/);
    expect(await me(key)).toMatchObject({ id, kind: 'bot', email: null, managerId: lead.id });

    const task = await leadApi.Task.create({ tags: [`ci-${lead.id}`] });
    await leadApi.Observer.add({ taskId: task, employeeId: id });
    const posted = await call(key, 'POST', `/tasks/${task}/comments`, { markdown: '**Build #512** failed', mentionIds: [lead.id] });
    expect(posted.status).toBe(200);
    expect(JSON.stringify((await leadApi.Comment.list({ taskId: task, filter: 'all', page: 1 })).items)).toContain('<strong>Build #512</strong>');
    expect((await leadApi.MyDay.todo()).map((i) => i.kind)).toContain('mention');

    // Without `task` it creates nothing; what only people do it never does; reading is open.
    const refused = await call(key, 'POST', '/tasks', { tags: [`bot-${id}`] });
    expect([refused.status, refused.body.error?.code]).toEqual([403, 'bot_not_permitted']);
    expect((await call(key, 'GET', '/days')).status).toBe(403);
    expect((await call(key, 'POST', '/visits', {})).status).toBe(404);
    expect((await call(key, 'GET', `/tasks/${task}`)).status).toBe(200);
    expect(await me('yartt_' + '0'.repeat(64))).toBeNull();
    // The interface's API takes no key: it is not a promise to anyone outside.
    expect((await (await fetch(`${url}/trpc/Task.get?input=${encodeURIComponent(JSON.stringify({ json: { id: task } }))}`, { headers: { authorization: `Bearer ${key}` } })).json() as { error?: { json: { message: string } } }).error?.json.message).toBe('unauthorized');
  });

  test('only its direct manager changes it; a new key stops the old one', async () => {
    const lead = await createEmployee();
    const stranger = await createEmployee();
    const above = await createEmployee();
    await (await client(lead.id)).Employee.setManager({ managerId: above.id });
    const leadApi = await client(lead.id);
    const { id, key } = await leadApi.Bot.create(newBot());

    await expect((await client(stranger.id)).Bot.update({ id, ...newBot(['task']) })).rejects.toMatchObject({ message: 'not_manager' });
    await expect((await client(above.id)).Bot.resetKey({ id })).rejects.toMatchObject({ message: 'not_manager' });
    expect(await leadApi.Bot.update({ id, ...newBot(['task', 'task', 'comment']), webhookUrl: 'http://localhost/hook' }))
      .toMatchObject({ permissions: ['task', 'comment'], webhookUrl: 'http://localhost/hook' });

    // Managers above see it, without its webhook secret; strangers do not see it.
    expect((await (await client(above.id)).Bot.list()).find((b) => b.id === id)).toMatchObject({ webhookSecret: null });
    expect((await leadApi.Bot.list()).find((b) => b.id === id)?.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect((await (await client(stranger.id)).Bot.list()).some((b) => b.id === id)).toBe(false);

    const { key: next } = await leadApi.Bot.resetKey({ id });
    expect(await me(key)).toBeNull();
    expect(await me(next)).toMatchObject({ id });
  });

  test('handed over at once: the new manager is told, the old key stops', async () => {
    const lead = await createEmployee();
    const next = await createEmployee();
    const { id, key } = await (await client(lead.id)).Bot.create(newBot());
    await expect((await client(lead.id)).Bot.transfer({ id, toId: id })).rejects.toMatchObject({ message: 'not_found' });

    await (await client(lead.id)).Bot.transfer({ id, toId: next.id });
    expect(await me(key)).toBeNull();
    const rows = await sql<{ payload: unknown }[]>`SELECT payload FROM notification WHERE employee_id = ${next.id}`;
    expect(rows.map((r) => r.payload)).toEqual([{ kind: 'new_report', employeeId: id }]);
    await expect((await client(lead.id)).Bot.resetKey({ id })).rejects.toMatchObject({ message: 'not_manager' });
    expect(await me((await (await client(next.id)).Bot.resetKey({ id })).key)).toMatchObject({ managerId: next.id });
  });

  test('when its manager is dismissed it moves up with a key nobody knows; dismissed, it stops', async () => {
    const top = await createEmployee();
    const lead = await createEmployee({ managerId: top.id });
    const { id, key } = await (await client(lead.id)).Bot.create(newBot());
    await (await client(top.id)).Employee.dismiss({ id: lead.id });
    expect(await me(key)).toBeNull();

    const { key: fresh } = await (await client(top.id)).Bot.resetKey({ id });
    expect(await me(fresh)).toMatchObject({ managerId: top.id });
    await (await client(top.id)).Employee.dismiss({ id });
    expect(await me(fresh)).toBeNull();
  });

  test('a bot has no timesheet, time or scores, manages nobody and has no email', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee();
    const { id } = await (await client(lead.id)).Bot.create(newBot());
    await expect(sql`INSERT INTO work (employee_id, started_at) VALUES (${id}, NOW())`).rejects.toMatchObject({ code: '23503' });
    await expect(sql`INSERT INTO visit (employee_id) VALUES (${id})`).rejects.toMatchObject({ code: '23503' });
    await expect((await client(dev.id)).Employee.setManager({ managerId: id })).rejects.toMatchObject({ message: 'not_found' });
    await expect(sql`UPDATE employee SET manager_id = ${id} WHERE id = ${dev.id}`).rejects.toMatchObject({ code: '23503' });
    await expect(sql`UPDATE employee SET email = 'bot@example.com' WHERE id = ${id}`)
      .rejects.toMatchObject({ constraint_name: 'chk_employee_bot_email' });
    await expect(sql`UPDATE employee SET manager_id = NULL WHERE id = ${id}`)
      .rejects.toMatchObject({ constraint_name: 'chk_employee_bot_manager' });
    // A bot cannot create bots; nobody exists without the row of their kind.
    await expect((await client(id, null, ['task'])).Bot.create(newBot())).rejects.toMatchObject({ message: 'bot_not_permitted' });
    await expect(sql`INSERT INTO employee (full_name) VALUES ('Nobody')`).rejects.toMatchObject({ hint: 'invalid_data' });
  });

  test('its activity over a range: calls and refusals, comments and mentions, tasks', async () => {
    const lead = await createEmployee();
    const leadApi = await client(lead.id);
    const { id, key } = await leadApi.Bot.create(newBot(['comment', 'task']));
    const task = (await call(key, 'POST', '/tasks', { tags: [`stats-${id}`] })).body as unknown as number;
    await call(key, 'POST', `/tasks/${task}/comments`, { html: '<p>Up</p>', mentionIds: [lead.id] });
    await call(key, 'POST', `/tasks/${task}/transfer`, { ownerId: lead.id }); // no task.transfer: refused
    await call(key, 'GET', `/tasks/${task}`);

    const today = new Date().toISOString().slice(0, 10);
    const [stats] = (await leadApi.Bot.stats({ since: today })).filter((b) => b.id === id);
    expect(stats).toMatchObject({ openTasks: 1, comments: 1, mentions: 1, requests: 4, refused: 1, deliveries: 0 });
    expect(stats!.daily).toEqual([{ day: today, requests: 4, refused: 1 }]);
    expect(stats!.lastRequestAt).toBeInstanceOf(Date);
    expect(await (await client((await createEmployee()).id)).Bot.stats({ since: today })).toEqual([]);
  });

  test('a key a year old is told to its manager once a year; replacing it starts again', async () => {
    const lead = await createEmployee();
    const leadApi = await client(lead.id);
    const { id } = await leadApi.Bot.create(newBot());
    const told = async () => (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notification WHERE employee_id = ${lead.id} AND payload->>'kind' = 'bot_key_old'
    `)[0]!.n;
    await sql`SELECT send_bot_key_reminders()`;
    expect(await told()).toBe(0);

    await sql`UPDATE bot SET key_issued_at = NOW() - INTERVAL '400 days' WHERE employee_id = ${id}`;
    await sql`SELECT send_bot_key_reminders()`;
    await sql`SELECT send_bot_key_reminders()`;
    expect(await told()).toBe(1);
    const [row] = await sql<{ payload: unknown }[]>`
      SELECT payload FROM notification WHERE employee_id = ${lead.id} AND payload->>'kind' = 'bot_key_old'
    `;
    expect(row!.payload).toMatchObject({ kind: 'bot_key_old', employeeId: id, issuedAt: expect.stringMatching(/Z$/) });

    // A year later, once more.
    await sql`UPDATE bot SET key_reminded_at = NOW() - INTERVAL '366 days' WHERE employee_id = ${id}`;
    await sql`SELECT send_bot_key_reminders()`;
    expect(await told()).toBe(2);
    await leadApi.Bot.resetKey({ id });
    await sql`SELECT send_bot_key_reminders()`;
    expect(await told()).toBe(2);
  });

  describe('a person\'s key', () => {
    const key = async (id: number, rights: ('tasks.read' | 'tasks.write' | 'comments.write' | 'participants.write' | 'reports.read')[], days: 30 | 90 | 365 = 30) =>
      (await (await client(id)).ApiKey.create({ name: 'скрипт', rights, days })).key;

    test('it acts in its owner\'s name with only the rights ticked, and shows it is in use', async () => {
      const me_ = await createEmployee();
      const api = await client(me_.id);
      const task = await api.Task.create({ tags: [`key-${me_.id}`] });
      const reader = await key(me_.id, ['tasks.read']);
      expect(reader).toMatch(/^yartt_k_[0-9a-f]{64}$/);
      expect(await me(reader)).toMatchObject({ id: me_.id });
      expect((await call(reader, 'GET', `/tasks/${task}`)).status).toBe(200);
      const refused = await call(reader, 'POST', `/tasks/${task}/comments`, { html: '<p>x</p>' });
      expect([refused.status, refused.body.error?.code]).toEqual([403, 'key_not_permitted']);
      expect((await call(reader, 'GET', '/days')).status).toBe(403);

      const writer = await key(me_.id, ['tasks.write', 'comments.write']);
      const made = await call(writer, 'POST', '/tasks', { tags: [`key2-${me_.id}`], markdown: '# Заголовок', deadline: new Date(Date.now() + 86_400_000).toISOString() });
      expect(made.status).toBe(200);
      const created = made.body as unknown as number;
      expect((await api.Task.get({ id: created })).details?.context).toContain('<h1>');
      expect((await call(writer, 'POST', `/tasks/${created}/close`)).status).toBe(204);
      expect((await api.ApiKey.list()).find((k) => k.rights.includes('tasks.read'))?.lastUsedAt).toBeInstanceOf(Date);
      expect((await call(reader, 'GET', '/tasks/999999999')).status).toBe(404);
      expect((await call(writer, 'POST', '/tasks', { tags: [] })).body.error?.code).toBe('invalid_input');

      // No key makes keys, and the time cannot be written at all.
      expect((await call(writer, 'POST', '/api-keys', {})).status).toBe(404);
      expect((await call(writer, 'POST', '/time', {})).status).toBe(404);
    });

    test('it ends when revoked, expired or when its owner is dismissed; another\'s is out of reach', async () => {
      const boss = await createEmployee();
      const dev = await createEmployee({ managerId: boss.id });
      const api = await client(dev.id);
      const revoked = await key(dev.id, ['tasks.read']);
      const [listed] = await api.ApiKey.list();
      await expect((await client(boss.id)).ApiKey.revoke({ id: listed!.id })).rejects.toMatchObject({ message: 'not_found' });
      await api.ApiKey.revoke({ id: listed!.id });
      expect(await me(revoked)).toBeNull();

      const expired = await key(dev.id, ['tasks.read']);
      await sql`UPDATE api_key SET expires_at = NOW() - INTERVAL '1 minute' WHERE employee_id = ${dev.id} AND revoked_at IS NULL`;
      expect(await me(expired)).toBeNull();
      expect(await api.ApiKey.list()).toEqual([]);

      const working = await key(dev.id, ['reports.read']);
      expect((await call(working, 'GET', '/days')).status).toBe(200);
      await (await client(boss.id)).Employee.dismiss({ id: dev.id });
      expect(await me(working)).toBeNull();
    });

    test('the description of the API needs no key and lists what is on offer', async () => {
      const response = await fetch(`${url}/v1/openapi.json`);
      const description = await response.json() as { paths: Record<string, Record<string, { summary: string; 'x-right'?: string }>> };
      expect(description.paths['/tasks/{id}']?.get?.['x-right']).toBe('tasks.read');
      expect(Object.keys(description.paths).some((p) => /score|time|work|key|webhook/i.test(p))).toBe(false);
    });
  });

  describe('its webhook', () => {
    beforeEach(async () => {
      // Other test files leave notifications behind; start from an empty queue.
      await sql`UPDATE notification SET sent_at = NOW() WHERE sent_at IS NULL`;
    });

    test('gets its notifications as JSON signed with its own secret; a failing one does not hold the queue', async () => {
      const got: { body: string; signature: string; timestamp: string }[] = [];
      let status = 200;
      const hook = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          got.push({ body, signature: String(req.headers['x-yartt-signature']), timestamp: String(req.headers['x-yartt-timestamp']) });
          res.writeHead(status).end();
        });
      }).listen(0);
      await new Promise((resolve) => hook.once('listening', resolve));
      try {
        const lead = await createEmployee();
        const leadApi = await client(lead.id);
        const { id } = await leadApi.Bot.create({ ...newBot(), webhookUrl: `http://localhost:${(hook.address() as AddressInfo).port}/hook` });
        const secret = (await leadApi.Bot.list()).find((b) => b.id === id)!.webhookSecret!;
        const task = await leadApi.Task.create({ tags: [`hook-${id}`] });
        await leadApi.Observer.add({ taskId: task, employeeId: id }); // only a participant can be mentioned
        expect(await deliverNotifications(sql)).toBe(1); // access_opened
        got.length = 0;
        await leadApi.Comment.create({ taskId: task, html: '<p>Deploy?</p>', replyToId: null, files: [], mentionIds: [id], taskIds: [] });

        expect(await deliverNotifications(sql)).toBe(1);
        expect(got).toHaveLength(1);
        const { body, signature, timestamp } = got[0]!;
        expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
        expect(signature).toBe(`sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`);
        expect(JSON.parse(body)).toMatchObject({
          version: 1, kind: 'mention', taskId: task, to: { employeeId: id, kind: 'bot', email: null }, data: { by: lead.id },
        });

        // Down: one attempt, then the people behind it get theirs.
        status = 500;
        await leadApi.Comment.create({ taskId: task, html: '<p>Again?</p>', replyToId: null, files: [], mentionIds: [id], taskIds: [] });
        const dev = await createEmployee();
        await (await client(dev.id)).Employee.setManager({ managerId: lead.id });
        expect(await deliverNotifications(sql)).toBe(2);
        expect(got).toHaveLength(2);
        const today = new Date().toISOString().slice(0, 10);
        expect((await leadApi.Bot.stats({ since: today })).find((b) => b.id === id))
          .toMatchObject({ deliveries: 3, failedDeliveries: 1 });
      } finally {
        hook.close();
      }
    });

    test('never reaches inside the network, unless its host is listed as internal', async () => {
      let hits = 0;
      const hook = createServer((_req, res) => { hits++; res.writeHead(200).end(); }).listen(0);
      await new Promise((resolve) => hook.once('listening', resolve));
      try {
        const port = (hook.address() as AddressInfo).port;
        const lead = await createEmployee();
        const leadApi = await client(lead.id);
        // Listed (WEBHOOK_ALLOWED_URLS=http://localhost/ in the tests): reached.
        const listed = await leadApi.Bot.create({ ...newBot(), webhookUrl: `http://localhost:${port}/hook` });
        const task = await leadApi.Task.create({ tags: [`inside-${listed.id}`] });
        await leadApi.Observer.add({ taskId: task, employeeId: listed.id });
        await deliverNotifications(sql);
        expect(hits).toBe(1);
        // Nothing listed: outside the network only. Refused, and counted as a failed delivery.
        env.WEBHOOK_ALLOWED_URLS = [];
        const inside = await leadApi.Bot.create({ ...newBot(), webhookUrl: `http://127.0.0.1:${port}/hook` });
        await leadApi.Observer.add({ taskId: task, employeeId: inside.id });
        await deliverNotifications(sql);
        expect(hits).toBe(1);
        const today = new Date().toISOString().slice(0, 10);
        const stats = await leadApi.Bot.stats({ since: today });
        expect(stats.find((b) => b.id === inside.id)).toMatchObject({ deliveries: 1, failedDeliveries: 1 });
      } finally {
        env.WEBHOOK_ALLOWED_URLS = ['http://localhost/'];
        hook.close();
      }
    });
  });
});

test('addresses inside the network', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-address']) {
    expect(isPrivateAddress(address), address).toBe(true);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '::ffff:808:808', '2a00:1450:4001::1']) {
    expect(isPrivateAddress(address), address).toBe(false);
  }
});
