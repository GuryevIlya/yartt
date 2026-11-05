import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Sql } from './pg.ts';

// The schema is versioned as major.minor (see db.sql, schema_version); the
// first version is 0.0.
//   - empty database -> db.sql is applied as a whole;
//   - older database -> migrations server/migrations/<from>-<to>.sql in a chain;
//   - otherwise      -> error.
// Everything runs in one transaction under an advisory lock: if any step fails,
// the database stays at the old version. Hence commands that cannot run
// inside a transaction are forbidden in migrations.

export const DB_SQL_PATH = join(import.meta.dirname, '..', 'db.sql');
export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export type Version = { major: number; minor: number };
export type Migration = { from: Version; to: Version; file: string };

// How long a migration waits for a lock before failing. Without a limit it would
// queue behind a running instance's queries and block everyone behind itself.
const LOCK_TIMEOUT = '30s';

const NON_TRANSACTIONAL = /\b(CONCURRENTLY|VACUUM)\b/i;

/**
 * The SQL without comments and string literals, which say nothing about
 * commands (a COMMENT may well mention VACUUM). A small lexer: a regular
 * expression trips over an apostrophe inside a comment.
 */
function codeOnly(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      out += '\n';
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (text[i] === "'") {
      // A literal ends at a quote not followed by another ('' is a quote inside).
      for (i++; i < text.length; i++) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") i++;
          else break;
        }
      }
      out += "''";
    } else {
      out += text[i];
    }
  }
  return out;
}

// Rejects commands that cannot run inside a transaction.
export function checkMigrationSql(file: string, text: string): void {
  const match = NON_TRANSACTIONAL.exec(codeOnly(text));
  if (match) {
    throw new Error(`Migration ${file}: ${match[1]!.toUpperCase()} cannot run inside a transaction`);
  }
}

export function parseVersion(text: string): Version {
  const match = /^(\d+)\.(\d+)$/.exec(text);
  if (!match) throw new Error(`Invalid schema version "${text}"`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export const formatVersion = (v: Version) => `${v.major}.${v.minor}`;

const sameVersion = (a: Version, b: Version) => a.major === b.major && a.minor === b.minor;

// The version db.sql sets.
export function versionOfDbSql(dbSql: string): Version {
  const match = /INSERT INTO schema_version \(version\) VALUES \('([^']+)'\)/.exec(dbSql);
  if (!match) throw new Error('db.sql does not set schema_version');
  return parseVersion(match[1]!);
}

// Migration files: "1.3-1.4.sql".
export function parseMigrations(files: string[]): Migration[] {
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = /^(\d+\.\d+)-(\d+\.\d+)\.sql$/.exec(file);
    if (!match) continue;
    const from = parseVersion(match[1]!);
    const to = parseVersion(match[2]!);

    const minorStep = to.major === from.major && to.minor === from.minor + 1;
    const majorStep = to.major === from.major + 1 && to.minor === 0;
    if (!minorStep && !majorStep) {
      throw new Error(`Migration ${file}: expected X.Y-X.(Y+1) or X.last-(X+1).0`);
    }
    migrations.push({ from, to, file });
  }

  const byFrom = new Map<string, string>();
  for (const m of migrations) {
    const key = formatVersion(m.from);
    const other = byFrom.get(key);
    if (other) {
      throw new Error(`Migrations ${other} and ${m.file} both start at ${key}: a major step is allowed only from the last minor`);
    }
    byFrom.set(key, m.file);
  }
  return migrations;
}

// Migration chain from `from` to `to`.
export function planMigrations(migrations: Migration[], from: Version, to: Version): Migration[] {
  const plan: Migration[] = [];
  let current = from;
  while (!sameVersion(current, to)) {
    const next = migrations.find((m) => sameVersion(m.from, current));
    if (!next) {
      throw new Error(`No migration path from schema ${formatVersion(from)} to ${formatVersion(to)} (stuck at ${formatVersion(current)})`);
    }
    plan.push(next);
    current = next.to;
  }
  return plan;
}

