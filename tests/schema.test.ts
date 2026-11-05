import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, inject, test } from 'vitest';
import { connect, sql } from '../server/pg.ts';
import {
  DB_SQL_PATH, MIGRATIONS_DIR, checkExtensionRights, checkMigrationSql, migrate, parseMigrations, parseVersion, planMigrations, versionOfDbSql,
} from '../server/migrate.ts';
import { dataOf, dumpData, loadData, pinClock, releaseMoments } from '../scripts/data.ts';

// Schema fingerprint: everything db.sql defines except data.
const FINGERPRINT = `
  SELECT 'column' AS kind, table_name || '.' || column_name AS name,
         concat_ws(' ', data_type, udt_name, is_nullable, column_default) AS def
    FROM information_schema.columns
   WHERE table_schema = 'public'
  UNION ALL
  SELECT 'constraint', conrelid::regclass || '.' || conname, pg_get_constraintdef(oid)
    FROM pg_constraint
   WHERE connamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'index', indexname, indexdef
    FROM pg_indexes
   WHERE schemaname = 'public'
  UNION ALL
  SELECT 'function', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'trigger', tgrelid::regclass || '.' || tgname, pg_get_triggerdef(oid)
    FROM pg_trigger
   WHERE NOT tgisinternal
  UNION ALL
  SELECT 'type', t.typname, array_to_string(array_agg(e.enumlabel ORDER BY e.enumsortorder), ',')
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   GROUP BY t.typname
  UNION ALL
  SELECT 'comment', classoid::regclass || ':' || objoid || ':' || objsubid, description
    FROM pg_description
   WHERE classoid = 'pg_namespace'::regclass
  UNION ALL
  SELECT 'version', 'schema_version', version FROM schema_version WHERE expired_at IS NULL
  ORDER BY 1, 2
`;

describe('migration chain rules', () => {
  const v = parseVersion;

  test('minor and major steps', () => {
    const migrations = parseMigrations(['0.0-0.1.sql', '0.1-1.0.sql', '1.0-1.1.sql', '1.1-2.0.sql']);
    expect(planMigrations(migrations, v('0.0'), v('2.0')).map((m) => m.file))
      .toEqual(['0.0-0.1.sql', '0.1-1.0.sql', '1.0-1.1.sql', '1.1-2.0.sql']);
    expect(planMigrations(migrations, v('1.1'), v('2.0')).map((m) => m.file)).toEqual(['1.1-2.0.sql']);
  });

  test('invalid steps are rejected', () => {
    expect(() => parseMigrations(['1.0-1.2.sql'])).toThrow();
    expect(() => parseMigrations(['1.2-2.1.sql'])).toThrow();
    expect(() => parseMigrations(['1.2-3.0.sql'])).toThrow();
  });

  test('major step only from the last minor', () => {
    expect(() => parseMigrations(['1.1-1.2.sql', '1.1-2.0.sql'])).toThrow(/last minor/);
  });

  test('non-transactional commands are rejected', () => {
    expect(() => checkMigrationSql('1.0-1.1.sql', 'CREATE INDEX CONCURRENTLY i ON t(x);')).toThrow(/CONCURRENTLY/);
    expect(() => checkMigrationSql('1.0-1.1.sql', 'vacuum t;')).toThrow(/VACUUM/);
    expect(() => checkMigrationSql('1.0-1.1.sql', '-- no CONCURRENTLY here\nCREATE INDEX i ON t(x);')).not.toThrow();
    expect(() => checkMigrationSql('1.0-1.1.sql', "COMMENT ON TABLE t IS 'never vacuumed ''concurrently''';")).not.toThrow();
  });

  test('missing path is an error', () => {
    const migrations = parseMigrations(['1.0-1.1.sql']);
    expect(() => planMigrations(migrations, v('1.0'), v('1.2'))).toThrow(/No migration path/);
  });
});

// Every released version upgrades to exactly the schema of db.sql: the
// database is built from db.sql as it was at the release tag, migrated with
// the migrations of today, and compared with a fresh db.sql. The same
// version at a tag and now means the same schema — a change without a new
// version and a migration fails here. Nothing released, nothing to check.
const files = await readdir(MIGRATIONS_DIR);
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
const releases = (() => {
  try {
    return git('tag', '--list', '[0-9]*.[0-9]*.[0-9]*').split('\n').filter(Boolean);
  } catch {
    return []; // no git (an unpacked tree): nothing to compare with
  }
})();

