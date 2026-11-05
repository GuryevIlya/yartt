// The test data of the current schema version: tests/fixtures/data.sql.
// It lives in git next to db.sql, so every release tag carries its own, and
// tests/schema.test.ts checks that migrations turn the data of a release into
// the data of today.
//
//   npm run fixture             — from scratch: the demo data (scripts/seed.ts)
//                                 in a temporary database, dumped. For the first
//                                 version, before anything is released.
//   npm run fixture -- --migrate — from the last release: its db.sql and data,
//                                 today's migrations (each step as of the release
//                                 it starts from: pinClock), then the asymmetry scripts
//                                 tests/fixtures/<from>-<to>.sql (data that only
//                                 appeared in the new version). Review the diff.
//
// Needs TEST_DATABASE_URL (an admin connection, as for npm test).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { connect } from '../server/pg.ts';
import { MIGRATIONS_DIR, migrate, parseMigrations, planMigrations, versionOfDbSql } from '../server/migrate.ts';
import { dumpData, loadData, pinClock, releaseMoments } from './data.ts';

const root = join(import.meta.dirname, '..');
const FIXTURE = join(root, 'tests', 'fixtures', 'data.sql');
const ASYMMETRY_DIR = join(root, 'tests', 'fixtures');

const admin = process.env.TEST_DATABASE_URL;
if (!admin) throw new Error('Set TEST_DATABASE_URL (an admin connection, as for npm test)');
const name = 'yartt_fixture';
const url = new URL(admin);
url.pathname = `/${name}`;

const server = postgres(admin, { onnotice: () => {} });
await server.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await server.unsafe(`CREATE DATABASE ${name}`);

try {
  if (process.argv.includes('--migrate')) {
    const tags = execFileSync('git', ['tag', '--list', '[0-9]*.[0-9]*.[0-9]*', '--sort=-v:refname'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    const tag = tags[0];
    if (!tag) throw new Error('No release tag: use `npm run fixture` without --migrate');
    // Each step as of the release it starts from, as tests/schema.test.ts runs it.
    const pin = connect(url.toString());
    await pinClock(pin, releaseMoments());
    await pin.end();
    const db = connect(url.toString());
    try {
      const oldSchema = execFileSync('git', ['show', `${tag}:db.sql`], { cwd: root, encoding: 'utf8' });
      await db.unsafe(oldSchema);
      await loadData(db, execFileSync('git', ['show', `${tag}:tests/fixtures/data.sql`], { cwd: root, encoding: 'utf8' }));
      await migrate(db);
      // What only appeared in the newer versions, step by step.
      const target = versionOfDbSql(await readFile(join(root, 'db.sql'), 'utf8'));
      const steps = planMigrations(parseMigrations(await readdir(MIGRATIONS_DIR)), versionOfDbSql(oldSchema), target);
      for (const step of steps) {
        const asymmetry = join(ASYMMETRY_DIR, step.file);
        if (existsSync(asymmetry)) await loadData(db, await readFile(asymmetry, 'utf8'));
      }
      await writeFile(FIXTURE, await dumpData(db));
      console.log(`tests/fixtures/data.sql: ${tag} migrated to ${target.major}.${target.minor}`);
    } finally {
      await db.end();
    }
  } else {
    const env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      PUBLIC_URL: 'http://localhost:3000',
      SMTP_URL: '',
    };
    const seed = spawnSync(process.execPath, [join(root, 'scripts', 'seed.ts')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    if (seed.status !== 0) throw new Error('The seed failed');
    const db = connect(url.toString());
    try {
      await writeFile(FIXTURE, await dumpData(db));
      console.log('tests/fixtures/data.sql: the demo data');
    } finally {
      await db.end();
    }
  }
} finally {
  await server.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await server.end();
}
