import { beforeEach, describe, expect, test, vi } from 'vitest';
import { sql } from '../server/pg.ts';
import type { Message } from '../server/delivery.ts';
import { client, clientBySession, createEmployee, type TestClient } from './helpers.ts';

const sent: Message[] = [];
vi.mock('../server/delivery.ts', () => ({
  deliver: async (message: Message) => { sent.push(message); },
}));

beforeEach(() => { sent.length = 0; });

/** The token of a sign-in link asked for in this browser. */
async function loginLink(email: string, browser: TestClient): Promise<string> {
  await browser.Auth.requestLogin({ email });
  const message = sent.findLast((m) => m.payload.kind === 'login' && m.to.email?.toLowerCase() === email.toLowerCase());
  const url = message?.payload.kind === 'login' ? message.payload.url : '';
  return url.slice(url.lastIndexOf('/') + 1);
}

describe('auth', () => {
  test('magic link -> session -> me', async () => {
    const { id, email } = await createEmployee();
    const anonymous = await client();
    const token = await loginLink(email.toUpperCase(), anonymous);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    await anonymous.Auth.login({ token });
    expect(anonymous.cookie.value).toMatch(/^[0-9a-f]{64}$/);

    const authed = await clientBySession(anonymous.cookie.value!);
    expect((await authed.Auth.me())?.id).toBe(id);
  });

  test('token is single-use and stored hashed', async () => {
    const { email } = await createEmployee();
    const browser = await client();
    const token = await loginLink(email, browser);

    const [stored] = await sql`SELECT 1 FROM token WHERE hash = ${token}`;
    expect(stored).toBeUndefined();

    await browser.Auth.login({ token });
    await expect(browser.Auth.login({ token })).rejects.toMatchObject({ message: 'invalid_token' });
  });

  test('a link signs in only in the browser that asked for it, and elsewhere is not used up', async () => {
    const { id, email } = await createEmployee();
    const browser = await client();
    const token = await loginLink(email, browser);
    const key = browser.browser.value;
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    // A mail scanner, or whoever the email was forwarded to: no key, or another one.
    await expect((await client()).Auth.login({ token })).rejects.toMatchObject({ message: 'login_other_browser' });
    const other = await client();
    await other.Auth.requestLogin({ email: `nobody-${email}` });
    await expect(other.Auth.login({ token })).rejects.toMatchObject({ message: 'login_other_browser' });

    // A second link keeps the browser's key; both work there.
    const second = await loginLink(email, browser);
    expect(browser.browser.value).toBe(key);
    await browser.Auth.login({ token });
    expect((await (await clientBySession(browser.cookie.value!)).Auth.me())?.id).toBe(id);
    await browser.Auth.login({ token: second });
  });

  test('expired token is rejected', async () => {
    const { email } = await createEmployee();
    const browser = await client();
    const token = await loginLink(email, browser);
    await sql`UPDATE token SET sent_at = NOW() - INTERVAL '11 minutes' WHERE hash = digest(${token}, 'sha256')`;
    await expect(browser.Auth.login({ token })).rejects.toMatchObject({ message: 'invalid_token' });
  });

  test('unknown email: same answer, nothing sent', async () => {
    await (await client()).Auth.requestLogin({ email: 'nobody@yartt.test' });
    expect(sent).toHaveLength(0);
  });

  test('dismissed employee cannot log in', async () => {
    const boss = await createEmployee();
    const { id, email } = await createEmployee({ managerId: boss.id });
    await sql`SELECT dismiss_employee(${id}, ${boss.id})`;
    await (await client()).Auth.requestLogin({ email });
    expect(sent).toHaveLength(0);
  });

  test('logout and logout everywhere', async () => {
    const { email } = await createEmployee();
    const sessions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const anonymous = await client();
      await anonymous.Auth.login({ token: await loginLink(email, anonymous) });
      sessions.push(anonymous.cookie.value!);
    }

    const first = await clientBySession(sessions[0]!);
    await first.Auth.logout();
    expect(first.cookie.value).toBeNull();
    expect(await (await clientBySession(sessions[0]!)).Auth.me()).toBeNull();
    expect(await (await clientBySession(sessions[1]!)).Auth.me()).not.toBeNull();

    const second = await clientBySession(sessions[1]!);
    await second.Auth.logoutEverywhere();
    expect(await (await clientBySession(sessions[2]!)).Auth.me()).toBeNull();
  });

  test('protected procedures require a session', async () => {
    await expect((await client()).Employee.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('sign-in links are limited', () => {
  test('five links in 15 minutes; the sixth is refused like an unknown address', async () => {
    const me = await createEmployee();
    for (let i = 0; i < 5; i++) {
      const [row] = await sql<{ token: string | null }[]>`SELECT issue_token(${me.email}, 'browser') AS token`;
      expect(row!.token).not.toBeNull();
    }
    const [sixth] = await sql<{ token: string | null }[]>`SELECT issue_token(${me.email}, 'browser') AS token`;
    expect(sixth!.token).toBeNull();
  });

  test('a new email is confirmed by a link sent there, by email only; until then the old one stays', async () => {
    const me = await createEmployee();
    const other = await createEmployee();
    const api = await client(me.id);
    const next = `next-${me.email}`;
    await expect(api.Employee.requestEmailChange({ email: other.email.toUpperCase() })).rejects.toMatchObject({ message: 'email_taken' });

    await api.Employee.requestEmailChange({ email: next });
    expect(sent.map((m) => [m.payload.kind, m.to.email])).toEqual([['email_confirm', next], ['email_changing', me.email]]);
    const link = sent[0]!.payload.kind === 'email_confirm' ? sent[0]!.payload.url : '';
    const token = link.slice(link.lastIndexOf('/') + 1);
    expect((await api.Auth.me())?.email).toBe(me.email);

    // It never signs in, and a sign-in link never confirms.
    await expect((await client()).Auth.login({ token })).rejects.toMatchObject({ message: 'invalid_token' });
    await expect((await client()).Auth.confirmEmail({ token: await loginLink(me.email, await client()) })).rejects.toMatchObject({ message: 'invalid_token' });

    await (await client()).Auth.confirmEmail({ token });
    expect((await api.Auth.me())?.email).toBe(next);
    await expect((await client()).Auth.confirmEmail({ token })).rejects.toMatchObject({ message: 'invalid_token' });
  });

  test('an email link works for a day; following one drops the others', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const tokenFor = async (email: string) => {
      await api.Employee.requestEmailChange({ email });
      const message = sent.findLast((m) => m.payload.kind === 'email_confirm' && m.to.email === email)!;
      const url = message.payload.kind === 'email_confirm' ? message.payload.url : '';
      return url.slice(url.lastIndexOf('/') + 1);
    };
    const old = await tokenFor(`a-${me.email}`);
    await sql`UPDATE token SET sent_at = NOW() - INTERVAL '25 hours' WHERE hash = digest(${old}, 'sha256')`;
    await expect((await client()).Auth.confirmEmail({ token: old })).rejects.toMatchObject({ message: 'invalid_token' });

    const first = await tokenFor(`b-${me.email}`);
    const second = await tokenFor(`c-${me.email}`);
    await (await client()).Auth.confirmEmail({ token: second });
    await expect((await client()).Auth.confirmEmail({ token: first })).rejects.toMatchObject({ message: 'invalid_token' });
    expect((await api.Auth.me())?.email).toBe(`c-${me.email}`);
  });
});
