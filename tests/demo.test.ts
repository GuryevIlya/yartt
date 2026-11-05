import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, inject, test, vi } from 'vitest';
import { refreshDemo } from '../server/demo.ts';
import { migrate } from '../server/migrate.ts';
import { connect } from '../server/pg.ts';
import env from '../server/env.ts';
import { sql } from '../server/pg.ts';
import { client, clientBySession, createEmployee } from './helpers.ts';

vi.mock('../server/delivery.ts', () => ({ deliver: async () => {} }));

// DEMO_DATA is read when a request comes: the tests switch it on the parsed env.
afterEach(() => { env.DEMO_DATA = undefined; });

describe('the demo without sign-in', () => {
  test('a real installation has no demo: nobody is offered, picking is refused', async () => {
    const { id } = await createEmployee();
    expect(await (await client()).Auth.demo()).toBeNull();
    await expect((await client()).Auth.demoSignIn({ employeeId: id })).rejects.toMatchObject({ message: 'forbidden' });
  });

  test('anyone picks a person who can sign in and is signed in as them', async () => {
    env.DEMO_DATA = 'ru';
    const { id } = await createEmployee();
    const gone = await createEmployee({ managerId: id });
    await (await client(id)).Employee.dismiss({ id: gone.id });

    const people = await (await client()).Auth.demo();
    expect(people?.map((e) => e.id)).toContain(id);
    expect(people?.map((e) => e.id)).not.toContain(gone.id);

    const anonymous = await client();
    await anonymous.Auth.demoSignIn({ employeeId: id });
    expect((await (await clientBySession(anonymous.cookie.value!)).Auth.me())?.id).toBe(id);
    await expect(anonymous.Auth.demoSignIn({ employeeId: gone.id })).rejects.toMatchObject({ message: 'not_found' });
  });

  test('switching ends the session of the previous person', async () => {
    env.DEMO_DATA = 'ru';
    const first = await createEmployee();
    const second = await createEmployee();
    const browser = await client();
    await browser.Auth.demoSignIn({ employeeId: first.id });
    const before = browser.cookie.value!;

    await (await clientBySession(before)).Auth.demoSignIn({ employeeId: second.id });
    expect((await (await clientBySession(before)).Auth.me())).toBeNull();
  });

  test('DEMO_DATA refuses a database with real data and leaves it untouched, at start and at night', async () => {
    await createEmployee();
    const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM employee`;
    await expect(refreshDemo('ru')).rejects.toThrow(/real data/);
    await refreshDemo('ru', 'night');
    const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM employee`;
    expect(after!.n).toBe(before!.n);
  });
});

/** Runs what the start (or the nightly refresh) does with DEMO_DATA=lang against `url`, in a process of its own. */
function withDemo(url: string, lang: string, when: 'start' | 'night' = 'start') {
  const script = `const { refreshDemo } = await import(${JSON.stringify(join(import.meta.dirname, '..', 'server', 'demo.ts'))});
    await refreshDemo(${JSON.stringify(lang)}, ${JSON.stringify(when)}); process.exit(0);`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DATABASE_URL: url, PUBLIC_URL: 'http://yartt.test', SMTP_URL: '' },
    encoding: 'utf8',
  });
}

// The whole demo through the seed, in each language, into a database of its own.
describe.each(['ru', 'en'] as const)('the demo in %s', (lang) => {
  test('seeds: its own company in its language, everyone with an avatar but the invited; restarts and nights seed it afresh', { timeout: 120_000 }, async () => {
    const name = `yartt_demo_${lang}_${process.pid}`;
    const admin = postgres(inject('adminUrl'), { onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(inject('adminUrl'));
    url.pathname = `/${name}`;
    const db = postgres(url.toString(), { onnotice: () => {} });
    try {
      const seed = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'seed.ts'), '--lang', lang], {
        env: { ...process.env, DATABASE_URL: url.toString(), PUBLIC_URL: 'http://yartt.test', SMTP_URL: '' },
        encoding: 'utf8',
      });
      expect(seed.stderr).toBe('');
      expect(seed.status).toBe(0);

      const [version] = await db`SELECT version FROM schema_version WHERE expired_at IS NULL`;
      expect(version?.version).toBe('demo');
      // An installation's start (no DEMO_DATA) never migrates the demo.
      const app = connect(url.toString());
      await expect(migrate(app)).rejects.toThrow(/holds the demo/);
      await app.end();
      const people = await db`
        SELECT e.full_name, e.locale, a.employee_id IS NOT NULL AS avatar
          FROM employee e LEFT JOIN avatar a ON a.employee_id = e.id ORDER BY e.id
      `;
      expect(people[0]!.full_name).toBe(lang === 'ru' ? 'Алексей Громов' : 'Michael Reed');
      expect(new Set(people.map((p) => p.locale))).toEqual(new Set([lang]));
      expect(people.filter((p) => !p.avatar)).toHaveLength(1); // Anna, invited, never signed in
      const [tasks] = await db`SELECT count(*)::int AS n FROM task`;
      expect(tasks!.n).toBeGreaterThan(30);

      const seeded = async () => (await db`SELECT min(created_at) AS at FROM employee`)[0]!.at as Date;
      /** Makes the demo seeded `daysAgo` days back. */
      const markedAgo = (daysAgo: number) => db`
        UPDATE schema_version SET entered_at = NOW() - ${daysAgo} * INTERVAL '1 day' WHERE expired_at IS NULL AND version = 'demo'
      `;

      // A restart minutes after the seed (another instance did it): the demo stays.
      const first = await seeded();
      expect(withDemo(url.toString(), lang).status).toBe(0);
      expect(await seeded()).toEqual(first);

      // A restart later: the marked demo is wiped and seeded again, nothing added twice.
      await markedAgo(1);
      expect(withDemo(url.toString(), lang).status).toBe(0);
      const second = await seeded();
      expect(second > first).toBe(true);
      const [count] = await db`SELECT count(*)::int AS n FROM employee`;
      expect(count!.n).toBe(people.length);

      // The night: not again the same day; a demo of an earlier day is seeded afresh after 03:00 there.
      expect(withDemo(url.toString(), lang, 'night').status).toBe(0);
      expect(await seeded()).toEqual(second);
      await markedAgo(2);
      expect(withDemo(url.toString(), lang, 'night').status).toBe(0);
      const zone = lang === 'ru' ? 'Europe/Moscow' : 'America/New_York';
      const pastThree = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date())) >= 3;
      expect((await seeded()) > second).toBe(pastThree);

      // At a version of its own the same data counts as real: refused, and nothing is deleted.
      await db`UPDATE schema_version SET version = '0.1' WHERE expired_at IS NULL`;
      const refused = withDemo(url.toString(), lang);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/real data/);
      const [kept] = await db`SELECT count(*)::int AS n FROM employee`;
      expect(kept!.n).toBe(people.length);
      expect(withDemo(url.toString(), lang, 'night').status).toBe(0);
      const [still] = await db`SELECT count(*)::int AS n FROM employee`;
      expect(still!.n).toBe(people.length);
    } finally {
      await db.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
