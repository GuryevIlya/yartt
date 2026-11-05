// The load check (roadmap, before 1.0): a company of 300 people with two
// years of work, and the time every query of the interface takes in it.
//
//   DATABASE_URL=… npm run load -- generate   — into an empty database
//   DATABASE_URL=… npm run load -- measure    — the queries, as different people
//   LOAD_FROM=<step> … generate               — go on from the step a run stopped at
//
// The data is written in bulk by SQL with the triggers on, so the rules hold
// (observers of managers, local comment ids, shifts that do not overlap, time
// that fits its shift); moments the triggers stamp with NOW() are moved back
// afterwards. It is deterministic (setseed): two runs measure the same company.
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Context } from '../server/ctx.ts';
import { migrate } from '../server/migrate.ts';
import { sql } from '../server/pg.ts';
import { createCallerFactory } from '../server/trpc.ts';
import trpc from '../server/trpc/index.ts';

const PEOPLE = 300;
const TAGS = 300;
const TASKS = 40_000;
const DAYS = 730;

// LOAD_FROM=<step>: a run that stopped at that step goes on from it.
let resumeAt = process.env.LOAD_FROM || undefined;

// One connection, so that setseed() holds for every step.
let db: Awaited<ReturnType<typeof sql.reserve>>;

/**
 * Runs the step; with `batches`, once per range of ids [$from, $to): a
 * trigger takes an advisory lock per shift or task, and one statement
 * over all of them would run out of lock slots.
 */