test('released migrations are transactional', async () => {
  for (const m of parseMigrations(files)) {
    checkMigrationSql(m.file, await readFile(join(MIGRATIONS_DIR, m.file), 'utf8'));
  }
});

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** A fresh database for one check, dropped afterwards; `clock` — its now() pinned to the releases (pinClock). */
async function scratch(name: string, use: (db: ReturnType<typeof connect>) => Promise<void>, clock?: Record<string, string>) {
  const admin = postgres(inject('adminUrl'), { onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(inject('adminUrl'));
  url.pathname = `/${name}`;
  if (clock) {
    const pin = connect(url.toString());
    await pinClock(pin, clock);
    await pin.end();
  }
  const db = connect(url.toString());
  try {
    await use(db);
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

// A company's PostgreSQL may close the extensions' functions to PUBLIC: neither
// installing nor migrating notices, requests would fail one by one.
test('a database user without the right to call the extensions is told at startup', async () => {
  const role = `yartt_rights_${process.pid}`;
  await scratch(`yartt_rights_${process.pid}`, async (db) => {
    await db.unsafe(await readFile(DB_SQL_PATH, 'utf8'));
    await db.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await db.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'p'`);
    const url = new URL(inject('adminUrl'));
    url.pathname = `/${role}`; // the database has the same name
    url.username = role;
    url.password = 'p';
    const user = connect(url.toString());
    try {
      await checkExtensionRights(user);
      await db.unsafe('REVOKE EXECUTE ON FUNCTION digest(text, text) FROM PUBLIC');
      await expect(checkExtensionRights(user))
        .rejects.toThrow(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role};`);
      await db.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
      await checkExtensionRights(user);
    } finally {
      await user.end();
      await db.unsafe(`DROP OWNED BY ${role}`);
      await db.unsafe(`DROP ROLE ${role}`);
    }
  });
});

// The test data of this version (npm run fixture) fits this schema and comes
// back exactly as it went in.
test('the test data loads into db.sql and dumps back the same', async () => {
  const text = await readFile(join(FIXTURES, 'data.sql'), 'utf8');
  await scratch(`yartt_data_${process.pid}`, async (db) => {
    await db.unsafe(await readFile(DB_SQL_PATH, 'utf8'));
    await loadData(db, text);
    expect(await dumpData(db)).toBe(text);
  });
});

describe.skipIf(releases.length === 0)('releases', () => {
  test.each(releases)('%s becomes the schema of db.sql by the migrations', async (tag) => {
    await scratch(`yartt_release_${process.pid}`, async (db) => {
      await db.unsafe(git('show', `${tag}:db.sql`));
      await migrate(db);
      expect(await db.unsafe(FINGERPRINT)).toEqual(await sql.unsafe(FINGERPRINT));
    });
  });

  // The data of a release, migrated, is the data of today — but for what only
  // appeared later, which the asymmetry scripts of the steps between add
  // (tests/fixtures/<from>-<to>.sql). Everything else must come through the
  // migrations. Each step runs as of the release it starts from, as when its
  // fixture was made, so a migration may read now() and the check still
  // holds on any later day.
  test.each(releases)('%s carries its test data to the test data of today', async (tag) => {
    const oldSchema = git('show', `${tag}:db.sql`);
    let oldData: string;
    try {
      oldData = git('show', `${tag}:tests/fixtures/data.sql`);
    } catch {
      return; // released before there was test data
    }
    const target = versionOfDbSql(await readFile(DB_SQL_PATH, 'utf8'));
    const steps = planMigrations(parseMigrations(files), versionOfDbSql(oldSchema), target);
    let migrated: Record<string, string[]> = {};
    await scratch(`yartt_from_${process.pid}`, async (db) => {
      await db.unsafe(oldSchema);
      await loadData(db, oldData);
      await migrate(db);
      for (const step of steps) {
        const asymmetry = join(FIXTURES, step.file);
        if (existsSync(asymmetry)) await loadData(db, await readFile(asymmetry, 'utf8'));
      }
      migrated = await dataOf(db);
    }, releaseMoments());
    let expected: Record<string, string[]> = {};
    await scratch(`yartt_to_${process.pid}`, async (db) => {
      await db.unsafe(await readFile(DB_SQL_PATH, 'utf8'));
      await loadData(db, await readFile(join(FIXTURES, 'data.sql'), 'utf8'));
      expected = await dataOf(db);
    });
    expect(migrated).toEqual(expected);
  });
});
