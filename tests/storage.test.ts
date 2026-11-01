import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buffer } from 'node:stream/consumers';
import type { Readable } from 'node:stream';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import api from '../server/api.ts';
import env from '../server/env.ts';
import { sql } from '../server/pg.ts';
import * as Attachments from '../server/services/Attachment.ts';
import { client, createEmployee } from './helpers.ts';
import { fakeS3 } from './s3.ts';

const bytesOf = async (value: Buffer | Readable) => (Buffer.isBuffer(value) ? value : buffer(value));
const fileRow = async (id: number) => (await sql<{ inStorage: boolean; hasValue: boolean; purged: boolean }[]>`
  SELECT in_storage, value IS NOT NULL AS has_value, purged_at IS NOT NULL AS purged FROM attachment WHERE id = ${id}
`)[0];

describe('files in an object storage (decision 104)', () => {
  let s3: Awaited<ReturnType<typeof fakeS3>>;
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let url: string;

  beforeAll(async () => {
    s3 = await fakeS3('test-key');
    server = express().use('/api', api).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}/api/attachments`;
  });
  afterAll(async () => {
    server.close();
    await s3.close();
  });

  const enable = () => Object.assign(env, {
    S3_BUCKET: 'yartt', S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'secret',
  });
  const disable = () => { env.S3_BUCKET = undefined; };
  beforeEach(() => {
    s3.state.failing = false;
    enable();
    return disable;
  });
  // Other files leave files in PostgreSQL behind: moved here, they must not count.
  const moveAll = async () => { while (await sql.begin((tx) => Attachments.moveToStorage(tx as unknown as typeof sql)) > 0); };

  test('a file goes to the storage, is read from it as a stream and over HTTP', async () => {
    const me = await createEmployee();
    const bytes = Buffer.from(`report-${randomUUID()}`);
    const id = await Attachments.upload(me.id, bytes, 'text/csv');
    expect(await fileRow(id)).toEqual({ inStorage: true, hasValue: false, purged: false });
    expect(s3.objects.get(`/yartt/attachments/${id}`)).toEqual({ body: bytes, type: 'text/csv' });

    const file = await Attachments.read(me.id, id);
    expect(Buffer.isBuffer(file.value)).toBe(false);
    expect(await bytesOf(file.value)).toEqual(bytes);

    const [session] = await sql<{ s: string }[]>`SELECT start_session(${me.id}) AS s`;
    const response = await fetch(`${url}/${id}?name=report.csv`, { headers: { cookie: `yartt_session=${session!.s}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''report.csv");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    // The same bytes again: the same file, nothing stored twice.
    const other = await createEmployee();
    const puts = s3.state.requests;
    expect(await Attachments.upload(other.id, bytes, 'text/csv')).toBe(id);
    expect(s3.state.requests).toBe(puts);
  });

  test('the storage refusing a file refuses the upload: no row without its content', async () => {
    const me = await createEmployee();
    s3.state.failing = true;
    const bytes = Buffer.from(`lost-${randomUUID()}`);
    await expect(Attachments.upload(me.id, bytes, 'text/plain')).rejects.toThrow(/S3 PUT/);
    expect(await sql`SELECT 1 FROM attachment WHERE size = ${bytes.length} AND uploaded_by @> ARRAY[${me.id}::int]`).toHaveLength(0);
  });

  test('a purged file loses its object; the same bytes bring it back to the storage', async () => {
    const me = await createEmployee();
    const bytes = Buffer.from(`purged-${randomUUID()}`);
    const id = await Attachments.upload(me.id, bytes, 'text/plain');
    await (await client(me.id)).Attachment.release({ id });
    expect(await fileRow(id)).toEqual({ inStorage: true, hasValue: false, purged: true });

    await moveAll();
    expect(await fileRow(id)).toEqual({ inStorage: false, hasValue: false, purged: true });
    expect(s3.objects.has(`/yartt/attachments/${id}`)).toBe(false);
    await expect(Attachments.read(me.id, id)).rejects.toMatchObject({ code: 'file_purged' });

    expect(await Attachments.upload(me.id, bytes, 'text/plain')).toBe(id);
    expect(await fileRow(id)).toEqual({ inStorage: true, hasValue: false, purged: false });
    expect(await bytesOf((await Attachments.read(me.id, id)).value)).toEqual(bytes);
  });

  test('set up later, the storage takes the files from PostgreSQL', async () => {
    const me = await createEmployee();
    disable();
    const bytes = Buffer.from(`old-${randomUUID()}`);
    const id = await Attachments.upload(me.id, bytes, 'text/plain');
    expect(await fileRow(id)).toEqual({ inStorage: false, hasValue: true, purged: false });
    expect((await Attachments.read(me.id, id)).value).toEqual(bytes);

    enable();
    await moveAll();
    expect(await fileRow(id)).toEqual({ inStorage: true, hasValue: false, purged: false });
    expect(s3.objects.get(`/yartt/attachments/${id}`)?.body).toEqual(bytes);
    expect(await bytesOf((await Attachments.read(me.id, id)).value)).toEqual(bytes);
  });

  test('a file never attached is cleaned up with its object; a storage down keeps both', async () => {
    const me = await createEmployee();
    const id = await Attachments.upload(me.id, Buffer.from(`unused-${randomUUID()}`), 'text/plain');
    await sql`UPDATE attachment SET used_at = NOW() - INTERVAL '2 days' WHERE id = ${id}`;

    s3.state.failing = true;
    await expect(sql.begin((tx) => Attachments.cleanup(tx as unknown as typeof sql))).rejects.toThrow(/S3 DELETE/);
    expect(await fileRow(id)).toBeDefined();

    s3.state.failing = false;
    await sql.begin((tx) => Attachments.cleanup(tx as unknown as typeof sql));
    expect(await fileRow(id)).toBeUndefined();
    expect(s3.objects.has(`/yartt/attachments/${id}`)).toBe(false);
  });
});