async function step(name: string, query: string, batches?: { upTo: string; size: number }): Promise<void> {
  if (resumeAt !== undefined && name !== resumeAt) return;
  resumeAt = undefined;
  const started = performance.now();
  if (!batches) await db.unsafe(query);
  else {
    const [{ max }] = z.object({ max: z.number().nullable() }).array().parse(await db.unsafe(`SELECT max(id)::int AS max FROM ${batches.upTo}`)) as [{ max: number | null }];
    for (let from = 0; from <= (max ?? 0); from += batches.size) {
      await db.unsafe(query.replaceAll('$from', String(from)).replaceAll('$to', String(from + batches.size)));
    }
  }
  console.log(`  ${name.padEnd(28)} ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

async function generate(): Promise<void> {
  await migrate(sql);
  const [row] = z.object({ exists: z.boolean() }).array().parse(await sql`SELECT EXISTS (SELECT 1 FROM employee) AS exists`);
  if (row?.exists && !resumeAt) throw new Error('The database already has employees: give the load check an empty one');
  console.log('Generating the company:');
  db = await sql.reserve();
  try {
    await generateSteps();
  } finally {
    db.release();
  }

  const counts = await sql.unsafe(`
    SELECT (SELECT count(*) FROM task) AS tasks, (SELECT count(*) FROM observer) AS observers,
           (SELECT count(*) FROM comment) AS comments, (SELECT count(*) FROM mention) AS mentions,
           (SELECT count(*) FROM work) AS shifts, (SELECT count(*) FROM spent_minutes) AS entries,
           (SELECT count(*) FROM visit) AS visits,
           (SELECT count(*) FROM finished_at WHERE expired_at IS NULL AND confirmed_at IS NULL) AS open_tasks
  `);
  console.log(counts[0]);
}

async function generateSteps(): Promise<void> {
  // 1 CEO, 8 directors, 30 managers, the rest in their teams; the last ten left a year ago.
  await step('people', `
    BEGIN;
    INSERT INTO employee (id, email, full_name, time_zone, locale, pronoun, created_at)
    SELECT i, 'person' || i || '@load.test', 'Person ' || i,
           'Europe/Moscow', 'ru', CASE WHEN i % 2 = 0 THEN 'he' ELSE 'she' END, NOW() - INTERVAL '${DAYS + 30} days'
      FROM generate_series(1, ${PEOPLE}) i;
    INSERT INTO human (employee_id) SELECT id FROM employee;
    SELECT setval('employee_id_seq', ${PEOPLE});
    COMMIT;
    UPDATE employee SET manager_id = CASE WHEN id <= 9 THEN 1 WHEN id <= 39 THEN 2 + (id - 10) % 8 ELSE 10 + (id - 40) % 30 END
     WHERE id > 1;
    DELETE FROM notification;
    SELECT setseed(0.42);
  `);

  await step('tags', `
    INSERT INTO tag (name, created_at)
    SELECT 'area-' || lpad(i::text, 3, '0'), NOW() - INTERVAL '${DAYS} days' FROM generate_series(1, ${TAGS}) i;
  `);

  // Every task's life: when it was made, who owns it, when it closed (NULL — open).
  // Two tags each, every pair different (uq_task_tag_ids).
  await step('tasks', `
    CREATE TABLE load_task AS
    SELECT i AS id,
           NOW() - (${DAYS} * (1 - i::float / ${TASKS})) * INTERVAL '1 day' AS created,
           CASE WHEN r < 0.05 THEN 2 + (i % 8) WHEN r < 0.3 THEN 10 + (i % 30) ELSE 40 + (i * 7919) % ${PEOPLE - 39} END AS owner_id,
           ARRAY[(i % ${TAGS}) + 1, ((i % ${TAGS}) + 1 + (i / ${TAGS})) % ${TAGS} + 1] AS tag_ids,
           2 + floor(random() * 50)::int AS days,
           random() AS fate
      FROM (SELECT i, random() AS r FROM generate_series(1, ${TASKS}) i) s;
    ALTER TABLE load_task ADD COLUMN closed TIMESTAMPTZ;
    UPDATE load_task SET closed = created + days * INTERVAL '1 day' + fate * INTERVAL '3 days'
     WHERE fate > 0.04 AND created + (days + 3) * INTERVAL '1 day' < NOW();
    -- Who left a year ago owns nothing made after, nor anything still open: their manager took it.
    UPDATE load_task SET owner_id = 10 + (id % 30)
     WHERE owner_id > ${PEOPLE - 10} AND (created > NOW() - INTERVAL '365 days' OR closed IS NULL);
    ALTER TABLE load_task ADD PRIMARY KEY (id);

    INSERT INTO task (id, owner_id, tag_ids, priority, context)
    SELECT id, owner_id, tag_ids,
           (ARRAY['LOW','NORMAL','NORMAL','NORMAL','HIGH','CRITICAL']::priority[])[1 + id % 6],
           '<p>What is to be done in task ' || id || ', why and for whom. ' || repeat('Details of the work. ', 1 + id % 12) || '</p>'
      FROM load_task ORDER BY id;
    SELECT setval('task_id_seq', ${TASKS});
  `);

  // Participants: one to three from the owner's team or a neighbouring one; their
  // managers join through the trigger. Who works on a task: its owner and them.
  await step('participants', `
    CREATE TABLE load_worker AS
    SELECT t.id AS task_id, t.owner_id AS employee_id FROM load_task t
    UNION
    SELECT t.id, 40 + ((t.owner_id + k * 31 + t.id % 17) % ${PEOPLE - 39 - 10})
      FROM load_task t, generate_series(1, 3) k
     WHERE k <= 1 + t.id % 3;
    CREATE INDEX ON load_worker (employee_id, task_id);
    CREATE INDEX ON load_worker (task_id);

    INSERT INTO observer (task_id, value, added_by, added_at)
    SELECT w.task_id, w.employee_id, t.owner_id, NOW()
      FROM load_worker w JOIN load_task t ON t.id = w.task_id
     WHERE w.employee_id <> t.owner_id
    ON CONFLICT (task_id, value) WHERE deleted_at IS NULL DO NOTHING;
  `);

  // One task in twelve is public; then every moment stamped NOW() goes back to the task's start.
  await step('public tasks', `
    SELECT make_public(id, owner_id) FROM load_task WHERE id % 12 = 0;
    UPDATE observer o SET added_at = t.created + INTERVAL '1 minute' * (o.id % 30),
                          deleted_at = CASE WHEN o.deleted_at IS NULL THEN NULL ELSE t.created + INTERVAL '1 hour' END
      FROM load_task t WHERE t.id = o.task_id;
  `);

  // Deadlines: a closed task met its deadline or closed a few days late; one in five
  // had it moved once. Open: ahead, overdue or none. Plans on the open ones.
  await step('deadlines and plans', `
    INSERT INTO finished_at (task_id, value, entered_at, expired_at)
    SELECT id, created + (days - 3) * INTERVAL '1 day', created, created + INTERVAL '1 day'
      FROM load_task WHERE closed IS NOT NULL AND id % 5 = 0;
    INSERT INTO finished_at (task_id, value, entered_at, confirmed_at)
    SELECT id, created + days * INTERVAL '1 day', created + INTERVAL '1 day',
           CASE WHEN fate > 0.85 THEN closed ELSE created + days * INTERVAL '1 day' END
      FROM load_task WHERE closed IS NOT NULL;
    INSERT INTO finished_at (task_id, value, entered_at)
    SELECT id, created + days * INTERVAL '1 day' + INTERVAL '5 days', created
      FROM load_task WHERE closed IS NULL AND id % 10 < 7;
    INSERT INTO estimate_minutes (task_id, "by", value, entered_at)
    SELECT w.task_id, w.employee_id, 60 + (w.task_id * 37 + w.employee_id) % 2400, t.created
      FROM load_worker w JOIN load_task t ON t.id = w.task_id
     WHERE t.closed IS NULL AND (w.task_id + w.employee_id) % 3 <> 0;
    UPDATE task t SET reviewed_at = COALESCE(l.closed, NOW() - INTERVAL '1 day') FROM load_task l WHERE l.id = t.id AND l.id % 7 <> 0;
  `);

  await step('dependencies', `
    INSERT INTO dependency (task_id, value, latest_at, done_at, added_at, added_by)
    SELECT t.id, t.id - 1 - t.id % 40, CASE WHEN t.id % 2 = 0 THEN t.created + INTERVAL '10 days' END,
           p.closed, t.created, t.owner_id
      FROM load_task t JOIN load_task p ON p.id = t.id - 1 - t.id % 40
     WHERE t.id % 25 = 0;
  `);

  // A shift every working day (but one in twenty), 09:00–10:00 to 16:00–19:00 Moscow time.
  await step('shifts', `
    INSERT INTO work (employee_id, started_at, spent_minutes, about, updated_at)
    SELECT e.id, s.started, s.minutes, CASE WHEN (e.id + s.n) % 4 = 0 THEN 'What was done that day' END,
           s.started + s.minutes * INTERVAL '1 minute' + INTERVAL '10 minutes'
      FROM employee e
     CROSS JOIN LATERAL (
        SELECT n, ((CURRENT_DATE - n) + TIME '09:00' + ((e.id * 13 + n * 7) % 60) * INTERVAL '1 minute') AT TIME ZONE 'Europe/Moscow' AS started,
               420 + (e.id * 11 + n * 17) % 180 AS minutes
          FROM generate_series(1, ${DAYS}) n
         WHERE extract(isodow FROM CURRENT_DATE - n) < 6 AND (e.id + n) % 20 <> 0
     ) s
     WHERE e.id <= ${PEOPLE - 10} OR s.started < NOW() - INTERVAL '365 days';
  `);

  // Time on one to three of the tasks a person worked on and that were open that day.
  await step('time entries', `
    INSERT INTO spent_minutes (task_id, "by", shift_id, value, added_at, updated_at)
    SELECT x.task_id, w.employee_id, w.id, (w.spent_minutes * 0.28)::int,
           w.started_at + w.spent_minutes * INTERVAL '1 minute', w.started_at + w.spent_minutes * INTERVAL '1 minute'
      FROM work w
     CROSS JOIN LATERAL (
        SELECT lw.task_id FROM load_worker lw JOIN load_task t ON t.id = lw.task_id
         WHERE lw.employee_id = w.employee_id AND t.created <= w.started_at
           AND (t.closed IS NULL OR t.closed >= w.started_at)
           AND t.created > w.started_at - INTERVAL '90 days'
         ORDER BY (lw.task_id * 2654435761 + w.id) % 1000
         LIMIT 1 + w.id % 3
     ) x
     WHERE w.id >= $from AND w.id < $to;
  `, { upTo: 'work', size: 2000 });

  // The manager scores most days, the last fortnight waits.
  await step('scores', `
    INSERT INTO score (shift_id, "by", value, reason, added_at)
    SELECT w.id, e.manager_id, 50 + (w.id * 7) % 51, CASE WHEN w.id % 9 = 0 THEN 'Why this score' END,
           w.started_at + INTERVAL '1 day'
      FROM work w JOIN employee e ON e.id = w.employee_id
     WHERE e.manager_id IS NOT NULL AND w.started_at < NOW() - INTERVAL '14 days' AND w.id % 10 < 8;
  `);

  // Comments by those who work on the task over its life, some of them replies; one in
  // fifty with a file. One in four mentions a colleague, who mostly answers.
  await step('files', `
    WITH f AS (SELECT i, decode(repeat(md5(i::text), 128), 'hex') || int4send(i) AS v FROM generate_series(1, 4000) i),
         a AS (
           INSERT INTO attachment (hash, size, mime, uploaded_by, added_at, used_at)
           SELECT digest(v, 'sha256'), length(v), 'application/pdf', ARRAY[40 + i % 250], NOW() - INTERVAL '1 day' * (i % ${DAYS}), NOW()
             FROM f
           RETURNING id, hash
         )
    INSERT INTO attachment_content (attachment_id, value)
    SELECT a.id, f.v FROM a JOIN f ON digest(f.v, 'sha256') = a.hash;
  `);
  await step('comment plan', `
    CREATE TABLE load_comment AS
    SELECT t.id AS task_id, n,
           (SELECT employee_id FROM load_worker lw WHERE lw.task_id = t.id ORDER BY (employee_id * 31 + n) % 7 LIMIT 1) AS author,
           t.created + (COALESCE(t.closed, NOW()) - t.created) * (n::float / (2 + t.id % 9)) AS at
      FROM load_task t, generate_series(1, 1 + t.id % 9) n;
  `);
  await step('comments', `
    INSERT INTO comment (task_id, created_by, value, attachment_ids, attachment_names, created_at, reply_to_id)
    SELECT task_id, author,
           '<p>Comment ' || n || ' on task ' || task_id || ': ' || repeat('what was found and what is next. ', 1 + (task_id + n) % 6) || '</p>',
           CASE WHEN (task_id + n) % 50 = 0 THEN ARRAY[1 + (task_id + n) % 4000] ELSE '{}' END,
           CASE WHEN (task_id + n) % 50 = 0 THEN ARRAY['report.pdf'] ELSE '{}' END,
           at, CASE WHEN n > 1 AND (task_id + n) % 5 = 0 THEN n - 1 END
      FROM load_comment WHERE task_id >= $from AND task_id < $to ORDER BY task_id, n;
  `, { upTo: 'task', size: 2000 });
  await step('mentions', `
    INSERT INTO mention (task_id, comment_id, value, created_at, closed_at)
    SELECT c.task_id, c.id, w.employee_id, c.created_at,
           CASE WHEN c.created_at < NOW() - INTERVAL '3 days' OR c.id % 3 = 0 THEN c.created_at + INTERVAL '1 hour' * (1 + c.id % 40) END
      FROM comment c
     CROSS JOIN LATERAL (
        SELECT employee_id FROM load_worker lw
         WHERE lw.task_id = c.task_id AND lw.employee_id <> c.created_by
           AND lw.employee_id <= ${PEOPLE - 10}
         LIMIT 1
     ) w
     WHERE (c.task_id + c.id) % 4 = 0;
  `);
  // Authors look at the reactions to their mentions within a couple of days.
  await step('reviews', `
    UPDATE comment c SET reviewed_at = c.created_at + INTERVAL '2 days'
     WHERE c.created_at < NOW() - INTERVAL '7 days'
       AND EXISTS (SELECT 1 FROM mention m WHERE m.task_id = c.task_id AND m.comment_id = c.id);
  `);
  await step('answers', `
    INSERT INTO comment (task_id, created_by, value, created_at, reply_to_id)
    SELECT m.task_id, m.value, '<p>Answered: done as asked.</p>', m.closed_at - INTERVAL '5 minutes', m.comment_id
      FROM mention m WHERE m.closed_at IS NOT NULL AND m.comment_id % 2 = 0
       AND m.task_id >= $from AND m.task_id < $to
     ORDER BY m.task_id, m.comment_id;
  `, { upTo: 'task', size: 2000 });
  await step('notifications', `
    INSERT INTO notification (employee_id, task_id, added_at, sent_at, closed_at, payload)
    SELECT m.value, m.task_id, m.created_at, m.created_at + INTERVAL '1 minute', m.closed_at,
           jsonb_build_object('kind', 'mention', 'commentId', m.comment_id, 'by', c.created_by)
      FROM mention m JOIN comment c ON c.task_id = m.task_id AND c.id = m.comment_id;
  `);

  // A few visits each working day: My day and the tasks worked on.
  await step('visits', `
    INSERT INTO visit (employee_id, task_id, at)
    SELECT w.employee_id, NULL, w.started_at FROM work w
    UNION ALL
    SELECT s."by", s.task_id, w.started_at + INTERVAL '40 minutes' FROM spent_minutes s JOIN work w ON w.id = s.shift_id;
  `);

  await step('budgets and reminders', `
    INSERT INTO tag_limit (employee_id, tag_ids, starts_on, ends_on, minutes, created_at)
    SELECT 10 + i % 30, ARRAY[1 + i * 3], CURRENT_DATE - 60, CURRENT_DATE + 120, 200 * 60, NOW() - INTERVAL '60 days'
      FROM generate_series(0, 59) i;
    INSERT INTO remind (employee_id, task_id, at, value)
    SELECT w.employee_id, w.task_id, NOW() + INTERVAL '1 hour' * (w.task_id % 200), 'Check on it'
      FROM load_worker w JOIN load_task t ON t.id = w.task_id
     WHERE t.closed IS NULL AND w.task_id % 9 = 0;
  `);

  await step('dismissals', `
    UPDATE employee SET dismissed_at = NOW() - INTERVAL '365 days', email = NULL WHERE id > ${PEOPLE - 10};
    DROP TABLE load_task, load_worker, load_comment;
  `);
  await step('vacuum', 'VACUUM ANALYZE');

}

// --- measure ----------------------------------------------------------------

const createCaller = createCallerFactory(trpc);
const as = (employeeId: number) => createCaller({
  employeeId, bot: null, sessionToken: null, setSessionCookie: () => {}, clearSessionCookie: () => {},
  ssoPending: null, setSsoPendingCookie: () => {}, clearSsoPendingCookie: () => {},
  changeId: null, loginBrowser: null, setLoginBrowserCookie: () => {},
} satisfies Context);

const RUNS = 7;

/** A call's median and worst of RUNS runs after a warm-up; one over a second is timed once. */
async function time(call: () => Promise<unknown>): Promise<{ median: number; max: number }> {
  const first = performance.now();
  await call();
  const once = performance.now() - first;
  if (once > 1000) return { median: once, max: once };
  const runs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    await call();
    runs.push(performance.now() - started);
  }
  runs.sort((a, b) => a - b);
  return { median: runs[Math.floor(RUNS / 2)]!, max: runs[RUNS - 1]! };
}

const Id = z.object({ id: z.number() });

async function measure(): Promise<void> {
  const one = async (query: string) => Id.array().parse(await sql.unsafe(query))[0]!.id;
  // The busiest of each kind: the most open tasks seen, the most tasks worked on.
  const member = await one(`
    SELECT e.id FROM employee e WHERE e.id >= 40 AND e.dismissed_at IS NULL
     ORDER BY (SELECT count(*) FROM observer o WHERE o.value = e.id AND o.deleted_at IS NULL) DESC LIMIT 1`);
  const manager = await one(`SELECT manager_id AS id FROM employee WHERE id = ${member}`);
  const director = await one(`SELECT manager_id AS id FROM employee WHERE id = ${manager}`);
  const ceo = 1;
  const busyTask = await one(`
    SELECT t.id FROM task t JOIN finished_at f ON f.task_id = t.id AND f.expired_at IS NULL AND f.confirmed_at IS NULL
     JOIN observer o ON o.task_id = t.id AND o.value = ${member} AND o.deleted_at IS NULL
     ORDER BY (SELECT count(*) FROM comment c WHERE c.task_id = t.id) DESC LIMIT 1`);
  const [{ today }] = z.object({ today: z.string() }).array().parse(await sql`SELECT local_today(1)::text AS today`) as [{ today: string }];
  const daysBack = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const tagIds = (await sql`SELECT tag_ids FROM task WHERE id = ${busyTask}`)[0]!.tagIds as number[];

  const people = { member, manager, director, ceo };
  console.log(`Measuring as ${JSON.stringify(people)}, task ${busyTask}; median and worst of ${RUNS} runs, ms:`);

  const slow: string[] = [];
  const report = async (name: string, call: () => Promise<unknown>) => {
    const t = await time(call);
    const line = `  ${name.padEnd(44)} ${t.median.toFixed(0).padStart(6)} ${t.max.toFixed(0).padStart(6)}`;
    console.log(line);
    if (t.median > 200) slow.push(line);
  };

  for (const [who, id] of Object.entries(people)) {
    const api = as(id);
    const report_ = id === member ? manager : member;
    console.log(`${who} (${id}):`);
    // The poll of an open My day, every 30 seconds.
    await report('MyDay.todo', () => api.MyDay.todo());
    await report('Work.open', () => api.Work.open());
    await report('MyDay.waiting', () => api.MyDay.waiting());
    await report('MyDay.current mine', () => api.MyDay.current({ tab: 'mine', page: 1 }));
    await report('MyDay.current team', () => api.MyDay.current({ tab: 'team', page: 1 }));
    await report('MyDay.current others', () => api.MyDay.current({ tab: 'others', page: 1 }));
    await report('MyDay.current closed', () => api.MyDay.current({ tab: 'closed', page: 1 }));
    await report('MyDay.history', () => api.MyDay.history({ page: 1, size: 2 }));
    await report('TagLimit.list', () => api.TagLimit.list());
    await report('Bot.list', () => api.Bot.list());
    // Opened once: statistics, search, people.
    await report('Team.summary 30 days', () => api.Team.summary({ from: daysBack(29), to: today }));
    await report('Team.summary a year', () => api.Team.summary({ from: daysBack(364), to: today }));
    await report('Tags.stats 30 days', () => api.Tags.stats({ since: daysBack(29), tagIds: [], page: 1, sort: 'active' }));
    await report('Tags.stats a year', () => api.Tags.stats({ since: daysBack(364), tagIds: [], page: 1, sort: 'active' }));
    await report('Task.search all', () => api.Task.search({ tagIds: [tagIds[0]!], tab: 'all', page: 1 }));
    await report('Task.search closed', () => api.Task.search({ tagIds: [tagIds[0]!], tab: 'closed', page: 1 }));
    await report('Tags.suggest', () => api.Tags.suggest({ text: 'area 12' }));
    await report('Tags.mine', () => api.Tags.mine({ query: '', page: 1 }));
    await report('Employee.list', () => api.Employee.list());
    if (id !== member) {
      await report('Team.stats of a report, a year', () => api.Team.stats({ employeeId: member, from: daysBack(364), to: today }));
      await report('Team.history of a report', () => api.Team.history({ employeeId: member, page: 1, size: 7 }));
      await report('MyDay.todo as a report', () => api.MyDay.todo({ as: member }));
    } else {
      await report('Team.stats of oneself, a year', () => api.Team.stats({ employeeId: report_ === manager ? member : report_, from: daysBack(364), to: today }));
    }
    // A task open in a tab.
    await report('Task.get', () => api.Task.get({ id: busyTask }));
    await report('MyDay.todo of the task', () => api.MyDay.todo({ taskId: busyTask }));
    await report('Comment.list all', () => api.Comment.list({ taskId: busyTask, filter: 'all', page: 1 }));
    await report('Comment.list mentions', () => api.Comment.list({ taskId: busyTask, filter: 'mentions', page: 1 }));
    await report('Observer.list', () => api.Observer.list({ taskId: busyTask, page: 1 }));
    await report('Time.mine', () => api.Time.mine({ taskId: busyTask }));
    await report('TagLimit.forTask', () => api.TagLimit.forTask({ taskId: busyTask }));
  }
  console.log(slow.length ? `\nOver 200 ms:\n${slow.join('\n')}` : '\nNothing over 200 ms.');
}

const command = process.argv[2];
try {
  if (command === 'generate') await generate();
  else if (command === 'measure') await measure();
  else {
    console.error('npm run load -- generate | measure');
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
