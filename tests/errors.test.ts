import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import api from '../server/api.ts';
import { sql } from '../server/pg.ts';
import { client, createEmployee } from './helpers.ts';

describe('error codes', () => {
  test('business errors carry parameters from the database', async () => {
    const boss = await createEmployee();
    const dev = await createEmployee({ managerId: boss.id });

    await expect((await client(dev.id)).Employee.dismiss({ id: boss.id })).rejects.toMatchObject({
      message: 'not_manager',
      cause: { params: { employeeId: boss.id } },
    });
  });
});

describe('error format over HTTP', () => {
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let url: string;

  beforeAll(async () => {
    server = express().use('/api', api).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}/api/trpc`;
  });
  afterAll(() => {
    server.close();
  });

  async function call(path: string, input: unknown) {
    const response = await fetch(`${url}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: input }),
    });
    const body = (await response.json()) as { error: { json: { message: string; data: Record<string, unknown> } } };
    return { status: response.status, error: body.error.json };
  }

  test('health: up and the database answers, with no sign-in', async () => {
    const response = await fetch(url.replace(/\/trpc$/, '/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('an upload without a session is refused before its body is read', async () => {
    const files = url.replace(/\/trpc$/, '/attachments');
    let pulled = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulled++;
        if (pulled > 1000) controller.close();
        else controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const response = await fetch(files, { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ appCode: 'unauthorized' });
    expect(pulled).toBeLessThan(1000);
  });

  test('a change sent again with its id is applied once; a refused one may be sent again', async () => {
    const me = await createEmployee();
    const [session] = await sql<{ s: string }[]>`SELECT start_session(${me.id}) AS s`;
    const change = async (path: string, input: unknown, id: string) => {
      const response = await fetch(`${url}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `yartt_session=${session!.s}`, 'x-yartt-change': id },
        body: JSON.stringify({ json: input }),
      });
      const body = (await response.json()) as { error?: { json: { message: string } } };
      return body.error?.json.message ?? 'ok';
    };
    const tag = `once-${randomUUID()}`;
    const id = randomUUID();
    expect(await change('Task.create', { tags: [tag] }, id)).toBe('ok');
    expect(await change('Task.create', { tags: [tag] }, id)).toBe('change_applied');
    expect(await sql`SELECT 1 FROM task k JOIN tag t ON t.id = ANY(k.tag_ids) WHERE t.name = ${tag}`).toHaveLength(1);

    // Refused (the tag set is taken): its id is not kept, so it is judged again.
    const refused = randomUUID();
    expect(await change('Task.create', { tags: [tag] }, refused)).toBe('tag_set_taken');
    expect(await change('Task.create', { tags: [tag] }, refused)).toBe('tag_set_taken');
  });

  test('validation issues come without server-side messages', async () => {
    const { status, error } = await call('Auth.requestLogin', { email: 'not-an-email' });
    expect(status).toBe(400);
    expect(error.message).toBe('invalid_input');
    expect(error.data.appCode).toBe('invalid_input');
    expect(error.data.issues).toEqual([
      expect.objectContaining({ code: 'invalid_format', format: 'email', path: ['email'] }),
    ]);
    expect(JSON.stringify(error.data.issues)).not.toContain('message');
  });

  test('business error code', async () => {
    const { status, error } = await call('Auth.login', { token: 'nope' });
    expect(status).toBe(400);
    expect(error.data).toMatchObject({ appCode: 'invalid_token' });
  });

  test('no session', async () => {
    const { status, error } = await call('Employee.dismiss', { id: 1 });
    expect(status).toBe(401);
    expect(error.data).toMatchObject({ appCode: 'unauthorized' });
  });
});
