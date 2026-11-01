// Demo data that touches every screen, in Russian or English
// (demoTexts.ts): an org chart (managers, an absent and a dismissed
// employee, an invite, pronouns and a bot without one),
// tasks private and public, open and closed, handed over and ownerless,
// with comments, replies, mentions, attached tasks and files, access
// requests, a dependency, reminders, drawn avatars, personal tag colors and
// weights, time left and logged, shifts (closed, open,
// suggested), visits and scores (one of them corrected).
//
// Seeded by `npm run seed` (scripts/seed.ts) and, in the image, on start
// with DEMO_DATA=ru|en, afresh on every start and every night (refreshDemo).
// The company is its own, CEO included — FIRST_EMPLOYEE_* plays no part —
// and the database's schema version is demo (schema_version).
//
// Data goes through the API procedures wherever one exists, so the triggers
// and checks run as in real use. Moments are relative to today, so the
// demo looks fresh whenever it is seeded.
import { z } from 'zod';
import type { Context } from './ctx.ts';
import { gradient, portrait, robot, type Look } from './demoImages.ts';
import { demoTexts, type DemoLanguage } from './demoTexts.ts';
import { migrate } from './migrate.ts';
import { sql } from './pg.ts';
import * as Attachments from './services/Attachment.ts';
import { createCallerFactory } from './trpc.ts';
import trpc from './trpc/index.ts';

const createCaller = createCallerFactory(trpc);
const as = (employeeId: number, bot: Context['bot'] = null) => {
  const ctx: Context = { employeeId, bot, sessionToken: null, setSessionCookie: () => {}, clearSessionCookie: () => {},
    ssoPending: null, setSsoPendingCookie: () => {}, clearSsoPendingCookie: () => {},
  };
  return createCaller(ctx);
};

const Row = z.object({ id: z.number() });
const Moment = z.object({ value: z.date() });
const Text = z.object({ value: z.string() });
const Exists = z.object({ exists: z.boolean() });

// --- helpers ---------------------------------------------------------------

/** A moment `daysAgo` days back at local time `hm` in the employee's time zone. */
async function at(employeeId: number, daysAgo: number, hm: string): Promise<Date> {
  const [row] = Moment.array().parse(await sql`
    SELECT ((local_today(${employeeId}) - ${daysAgo}::int) + ${hm}::time)
             AT TIME ZONE (SELECT time_zone FROM employee WHERE id = ${employeeId}) AS value
  `);
  return row!.value;
}

/** The employee's local day `daysAgo` days back, YYYY-MM-DD. */
async function day(employeeId: number, daysAgo: number): Promise<string> {
  const [row] = Text.array().parse(await sql`SELECT (local_today(${employeeId}) - ${daysAgo}::int)::text AS value`);
  return row!.value;
}