export type MigrateResult =
  | { action: 'installed'; version: string }
  | { action: 'migrated'; version: string; files: string[] }
  | { action: 'none'; version: string };

const State = z.object({ hasVersion: z.boolean(), hasTables: z.boolean() });
const CurrentVersion = z.object({ version: z.string() });

export async function migrate(sql: Sql): Promise<MigrateResult> {
  const dbSql = await readFile(DB_SQL_PATH, 'utf8');
  const target = versionOfDbSql(dbSql);
  const migrations = parseMigrations(await readdir(MIGRATIONS_DIR));

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('yartt.migrate'))`;

    const [state] = State.array().parse(await tx`
      SELECT to_regclass('public.schema_version') IS NOT NULL AS has_version,
             EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public') AS has_tables
    `);

    if (!state?.hasVersion) {
      if (state?.hasTables) {
        throw new Error('Database is not empty and has no schema_version: refusing to touch it');
      }
      await tx.unsafe(dbSql);
      return { action: 'installed', version: formatVersion(target) };
    }

    const [row] = CurrentVersion.array().length(1).parse(await tx`
      SELECT version FROM schema_version WHERE expired_at IS NULL
    `);
    if (row!.version === 'demo') {
      throw new Error('This database holds the demo (DEMO_DATA), which is never migrated: start the demo with DEMO_DATA, or give the installation a database of its own');
    }
    const current = parseVersion(row!.version);
    if (sameVersion(current, target)) return { action: 'none', version: formatVersion(target) };
    if (current.major > target.major || (current.major === target.major && current.minor > target.minor)) {
      throw new Error(`Database schema ${formatVersion(current)} is newer than this application (${formatVersion(target)})`);
    }

    const plan = planMigrations(migrations, current, target);
    const texts = await Promise.all(plan.map((step) => readFile(join(MIGRATIONS_DIR, step.file), 'utf8')));
    plan.forEach((step, i) => checkMigrationSql(step.file, texts[i]!));

    await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    for (const [i, step] of plan.entries()) {
      try {
        await tx.unsafe(texts[i]!);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${step.file} failed, schema stays at ${formatVersion(current)}: ${reason}`);
      }
      // clock_timestamp(): steps of one transaction get distinct times.
      await tx`UPDATE schema_version SET expired_at = clock_timestamp() WHERE expired_at IS NULL`;
      await tx`INSERT INTO schema_version (version, entered_at) VALUES (${formatVersion(step.to)}, clock_timestamp())`;
    }
    return { action: 'migrated', version: formatVersion(target), files: plan.map((m) => m.file) };
  });
}

const CurrentUser = z.object({ currentUser: z.string() });

/**
 * Whether this database user may call what yartt calls from the extensions.
 * PUBLIC may by default, but a company's PostgreSQL can be stricter (say, a
 * revoking ALTER DEFAULT PRIVILEGES when the extensions are created), and
 * neither installing nor migrating the schema notices: every request would
 * fail later, on the first function it needs. So it is said at startup, with
 * what to do. Only what is really called is tried, not all that the
 * extensions have: an administrator may well close the rest.
 */
export async function checkExtensionRights(sql: Sql): Promise<void> {
  try {
    await sql`
      SELECT digest('', 'sha256'), gen_random_bytes(1), 'a'::citext = 'A'::citext,
             similarity('a', 'b'), levenshtein('a', 'b')
    `;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== '42501') throw error;
    const [row] = CurrentUser.array().length(1).parse(await sql`SELECT quote_ident(current_user) AS current_user`);
    throw new Error(
      `The database user may not call the functions of the extensions (${error.message}). `
      + `As their owner or a superuser, run: GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${row!.currentUser}; `
      + '(with the schema of the extensions, if it is not public)',
    );
  }
}
