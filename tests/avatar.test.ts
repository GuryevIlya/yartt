import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import api from '../server/api.ts';
import { sql } from '../server/pg.ts';
import { client, createEmployee } from './helpers.ts';

describe('avatars over HTTP', () => {
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let url: string;

  beforeAll(async () => {
    server = express().use('/api', api).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}/api/avatars`;
  });
  afterAll(() => {
    server.close();
  });

  async function cookieOf(email: string): Promise<string> {
    const [token] = await sql<{ t: string }[]>`SELECT issue_token(${email}, 'browser') AS t`;
    const [session] = await sql<{ s: string }[]>`SELECT login(${token!.t}, 'browser') AS s`;
    return `yartt_session=${session!.s}`;
  }

  test('mine to set and delete, everyone signed in to see; only png, jpeg, webp', async () => {
    const me = await createEmployee();
    const other = await createEmployee();
    const cookie = await cookieOf(me.email);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');

    expect((await fetch(url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png })).status).toBe(401);
    expect((await fetch(url, { method: 'PUT', headers: { cookie, 'content-type': 'image/svg+xml' }, body: '<svg/>' })).status).toBe(400);
    expect((await fetch(url, { method: 'PUT', headers: { cookie, 'content-type': 'image/png' }, body: png })).status).toBe(204);

    const seen = await fetch(`${url}/${me.id}`, { headers: { cookie: await cookieOf(other.email) } });
    expect(seen.status).toBe(200);
    expect(seen.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await seen.arrayBuffer())).toEqual(png);
    const listed = (await (await client(other.id)).Employee.list()).find((e) => e.id === me.id);
    expect(listed?.avatarAt).toBeInstanceOf(Date);

    expect((await fetch(url, { method: 'DELETE', headers: { cookie } })).status).toBe(204);
    expect((await fetch(`${url}/${me.id}`, { headers: { cookie } })).status).toBe(404);
    expect((await (await client(me.id)).Employee.list()).find((e) => e.id === me.id)?.avatarAt).toBeNull();
  });
});