/** Visits cannot be logged in the past through the API (log_visit uses NOW()). */
async function visit(employeeId: number, taskId: number | null, moment: Date): Promise<void> {
  await sql`INSERT INTO visit (employee_id, task_id, at) VALUES (${employeeId}, ${taskId}, ${moment})`;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/**
 * `minutes` ago, but not before the employee's local midnight: today's activity
 * stays in today even when the seed runs just after midnight (a shift started
 * from it at 00:00 belongs to the new day).
 */
async function todayAgo(employeeId: number, minutes: number): Promise<Date> {
  const midnight = await at(employeeId, 0, '00:00');
  const moment = minutesAgo(minutes);
  return moment < midnight ? midnight : moment;
}
const daysAhead = (days: number) => new Date(Date.now() + days * 86_400_000);

const comment = (taskId: number, html: string, extra: { mentionIds?: number[]; everyone?: boolean; taskIds?: number[]; replyToId?: number; files?: { id: number; name: string }[] } = {}) => ({
  taskId,
  html,
  replyToId: extra.replyToId ?? null,
  files: extra.files ?? [],
  mentionIds: extra.mentionIds ?? [],
  everyone: extra.everyone ?? false,
  exceptIds: [],
  taskIds: extra.taskIds ?? [],
});

/**
 * The last `n` working days before today, oldest first (Saturdays and Sundays
 * skipped): as many whatever the day of the week the demo is seeded on.
 */
async function workdays(employeeId: number, n: number): Promise<number[]> {
  const result: number[] = [];
  for (let daysAgo = 1; result.length < n; daysAgo++) {
    const weekday = new Date(`${await day(employeeId, daysAgo)}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) result.unshift(daysAgo);
  }
  return result;
}

const Tables = z.object({ hasTables: z.boolean(), hasVersion: z.boolean() });
const Seeded = z.object({ enteredAt: z.date() });

/**
 * Whether the database holds anything, and when the demo seeded it: its
 * current schema_version is demo (null: not a demo — an empty database, or
 * a real one).
 */
async function demoState(): Promise<{ hasTables: boolean; seededAt: Date | null }> {
  const [tables] = Tables.array().parse(await sql`
    SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public') AS has_tables,
           to_regclass('public.schema_version') IS NOT NULL AS has_version
  `);
  if (!tables?.hasVersion) return { hasTables: tables?.hasTables ?? false, seededAt: null };
  const [demo] = Seeded.array().parse(await sql`
    SELECT entered_at FROM schema_version WHERE expired_at IS NULL AND version = 'demo'
  `);
  return { hasTables: true, seededAt: demo?.enteredAt ?? null };
}

/** Marks the database as the demo, seeded now: demo closes the installed version (schema_version). */
async function mark(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE schema_version SET expired_at = clock_timestamp() WHERE expired_at IS NULL`;
    await tx`INSERT INTO schema_version (version, entered_at) VALUES ('demo', clock_timestamp())`;
  });
}

/** How the people look on their avatars (the bot is a robot; Anna never signed in, so has none). */
const LOOKS = {
  first: { background: [92, 107, 192], skin: [241, 194, 160], hair: [90, 90, 96], shirt: [38, 50, 56] },
  marina: { background: [236, 64, 122], skin: [248, 208, 180], hair: [160, 82, 45], shirt: [255, 255, 255], long: true },
  pavel: { background: [38, 166, 154], skin: [224, 172, 135], hair: [30, 30, 30], shirt: [255, 152, 0] },
  ivan: { background: [66, 165, 245], skin: [245, 205, 170], hair: [222, 184, 135], shirt: [69, 90, 100] },
  olga: { background: [255, 167, 38], skin: [141, 85, 36], hair: [20, 20, 20], shirt: [33, 150, 243], long: true },
  oleg: { background: [120, 144, 156], skin: [232, 180, 150], hair: [110, 70, 40], shirt: [121, 85, 72] },
  sergey: { background: [171, 71, 188], skin: [250, 215, 190], hair: [60, 40, 30], shirt: [96, 125, 139] },
} satisfies Record<string, Look>;

/**
 * Fills a database with no employees with the demo company in `lang` and
 * marks it as a demo. Everyone speaks the demo's language and lives in its
 * time zone (the CEO's, inherited by whoever is invited).
 */
export async function seedDemo(lang: DemoLanguage): Promise<void> {
  const t = demoTexts[lang];

  const [row] = Exists.array().parse(await sql`SELECT EXISTS (SELECT 1 FROM employee) OR EXISTS (SELECT 1 FROM task) AS exists`);
  if (row?.exists) throw new Error('The database already has data');

  // --- people --------------------------------------------------------------

  const p = t.people;
  const [first] = Row.array().parse(await sql`
    WITH e AS (
      INSERT INTO employee (email, full_name, about, locale, time_zone)
      VALUES (${p.first.email}, ${p.first.name}, ${p.first.about}, ${lang}, ${t.timeZone})
      RETURNING id
    )
    INSERT INTO human (employee_id) SELECT id FROM e RETURNING employee_id AS id
  `);
  const me = first!.id;
  await mark();
  const I = as(me);

  const invite = async (by: number, person: { email: string; name: string }) =>
    (await as(by).Employee.invite({ email: person.email, fullName: person.name })).id;
  const profile = (id: number, person: { email: string; name: string; about: string }) =>
    as(id).Employee.updateProfile({ fullName: person.name, about: person.about });

  const marina = await invite(me, p.marina);
  await as(marina).Employee.setManager({ managerId: me });
  await profile(marina, p.marina);

  const pavel = await invite(marina, p.pavel);
  await as(pavel).Employee.setManager({ managerId: marina });
  await profile(pavel, p.pavel);

  const ivan = await invite(marina, p.ivan);
  await as(ivan).Employee.setManager({ managerId: marina });

  const olga = await invite(me, p.olga);
  await as(olga).Employee.setManager({ managerId: me });
  await as(olga).Employee.updateSettings({ nextDay: await day(olga, -5) }); // on vacation: back in 5 days

  const oleg = await invite(me, p.oleg); // no manager: another department
  await profile(oleg, p.oleg);

  const sergey = await invite(marina, p.sergey);
  await as(sergey).Employee.setManager({ managerId: marina });

  await invite(olga, p.anna); // invited, never signed in

  // A team bot: no pronoun, so verbs about it keep both endings ("упомянул(а)").
  // It posts through the API with its key (not kept anywhere) and may only comment.
  const { id: bot } = await I.Bot.create({
    fullName: p.bot.name, pronoun: null, about: p.bot.about, permissions: ['comment'], webhookUrl: null,
  });

  // Pronouns pick verb forms ("упомянула"); the bot keeps none.
  for (const [id, pronoun] of [[me, 'he'], [marina, 'she'], [pavel, 'he'], [ivan, 'he'], [olga, 'she'], [oleg, 'he'], [sergey, 'he']] as const) {
    await as(id).Employee.updateSettings({ pronoun });
  }

  // --- tasks ---------------------------------------------------------------

  const P = as(pavel), M = as(marina), V = as(ivan), O = as(oleg), L = as(olga), S = as(sergey);
  const tags = t.tags;

  // 1. My task with a context, observers, a file and an image; new comments wait for my review.
  const site = await I.Task.create({ tags: tags.site });
  await I.Task.update({ id: site, priority: 'HIGH', context: t.context.site });
  await I.Task.setDeadline({ id: site, deadline: daysAhead(3) });
  await I.Observer.add({ taskId: site, employeeId: pavel });
  await I.Time.setLeft({ taskId: site, minutes: 240 });
  await P.Time.setLeft({ taskId: site, minutes: 600 });
  // Plans made three weeks ago; Pavel's has grown since: My team shows his backlog rising.
  await sql`UPDATE estimate_minutes SET entered_at = NOW() - INTERVAL '21 days' WHERE task_id = ${site}`;
  await sql`UPDATE estimate_minutes SET expired_at = NOW() - INTERVAL '5 days' WHERE task_id = ${site} AND "by" = ${pavel}`;
  await sql`INSERT INTO estimate_minutes (task_id, "by", value, entered_at) VALUES (${site}, ${pavel}, 900, NOW() - INTERVAL '5 days')`;

  // 2. My task; Oleg asks for access.
  const report = await I.Task.create({ tags: tags.report });
  await I.Task.setDeadline({ id: report, deadline: daysAhead(10) });
  await I.Task.update({ id: report, context: t.context.report });
  await O.Observer.request({ taskId: report });

  // 3. Marina's task (I see it as her manager); she mentions me.
  const stock = await M.Task.create({ tags: tags.stock });
  await M.Task.update({ id: stock, priority: 'CRITICAL' });
  await M.Task.setDeadline({ id: stock, deadline: daysAhead(1) });
  await M.Observer.add({ taskId: stock, employeeId: ivan });

  // 4. Oleg's public task: everyone sees it in "others".
  const move = await O.Task.create({ tags: tags.move });
  await O.Task.update({ id: move, context: t.context.move });
  await O.Task.setDeadline({ id: move, deadline: daysAhead(14) });
  await O.Task.makePublic({ id: move });

  // 5. My task, already reviewed: not in TODO.
  const hiring = await I.Task.create({ tags: tags.hiring });
  await I.Observer.add({ taskId: hiring, employeeId: olga });

  // 6. My task, finished: its deadline moved twice and then "Finish".
  const budget = await I.Task.create({ tags: tags.budget });
  await I.Task.setDeadline({ id: budget, deadline: daysAhead(2) });
  await I.Task.setDeadline({ id: budget, deadline: daysAhead(4) });
  await I.Task.close({ id: budget });

  // 7. Pavel's task waits for the site and needs it by the day after tomorrow — but the site is due
  // later: both tasks are at risk, his late because of mine, mine delaying his (I am told).
  const auth = await P.Task.create({ tags: tags.auth });
  await P.Task.update({ id: auth, priority: 'HIGH' });
  await P.Task.setDeadline({ id: auth, deadline: daysAhead(7) });
  await P.Dependency.set({ taskId: auth, value: site, latestAt: daysAhead(2) });

  // 7a. Pavel takes part in my site and needs a deadline of his own for the reviews: he makes a task of
  // his own the site waits for (decision 94) — a new link in my review.
  const reviews = await P.Task.create({ tags: tags.reviews, deadline: daysAhead(2), waitedOnBy: site });
  await P.Time.setLeft({ taskId: reviews, minutes: 180 });

  // 8. Sergey's task goes to Marina when he is dismissed. He worked on it before leaving (20 days
  // ago, below), so all of it is dated three weeks back: a comment is never changed, it is written so.
  const laptops = await S.Task.create({ tags: tags.laptops });
  await S.Task.setDeadline({ id: laptops, deadline: daysAhead(5) });
  await sql`UPDATE finished_at SET entered_at = NOW() - INTERVAL '21 days' WHERE task_id = ${laptops}`;
  await sql`UPDATE observer SET added_at = NOW() - INTERVAL '21 days' WHERE task_id = ${laptops}`;
  await sql`
    INSERT INTO comment (task_id, created_by, value, created_at)
    VALUES (${laptops}, ${sergey}, ${t.comments.laptops}, NOW() - INTERVAL '21 days')
  `;

  // 9. Ivan's support tickets: enough for pages in "others".
  const tickets: number[] = [];
  for (let n = 1; n <= 22; n++) {
    const id = await V.Task.create({ tags: [tags.support, tags.ticket(1040 + n)] });
    if (n % 4 !== 0) await V.Task.setDeadline({ id, deadline: daysAhead(n % 9 + 1) });
    if (n % 5 === 0) await V.Task.update({ id, priority: 'HIGH' });
    if (n % 7 === 0) await V.Task.update({ id, priority: 'LOW' });
    tickets.push(id);
  }

  // 10. Handed over by the manager: Marina gives Pavel's task to Ivan (Pavel is told).
  const apiDocs = await P.Task.create({ tags: tags.apiDocs });
  await M.Task.transfer({ id: apiDocs, ownerId: ivan });

  // 11. An ownerless task (an owner without a manager left; only SQL can make one now).
  const printer = await O.Task.create({ tags: tags.printer });
  await O.Observer.add({ taskId: printer, employeeId: me });
  await O.Comment.create(comment(printer, t.comments.printer));
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('yartt.actor', ${String(oleg)}, TRUE)`;
    await tx`UPDATE task SET owner_id = NULL WHERE id = ${printer}`;
  });

  // 12. For the team summary: Marina closed a task in time; Pavel's is overdue — set a week
  // ahead, passed three days ago (only SQL can move time), still open until he closes it (decision 93).
  const vendor = await M.Task.create({ tags: tags.vendor });
  await M.Task.setDeadline({ id: vendor, deadline: daysAhead(2) });
  // My report waits for it too: closed by its owner, it is done for me at once.
  await I.Dependency.set({ taskId: report, value: vendor, latestAt: null });
  await M.Task.close({ id: vendor });
  const promo = await P.Task.create({ tags: tags.promo });
  await P.Task.setDeadline({ id: promo, deadline: daysAhead(7) });
  // Hours still planned on it: Pavel clears them before he can close it.
  await P.Time.setLeft({ taskId: promo, minutes: 120, about: t.planAbout });
  await sql`UPDATE finished_at SET value = NOW() - INTERVAL '3 days', entered_at = NOW() - INTERVAL '10 days' WHERE task_id = ${promo}`;

  // 13. What deadlines bring to Waiting for me: my report's deadline is tomorrow morning (set
  // days ago); it waits for Pavel's promo, overdue — Pavel is reminded to close it or move
  // the deadline, and it is not done for me until he closes it (decision 93).
  await I.Dependency.set({ taskId: report, value: promo, latestAt: null });
  await sql`
    UPDATE finished_at SET value = NOW() + INTERVAL '20 hours', entered_at = NOW() - INTERVAL '5 days'
     WHERE task_id = ${report} AND expired_at IS NULL
  `;

  // 14. Olga's private task (I see it as her manager).
  const docs = await L.Task.create({ tags: tags.docs });
  await L.Task.update({ id: docs, priority: 'LOW', context: t.context.docs });

  // --- comments ------------------------------------------------------------

  const c = t.comments;
  const image = await Attachments.upload(pavel, gradient(480, 200), 'image/png');
  const file = await Attachments.upload(pavel, Buffer.from(c.csv), 'text/csv');
  const mockup = await P.Comment.create(comment(site, c.mockup(`/api/attachments/${image}`), { files: [{ id: file, name: c.csvName }] }));
  await I.Comment.create(comment(site, c.carouselAsk, { replyToId: mockup }));
  await P.Comment.create(comment(site, c.carouselDone, { mentionIds: [marina] }));
  // I tell everyone in the task; Pavel closes it without a reply, and it waits in my Waiting for others for "Accepted".
  const moved = await I.Comment.create(comment(site, c.demoMoved, { everyone: true }));
  await P.Comment.closeMention({ taskId: site, commentId: moved });
  await P.Comment.create(comment(auth, c.auth, { taskIds: [site] }));

  await M.Comment.create(comment(stock, c.stockSign, { mentionIds: [me] }));
  const recount = await M.Comment.create(comment(stock, c.recount, { mentionIds: [ivan] }));
  await V.Comment.create(comment(stock, c.recounted, { replyToId: recount }));
  await V.Comment.closeMention({ taskId: stock, commentId: recount });

  await O.Comment.create(comment(move, c.seating));
  await P.Comment.create(comment(move, c.monitors));

  await L.Comment.create(comment(hiring, c.candidates));
  await I.Comment.create(comment(hiring, c.thanks));
  await I.Task.markReviewed({ id: hiring });

  await V.Comment.create(comment(tickets[0]!, c.ticket));

  // The bot reports a failed build and mentions the owner: it shows in my TODO with neutral verbs.
  await I.Observer.add({ taskId: site, employeeId: bot });
  await as(bot, ['comment']).Comment.create(comment(site, c.build, { mentionIds: [me] }));
  // Its calls over the last two weeks, for Bots under My team: a quiet weekend, one refusal
  // (it tried to close a task); and a key issued over a year ago, so its manager is reminded.
  await sql`
    INSERT INTO bot_usage (bot_id, day, requests, refused, last_request_at)
    SELECT ${bot}, d::date, 20 + (extract(day FROM d)::int * 7) % 30, CASE WHEN d = CURRENT_DATE - 3 THEN 1 ELSE 0 END,
           d + TIME '17:40'
      FROM generate_series(local_today(${bot}) - 13, local_today(${bot}) - 1, INTERVAL '1 day') d
     WHERE extract(isodow FROM d) < 6
        ON CONFLICT (bot_id, day) DO UPDATE
       SET requests = bot_usage.requests + EXCLUDED.requests, refused = bot_usage.refused + EXCLUDED.refused
  `;
  await sql`UPDATE bot SET key_issued_at = NOW() - INTERVAL '14 months' WHERE employee_id = ${bot}`;

  await M.Employee.dismiss({ id: sergey });
  // He left three weeks ago: My team shows him for 30 days, not for 7.
  await sql`UPDATE employee SET dismissed_at = NOW() - INTERVAL '20 days' WHERE id = ${sergey}`;

  // --- days: visits, time logged, shifts ----------------------------------

  // Me: shifts on most days; two days left without one — they show a suggested shift.
  const myDays = await workdays(me, 10);
  for (const [i, d] of myDays.entries()) {
    await visit(me, null, await at(me, d, `09:0${i % 6}`));
    await visit(me, site, await at(me, d, '10:15'));
    await visit(me, report, await at(me, d, '14:40'));
    if (i % 3 === 0) await visit(me, stock, await at(me, d, '16:05'));
    await visit(me, null, await at(me, d, `18:1${i % 6}`));
    await I.Time.set({ taskId: site, day: await day(me, d), minutes: 90 + (i % 4) * 30 });
    await I.Time.set({ taskId: report, day: await day(me, d), minutes: 60 + (i % 3) * 15 });
    if (i % 4 === 0) await I.Time.set({ taskId: hiring, day: await day(me, d), minutes: 45 });
    if (i === myDays.length - 1 || i === myDays.length - 4) continue;
    await I.Work.add({
      startedAt: await at(me, d, '09:00'),
      endedAt: await at(me, d, `18:${10 + (i % 5) * 5}`),
      about: t.shifts.mine[i % 4]!,
    });
  }
  // Today: came in, opened a task, logged time — the shift is not started yet.
  await visit(me, null, await todayAgo(me, 95));
  await visit(me, site, await todayAgo(me, 70));
  await I.Time.set({ taskId: report, day: await day(me, 0), minutes: 45 });

  // Pavel: closed shifts, and the last workday's shift is still open.
  const pavelDays = await workdays(pavel, 7);
  for (const [i, d] of pavelDays.entries()) {
    await visit(pavel, null, await at(pavel, d, '09:20'));
    await visit(pavel, site, await at(pavel, d, '09:25'));
    await visit(pavel, auth, await at(pavel, d, '15:00'));
    // One evening he came back and worked without writing it down: History suggests that shift.
    if (i === 4) {
      await visit(pavel, site, await at(pavel, d, '20:10'));
      await visit(pavel, null, await at(pavel, d, '21:05'));
    }
    await P.Time.set({ taskId: site, day: await day(pavel, d), minutes: 300 + (i % 3) * 30 });
    await P.Time.set({ taskId: auth, day: await day(pavel, d), minutes: 90 });
    if (i === pavelDays.length - 1) await P.Work.start({ startedAt: await at(pavel, d, '09:20') });
    else await P.Work.add({ startedAt: await at(pavel, d, '09:20'), endedAt: await at(pavel, d, '18:30'), about: t.shifts.pavel });
  }

  // Marina: closed shifts.
  const marinaDays = await workdays(marina, 7);
  for (const d of marinaDays) {
    await visit(marina, null, await at(marina, d, '08:50'));
    await visit(marina, stock, await at(marina, d, '11:00'));
    await M.Time.set({ taskId: stock, day: await day(marina, d), minutes: 120 });
    await M.Work.add({ startedAt: await at(marina, d, '08:50'), endedAt: await at(marina, d, '17:45'), about: t.shifts.marina });
  }

  // The shifts above were written now, days after they ended. Make them look written on time —
  // minutes after the end — except Pavel's, written the next day: My team shows how late
  // the timesheet is written. The trigger stamps updated_at itself, so it is off for this.
  await sql`ALTER TABLE work DISABLE TRIGGER work_check`;
  await sql`
    UPDATE work SET updated_at = started_at + spent_minutes * INTERVAL '1 minute'
                                + CASE WHEN employee_id = ${pavel} THEN INTERVAL '1 day 2 hours' ELSE INTERVAL '12 minutes' END
     WHERE spent_minutes IS NOT NULL
  `;
  await sql`ALTER TABLE work ENABLE TRIGGER work_check`;

  // Scores: I score some of Marina's days, Marina some of Pavel's; the rest wait. A score freezes its day.
  const score = async (employeeId: number, by: number, daysAgo: number, value: number, reason: string | null) =>
    as(by).Team.score({ employeeId, day: await day(employeeId, daysAgo), value, reason });
  await score(marina, me, marinaDays[0]!, 90, null);
  await score(marina, me, marinaDays[1]!, 70, t.scores.late);
  await score(marina, me, marinaDays[3]!, 100, null);
  await score(pavel, marina, pavelDays[0]!, 95, t.scores.mockups);
  await score(pavel, marina, pavelDays[1]!, 80, null);
  await score(pavel, marina, pavelDays[2]!, 50, t.scores.refactoring);
  // A correction: Pavel's mail keeps both versions, the interface shows only 65%.
  await score(pavel, marina, pavelDays[2]!, 65, t.scores.corrected);

  // --- personal touches --------------------------------------------------

  // Avatars (the HTTP endpoint is for browsers; the bytes are the same): everyone who signed in.
  const avatars = [
    [me, portrait(LOOKS.first)], [marina, portrait(LOOKS.marina)], [pavel, portrait(LOOKS.pavel)],
    [ivan, portrait(LOOKS.ivan)], [olga, portrait(LOOKS.olga)], [oleg, portrait(LOOKS.oleg)],
    [sergey, portrait(LOOKS.sergey)], [bot, robot()],
  ] as const;
  for (const [id, image] of avatars) {
    await sql`INSERT INTO avatar (employee_id, value, mime) VALUES (${id}, ${image}, 'image/png')`;
  }

  // My tag colors and weights: the site and the report first and colored, support sinks.
  const tagId = async (name: string) => Row.array().parse(await sql`SELECT id FROM tag WHERE name = ${name}`)[0]!.id;
  await I.Tags.set({ tagId: await tagId(tags.site[0]!), color: '#1e88e5', weight: 3 });
  await I.Tags.set({ tagId: await tagId(tags.report[0]!), color: '#43a047', weight: 2 });
  await I.Tags.set({ tagId: await tagId(tags.stock[0]!), color: '#fb8c00', weight: 0 });
  await I.Tags.set({ tagId: await tagId(tags.support), color: null, weight: -1 });

  // My reminders on the site: tomorrow morning and before the deadline.
  await I.Remind.add({ taskId: site, at: await at(me, -1, '09:30'), text: t.reminder });
  await I.Remind.add({ taskId: site, at: daysAhead(2), text: null });
  // And one that came due this morning: it waits in Waiting for me until removed or put off.
  await sql`
    INSERT INTO remind (employee_id, task_id, at, value, sent_at)
    VALUES (${me}, ${site}, date_trunc('minute', NOW()) - INTERVAL '2 hours', ${t.dueReminder}, NOW() - INTERVAL '2 hours')
  `;

  // Hour budgets: mine on the site for half a year — what is logged and planned already goes past
  // it, a forecast to see; Marina's on the warehouse, raised once, so it has a history.
  const dayOf = (n: number) => daysAhead(n).toISOString().slice(0, 10);
  await I.TagLimit.set({ replaces: null, tagIds: [await tagId(tags.site[0]!)], startsOn: dayOf(-30), endsOn: dayOf(150), minutes: 80 * 60 });
  const stockLimit = { tagIds: [await tagId(tags.stock[0]!)], startsOn: dayOf(-30), endsOn: dayOf(60) };
  const stockFirst = await M.TagLimit.set({ replaces: null, ...stockLimit, minutes: 10 * 60 });
  await M.TagLimit.set({ replaces: stockFirst, ...stockLimit, minutes: 20 * 60 });
}

/** Who is in the demo. */
export async function printDemoSummary(): Promise<void> {
  const people = z.object({ fullName: z.string(), email: z.string().nullable(), dismissedAt: z.date().nullable() }).array().parse(await sql`
    SELECT full_name, email, dismissed_at FROM employee ORDER BY id
  `);
  console.log('\nSeeded the demo data. Employees:');
  for (const person of people) console.log(`  ${person.fullName.padEnd(18)} ${person.email ?? ''}${person.dismissedAt ? ' (dismissed)' : ''}`);
  console.log('');
}

/** Seeded this recently, the demo is not seeded again: another instance has just done it. */
const FRESH_MS = 10 * 60_000;

/**
 * DEMO_DATA, instead of migrating and the first employee: a fresh demo,
 * so its days are always around today. A database marked as the demo is
 * wiped and installed from db.sql — never migrated: nothing in it is worth
 * keeping — and an empty one installed; then the demo is seeded and marked.
 * A database with tables and no mark holds real data: it is refused and
 * left untouched. Several instances starting at once wait for each other
 * (the bootstrap lock), and a demo seeded minutes ago by one of them stays.
 *
 * `night`: the worker's nightly run — only a marked demo seeded before
 * today, after 03:00 in the demo company's time zone; anything else stays.
 */
export async function refreshDemo(lang: DemoLanguage, when: 'start' | 'night' = 'start'): Promise<void> {
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(hashtext('yartt.bootstrap'))`;
    const state = await demoState();
    if (when === 'night' && (!state.seededAt || !(await nightAfter(state.seededAt)))) return;
    if (state.hasTables && !state.seededAt) {
      throw new Error('DEMO_DATA is set, but the database holds real data: unset DEMO_DATA, or give the demo an empty database');
    }
    if (when === 'start' && state.seededAt && Date.now() - state.seededAt.getTime() < FRESH_MS) {
      console.log('DEMO_DATA: the demo was seeded minutes ago, it stays');
      return;
    }
    if (state.hasTables) {
      await conn.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      console.log(`DEMO_DATA: the previous demo is wiped (${when === 'night' ? 'the nightly refresh' : 'on start'})`);
    }
    await migrate(sql);
    await seedDemo(lang);
    await printDemoSummary();
  } finally {
    await conn`SELECT pg_advisory_unlock(hashtext('yartt.bootstrap'))`;
    conn.release();
  }
}

const Due = z.object({ due: z.boolean() });

/** A new day in the demo company (its CEO's time zone) since `seededAt`, and past 03:00 there. */
async function nightAfter(seededAt: Date): Promise<boolean> {
  const [row] = Due.array().parse(await sql`
    SELECT (NOW() AT TIME ZONE tz)::date > (${seededAt}::timestamptz AT TIME ZONE tz)::date
           AND (NOW() AT TIME ZONE tz)::time >= '03:00' AS due
      FROM (SELECT time_zone AS tz FROM employee ORDER BY id LIMIT 1) company
  `);
  return row?.due ?? false;
}
