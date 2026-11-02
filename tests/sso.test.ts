import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import api from '../server/api.ts';
import type { Message } from '../server/delivery.ts';
import env from '../server/env.ts';
import { sql } from '../server/pg.ts';
import { checkPeople } from '../server/sso.ts';
import { client, clientBySession, createEmployee } from './helpers.ts';
import { startProvider, type Person } from './oidc.ts';

const sent = vi.hoisted(() => [] as Message[]);
vi.mock('../server/delivery.ts', () => ({ deliver: async (message: Message) => { sent.push(message); } }));

const CLIENT_ID = 'yartt-test';

describe('sign-in through the identity provider', () => {
  let provider: Awaited<ReturnType<typeof startProvider>>;
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let base: string;
  beforeAll(async () => {
    provider = await startProvider(CLIENT_ID);
    server = express().use('/api', api).use('/demo/api', api).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    Object.assign(env, { OIDC_ISSUER: provider.issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: 'secret', EMAIL_DOMAINS: [] });
  });
  afterAll(() => {
    Object.assign(env, { OIDC_ISSUER: undefined, OIDC_CLIENT_ID: undefined, OIDC_CLIENT_SECRET: undefined });
    server.close();
    provider.close();
  });

  /** The redirects a browser would follow: here, the provider, back here. Where it ends, and the cookies it got. */
  async function signIn(person: Person, next = '/') {
    provider.signInAs(person);
    const start = await fetch(`${base}/api/sso/start?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
    const flow = /yartt_sso=([^;]+)/.exec(start.headers.get('set-cookie') ?? '')?.[1];
    const authorized = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    // The provider sends the browser to PUBLIC_URL; here it is this test server.
    const back = new URL(authorized.headers.get('location')!);
    const done = await fetch(`${base}${back.pathname}${back.search}`, { redirect: 'manual', headers: { cookie: `yartt_sso=${flow}` } });
    const cookies = done.headers.get('set-cookie') ?? '';
    const session = /yartt_session=([^;]+)/.exec(cookies)?.[1] ?? null;
    const pending = /yartt_sso_pending=([^;]+)/.exec(cookies)?.[1] ?? null;
    return { location: done.headers.get('location'), session, pending };
  }

  /** A tRPC call over HTTP with the browser's cookies: its result, or the error code and the cookies it set. */
  async function call(path: string, input: unknown, cookie: string, method: 'GET' | 'POST' = 'POST') {
    const response = method === 'GET'
      ? await fetch(`${base}/api/trpc/${path}`, { headers: { cookie } })
      : await fetch(`${base}/api/trpc/${path}`, {
        method, headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ json: input }),
      });
    const body = await response.json() as { result?: { data: { json: unknown } }; error?: { json: { message: string } } };
    return { data: body.result?.data.json, error: body.error?.json.message ?? null, cookies: response.headers.get('set-cookie') ?? '' };
  }

  /** The person types their email and follows the link it got, in the browser of `pending` (or another). */
  async function confirm(pending: string, email: string, browser = pending) {
    const asked = await call('Auth.ssoSendEmail', { email }, `yartt_sso_pending=${pending}`);
    if (asked.error) return { error: asked.error, session: null };
    const link = sent.at(-1)!;
    expect(link).toMatchObject({ to: { email, employeeId: null }, payload: { kind: 'sso_email', email } });
    const token = (link.payload as { url: string }).url.split('/sso/')[1]!;
    const done = await call('Auth.ssoConfirm', { token }, `yartt_sso_pending=${browser}`);
    return { error: done.error, session: /yartt_session=([^;]+)/.exec(done.cookies)?.[1] ?? null };
  }

  /** Signing in through the provider as a person would: the email confirmed the first time, if it must be. */
  async function signInFully(person: Person, email = person.email!) {
    const first = await signIn(person);
    if (first.session) return first.session;
    return (await confirm(first.pending!, email)).session!;
  }

  const person = (fields: Partial<Person> = {}): Person =>
    ({ sub: randomUUID(), email: `${randomUUID()}@yartt.test`, email_verified: true, name: 'Ann Lee', locale: 'en-GB', ...fields });
  const pendingOf = async (pending: string) => (await call('Auth.ssoPending', undefined, `yartt_sso_pending=${pending}`, 'GET')).data;

  test('under a path of PUBLIC_URL: the provider comes back to it, and so does the person', async () => {
    const { PUBLIC_URL, BASE_PATH } = env;
    Object.assign(env, { PUBLIC_URL: `${base}/demo`, BASE_PATH: '/demo' });
    try {
      const { location, session } = await signIn(person(), '/tasks/12');
      expect(location).toBe('/demo/tasks/12');
      expect(session).not.toBeNull();
    } finally {
      Object.assign(env, { PUBLIC_URL, BASE_PATH });
    }
  });

  test('an address the provider vouches for: someone new comes in at once, known by the provider id; a session for a day', async () => {
    const ann = person({ zoneinfo: 'Asia/Almaty' });
    const { location, session } = await signIn(ann, '/tasks/12');
    expect(location).toBe('/tasks/12');
    const me = await (await clientBySession(session!)).Auth.me();
    expect(me).toMatchObject({ kind: 'human', email: ann.email, fullName: 'Ann Lee', locale: 'en', timeZone: 'Asia/Almaty', managerId: null });

    // Known by the provider id from now on; the email does not follow the provider's, it is theirs to change.
    const again = await signIn({ ...ann, email: `new-${ann.email}` });
    expect(await (await clientBySession(again.session!)).Auth.me()).toMatchObject({ id: me!.id, email: ann.email });
    await expect((await client(me!.id)).Employee.requestEmailChange({ email: `y-${ann.email}` })).resolves.toBeUndefined();

    // A day from sign-in, active or not — as the browser sees it.
    const meOverHttp = async () => (await (await fetch(`${base}/api/trpc/Auth.me`, { headers: { cookie: `yartt_session=${session}` } }))
      .json() as { result: { data: { json: { id: number } | null } } }).result.data.json;
    expect(await meOverHttp()).toMatchObject({ id: me!.id });
    await sql`UPDATE session SET created_at = NOW() - INTERVAL '25 hours' WHERE hash = digest(${session!}, 'sha256')`;
    expect(await meOverHttp()).toBeNull();
  });

  test('someone created before by their address is found by it: vouched for by the provider, or confirmed by them', async () => {
    const invited = await createEmployee();
    const { session } = await signIn(person({ email: invited.email }));
    expect((await (await clientBySession(session!)).Auth.me())?.id).toBe(invited.id);

    // Not vouched for (Entra sends no email_verified): they confirm the address they type.
    const other = await createEmployee();
    const unvouched = await signIn(person({ email: other.email, email_verified: undefined }));
    expect(unvouched).toMatchObject({ location: '/sso', session: null });
    expect(await pendingOf(unvouched.pending!)).toEqual({ email: other.email, fullName: 'Ann Lee', sentTo: null });
    expect((await (await clientBySession((await confirm(unvouched.pending!, other.email)).session!)).Auth.me())?.id).toBe(other.id);

    // No address at all: the same.
    const third = await createEmployee();
    const silent = await signIn(person({ email: undefined }));
    expect(await pendingOf(silent.pending!)).toMatchObject({ email: null });
    expect((await (await clientBySession((await confirm(silent.pending!, third.email)).session!)).Auth.me())?.id).toBe(third.id);

    // Someone new with no vouched address is created with the one they confirm.
    const fresh = await signIn(person({ email: undefined }));
    const typed = `${randomUUID()}@yartt.test`;
    expect(await (await clientBySession((await confirm(fresh.pending!, typed)).session!)).Auth.me()).toMatchObject({ email: typed });

    // An address bound to another provider account is its owner's to confirm, not taken over.
    const bound = person();
    const boundSession = await signInFully(bound);
    const owner = (await (await clientBySession(boundSession)).Auth.me())!;
    expect((await signIn(person({ email: bound.email }))).location).toBe('/sso');
    expect(await sql`SELECT external_id FROM human WHERE employee_id = ${owner.id}`).toEqual([{ externalId: bound.sub }]);
  });

  test('refused: a link opened elsewhere, an old sign-in, the dismissed, an address outside the domains, a broken flow', async () => {
    // A forwarded link signs nobody in: it belongs to the browser that signed in.
    const ann = person({ email: undefined });
    const mine = await signIn(ann);
    const elsewhere = await signIn(person({ email: undefined }));
    const address = `${randomUUID()}@yartt.test`;
    expect(await confirm(mine.pending!, address, elsewhere.pending!)).toMatchObject({ error: 'sso_other_browser', session: null });
    await sql`UPDATE external_sign_in SET created_at = NOW() - INTERVAL '61 minutes' WHERE hash = digest(${mine.pending!}, 'sha256')`;
    expect(await confirm(mine.pending!, address)).toMatchObject({ error: 'sso_failed' });
    expect((await call('Auth.ssoSendEmail', { email: address }, '')).error).toBe('sso_failed');

    const boss = await createEmployee();
    const gone = await createEmployee({ managerId: boss.id });
    await (await client(boss.id)).Employee.dismiss({ id: gone.id });
    expect((await signIn(person({ email: gone.email }))).location).toBe('/login?error=dismissed');
    expect(await confirm((await signIn(person({ email: undefined }))).pending!, gone.email)).toMatchObject({ error: 'dismissed' });

    env.EMAIL_DOMAINS = ['corp.test'];
    // An address outside the domains is neither trusted nor offered.
    const outside = await signIn(person());
    expect(outside.location).toBe('/sso');
    expect(await pendingOf(outside.pending!)).toMatchObject({ email: null });
    expect(await confirm(outside.pending!, 'ann@elsewhere.test')).toMatchObject({ error: 'email_not_allowed' });
    env.EMAIL_DOMAINS = [];

    // As many links as sign-in links.
    const busy = await signIn(person({ email: undefined }));
    for (let i = 0; i < 5; i++) expect((await call('Auth.ssoSendEmail', { email: `${i}-${address}` }, `yartt_sso_pending=${busy.pending}`)).error).toBeNull();
    expect((await call('Auth.ssoSendEmail', { email: address }, `yartt_sso_pending=${busy.pending}`)).error).toBe('too_many_requests');

    expect((await fetch(`${base}/api/sso/callback?code=x&state=y`, { redirect: 'manual' })).headers.get('location'))
      .toBe('/login?error=sso_failed');
    expect((await signIn(person(), '//evil.example.com/')).location).toBe('/');
  });

  test('no sign-in links or invites: the provider is the only way', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    await expect((await client()).Auth.requestLogin({ email: me.email })).rejects.toMatchObject({ message: 'sso_only' });
    await expect(api.Employee.invite({ email: `x-${me.email}`, fullName: 'X' })).rejects.toMatchObject({ message: 'sso_only' });
    expect(await (await client()).Auth.config()).toEqual({ sso: { name: 'SSO' } });
  });

  test('every day the provider is asked: someone it refuses is out — sessions, links, their bots', async () => {
    const ann = person();
    const session = await signInFully(ann);
    const me = (await (await clientBySession(session)).Auth.me())!;
    const { key } = await (await client(me.id)).Bot.create({ fullName: 'CI', pronoun: null, about: null, permissions: [], webhookUrl: null });
    const bot = async () => (await sql<{ id: number | null }[]>`SELECT authenticate_bot(${key}) AS id`)[0]!.id;

    // Checked a day ago: still let in.
    await sql`UPDATE human SET idp_checked_at = NOW() - INTERVAL '25 hours' WHERE employee_id = ${me.id}`;
    expect(await sql.begin((tx) => checkPeople(tx as unknown as typeof sql))).toBe(0);
    expect(await bot()).not.toBeNull();

    provider.block(ann.sub);
    await sql`UPDATE human SET idp_checked_at = NOW() - INTERVAL '25 hours' WHERE employee_id = ${me.id}`;
    expect(await sql.begin((tx) => checkPeople(tx as unknown as typeof sql))).toBe(1);
    expect(await (await clientBySession(session)).Auth.me()).toBeNull();
    expect(await bot()).toBeNull();
    expect((await (await client(me.id)).Auth.me())?.idpBlockedAt).toBeInstanceOf(Date);
    // Back to sign-in links in an outage, they are still refused.
    expect((await sql<{ token: string | null }[]>`SELECT issue_token(${ann.email!}, 'browser') AS token`)[0]!.token).toBeNull();

    // Let in again: signing in clears it.
    await signIn(ann);
    expect(await bot()).not.toBeNull();
  });
});
