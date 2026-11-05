// The notes of a GitHub release (docs/engineering/release.md): what changed
// since the previous release, from the commit messages, which are written
// as a changelog (AGENTS.md, Commits), and what an administrator must know
// before upgrading — the schema and its migrations, the configuration
// that came or went, the installation guide that changed — found in git,
// not remembered. Prints Markdown:
//
//   node scripts/release-notes.ts 0.8.0 [previous]

import { execFileSync } from 'node:child_process';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (tag: string) => RELEASE.exec(tag)!.slice(1).map(Number);
const before = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
};

const [tag, given] = process.argv.slice(2);
if (!tag || !RELEASE.test(tag)) {
  console.error('Usage: node scripts/release-notes.ts <tag, 1.2.3> [previous tag]');
  process.exit(2);
}
const previous = given ?? git('tag', '--list').split('\n').filter((t) => RELEASE.test(t) && before(t, tag))
  .sort((a, b) => (before(a, b) ? 1 : -1))[0];

const fileAt = (ref: string, path: string) => {
  try {
    return git('show', `${ref}:${path}`);
  } catch {
    return '';
  }
};
const schemaOf = (ref: string) => /INSERT INTO schema_version \(version\) VALUES \('([^']+)'\)/.exec(fileAt(ref, 'db.sql'))?.[1];
const settingsOf = (ref: string) => new Set([...fileAt(ref, 'server/env.ts').matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!));

const range = previous ? `${previous}..${tag}` : tag;
const commits = git('log', '--no-merges', '--reverse', '--format=%h%x1f%s', range).split('\n').filter(Boolean)
  .map((line) => line.split('\x1f') as [string, string])
  // A version set on its own says nothing a reader needs.
  .filter(([, subject]) => !/^Version \d/.test(subject));

const lines: string[] = [];
lines.push(previous ? `Changes since ${previous}.` : 'The first release.', '');
lines.push('## What changed', '');
for (const [hash, subject] of commits) lines.push(`- ${subject} (${hash})`);
lines.push('');

const watch: string[] = [];
if (previous) {
  const [from, to] = [schemaOf(previous), schemaOf(tag)];
  if (from !== to) {
    const migrations = git('diff', '--name-only', '--diff-filter=A', range, '--', 'server/migrations').split('\n').filter(Boolean);
    watch.push(`- **The schema goes from ${from} to ${to}.** The migrations run on start, all in one transaction: if one fails, the database stays on ${from} and the container exits with the reason. Take a backup of PostgreSQL first.`);
    for (const file of migrations) {
      // A migration says what it does in its opening comment.
      const said = fileAt(tag, file).split('\n').slice(1).filter((l) => l.startsWith('--')).map((l) => l.replace(/^--\s?/, ''));
      const first = said.join('\n').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ');
      watch.push(`  - \`${file.split('/').pop()}\`${first ? `: ${first}` : ''}`);
    }
  }
  const [was, is] = [settingsOf(previous), settingsOf(tag)];
  const added = [...is].filter((k) => !was.has(k));
  const removed = [...was].filter((k) => !is.has(k));
  if (added.length) watch.push(`- **New settings:** ${added.map((k) => `\`${k}\``).join(', ')} — see docs/admin/install.md.`);
  if (removed.length) watch.push(`- **Settings no longer read:** ${removed.map((k) => `\`${k}\``).join(', ')} — remove them from your env file.`);
  const guide = git('diff', '--name-only', range, '--', 'docs/admin').split('\n').filter(Boolean);
  if (guide.length) watch.push(`- **The installation guide changed:** ${guide.map((f) => `\`${f}\``).join(', ')}.`);
}
lines.push('## Before upgrading', '');
lines.push(...(watch.length ? watch : ['Nothing to do but replace the image.']), '');
process.stdout.write(lines.join('\n'));
