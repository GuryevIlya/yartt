// Starts the application for end-to-end tests (playwright.config.ts,
// webServer): the real server with the built client on a fresh database,
// like in production.
//
//   node e2e/serve.ts        — the demo data as a real installation: seeded
//                              (scripts/seed.ts), then unmarked as the demo,
//                              so people sign in by link (most suites)
//   node e2e/serve.ts --demo — the demo itself (DEMO_DATA=en): no sign-in, a
//                              person is picked (demo.spec.ts)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import postgres from 'postgres';
import { ADMIN_URL, databaseUrl, E2E_DATABASE, E2E_DEMO_DATABASE, E2E_DEMO_PORT, E2E_DEMO_URL, E2E_PORT, E2E_URL } from './db.ts';

const demo = process.argv.includes('--demo');
// Both servers start at once, but only the main one builds the client first:
// the demo serves the build, so it waits until the main server is up.
if (demo) {
  for (let up = false; !up; await new Promise((r) => setTimeout(r, 1_000))) {
    up = await fetch(`${E2E_URL}/api/trpc/Auth.me`).then((r) => r.ok, () => false);
  }
}
const database = demo ? E2E_DEMO_DATABASE : E2E_DATABASE;
const root = join(import.meta.dirname, '..');
const admin = postgres(ADMIN_URL, { onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${database}`);

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl(database),
  PUBLIC_URL: demo ? E2E_DEMO_URL : E2E_URL,
  PORT: String(demo ? E2E_DEMO_PORT : E2E_PORT),
  ROLE: 'all',
  COOKIE_SECURE: 'false',
  SMTP_URL: '',
  DEMO_DATA: demo ? 'en' : '',
};
if (!demo) {
  const seed = spawnSync(process.execPath, [join(root, 'scripts', 'seed.ts')], { env, stdio: 'inherit' });
  if (seed.status !== 0) process.exit(seed.status ?? 1);
  // Not the demo any more: the same people and tasks, at the schema version of db.sql, with sign-in.
  const db = postgres(databaseUrl(database), { onnotice: () => {} });
  await db`DELETE FROM schema_version WHERE version = 'demo'`;
  await db`UPDATE schema_version SET expired_at = NULL`;
  await db.end();
}
await admin.end();

Object.assign(process.env, env);
await import('../server/index.ts');
