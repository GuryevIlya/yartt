import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sql } from '../server/pg.ts';
import { client, createEmployee, shiftOn } from './helpers.ts';

async function createTask(ownerId: number): Promise<number> {
  return (await client(ownerId)).Task.create({ tags: [`m-${randomUUID().slice(0, 8)}`] });
}

async function kinds(employeeId: number) {
  return (await sql<{ payload: { kind: string; for?: number } }[]>`
    SELECT payload FROM notification WHERE employee_id = ${employeeId} ORDER BY id
  `).map((n) => n.payload);
}

/** A closed shift `daysAgo` days back, 8 hours from 09:00 in the employee's time zone. */
async function shift(employeeId: number, daysAgo: number, hours = 8) {
  const [row] = await sql<{ at: Date }[]>`
    SELECT ((local_today(${employeeId}) - ${daysAgo}::int) + time '09:00')
             AT TIME ZONE (SELECT time_zone FROM employee WHERE id = ${employeeId}) AS at
  `;
  await (await client(employeeId)).Work.add({ startedAt: row!.at, endedAt: new Date(row!.at.getTime() + hours * 3_600_000), about: null });
  const [day] = await sql<{ d: string }[]>`SELECT (local_today(${employeeId}) - ${daysAgo}::int)::text AS d`;
  return day!.d;
}

/** The closed shifts the employee began on a local day: a day's shifts are scored at once (decision 100). */
async function shiftsOn(employeeId: number, day: string): Promise<number[]> {
  return (await sql<{ id: number }[]>`
    SELECT w.id FROM work w JOIN employee e ON e.id = w.employee_id
     WHERE w.employee_id = ${employeeId} AND w.spent_minutes IS NOT NULL AND (w.started_at AT TIME ZONE e.time_zone)::date = ${day}::date
     ORDER BY w.started_at
  `).map((r) => r.id);
}

/** The employee's last `days` days, today included. */
async function lastDays(employeeId: number, days: number) {
  const [row] = await sql<{ from: string; to: string }[]>`
    SELECT (local_today(${employeeId}) - ${days - 1}::int)::text AS from, local_today(${employeeId})::text AS to
  `;
  return { employeeId, ...row! };
}

describe('ownership', () => {
  test('the owner hands a task over; the new owner is told and the old one stays an observer', async () => {
    const owner = await createEmployee();
    const heir = await createEmployee();
    const id = await createTask(owner.id);
    await (await client(owner.id)).Task.markReviewed({ id });

    await (await client(owner.id)).Task.transfer({ id, ownerId: heir.id });
    const task = await (await client(heir.id)).Task.get({ id });
    expect(task).toMatchObject({ ownerId: heir.id, access: 'owner' });
    expect(await sql`SELECT reviewed_at, handed_at IS NOT NULL AS handed FROM task WHERE id = ${id}`).toEqual([{ reviewedAt: null, handed: true }]);
    expect(await (await client(owner.id)).Task.get({ id })).toMatchObject({ access: 'observer' });
    expect((await kinds(heir.id)).map((n) => n.kind)).toEqual(['owner_change']);
    expect(await kinds(owner.id)).toEqual([]);
  });

  test("the owner's manager hands it over: both are told; nobody else may", async () => {
    const boss = await createEmployee();
    const owner = await createEmployee({ managerId: boss.id });
    const heir = await createEmployee();
    const id = await createTask(owner.id);

    await expect((await client(heir.id)).Task.transfer({ id, ownerId: heir.id })).rejects.toMatchObject({ message: 'forbidden' });
    await (await client(boss.id)).Task.transfer({ id, ownerId: heir.id });
    expect((await kinds(heir.id)).map((n) => n.kind)).toEqual(['owner_change']);
    expect(await kinds(owner.id)).toMatchObject([{ kind: 'owner_handed', by: boss.id, employeeId: heir.id }]);
  });

  test('every change of the owner is kept and shown in the feed, with who made it (decision 96)', async () => {
    const boss = await createEmployee();
    const owner = await createEmployee({ managerId: boss.id });
    const heir = await createEmployee();
    const id = await createTask(owner.id);
    const feed = async () => (await (await client(owner.id)).Comment.list({ taskId: id, filter: 'all', page: 1 })).items;
    // Creating a task is no change: when it was created is not kept.
    expect(await feed()).toEqual([]);

    await (await client(owner.id)).Task.transfer({ id, ownerId: heir.id });
    await (await client(heir.id)).Task.transfer({ id, ownerId: owner.id });
    await (await client(boss.id)).Task.transfer({ id, ownerId: boss.id });
    expect(await feed()).toMatchObject([
      { kind: 'owner', fromId: owner.id, toId: boss.id, byId: boss.id },
      { kind: 'owner', fromId: heir.id, toId: owner.id, byId: heir.id },
      { kind: 'owner', fromId: owner.id, toId: heir.id, byId: owner.id },
    ]);
    const [last] = await sql<{ same: boolean }[]>`
      SELECT k.handed_at = (SELECT max(at) FROM owner_change WHERE task_id = k.id) AS same FROM task k WHERE k.id = ${id}
    `;
    expect(last!.same).toBe(true);
    // An owner changed with nobody named is refused: the history would have a hole.
    await expect(sql`UPDATE task SET owner_id = ${heir.id} WHERE id = ${id}`).rejects.toThrow(/yartt.actor/);
  });

  test('an ownerless task is taken by someone who sees it', async () => {
    const owner = await createEmployee();
    const helper = await createEmployee();
    const stranger = await createEmployee();
    const id = await createTask(owner.id);
    await (await client(owner.id)).Observer.add({ taskId: id, employeeId: helper.id });
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('yartt.actor', ${String(owner.id)}, TRUE)`;
      await tx`UPDATE task SET owner_id = NULL WHERE id = ${id}`;
    });

    await expect((await client(stranger.id)).Task.take({ id })).rejects.toMatchObject({ message: 'no_access' });
    // The feed of an ownerless task opens (no comment is "new" for nobody).
    expect((await (await client(helper.id)).Comment.list({ taskId: id, filter: 'all', page: 1 })).items)
      .toMatchObject([{ kind: 'owner', fromId: owner.id, toId: null, byId: owner.id }]);
    await (await client(owner.id)).Comment.create({ taskId: id, html: '<p>Anyone?</p>', replyToId: null, files: [], mentionIds: [], taskIds: [] });
    expect((await (await client(helper.id)).Comment.list({ taskId: id, filter: 'all', page: 1 })).items).toMatchObject([{ isNew: false }, { kind: 'owner' }]);
    await (await client(helper.id)).Task.take({ id });
    expect(await (await client(helper.id)).Task.get({ id })).toMatchObject({ ownerId: helper.id });
    await expect((await client(owner.id)).Task.take({ id })).rejects.toMatchObject({ message: 'forbidden' });
  });
});

describe('absence', () => {
  test('while someone is away, their notifications are copied to the manager', async () => {
    const boss = await createEmployee();
    const away = await createEmployee({ managerId: boss.id });
    const colleague = await createEmployee();
    const [future] = await sql<{ d: string }[]>`SELECT (local_today(${away.id}) + 3)::text AS d`;
    await (await client(away.id)).Employee.updateSettings({ nextDay: future!.d });

    const id = await createTask(away.id);
    await (await client(away.id)).Observer.add({ taskId: id, employeeId: colleague.id });
    await (await client(colleague.id)).Comment.create({ taskId: id, html: '<p>Hi</p>', replyToId: null, files: [], mentionIds: [], taskIds: [] });

    expect((await kinds(away.id)).map((n) => n.kind)).toEqual(['comment']);
    expect(await kinds(boss.id)).toContainEqual(expect.objectContaining({ kind: 'comment', for: away.id }));
  });
});

describe('team', () => {
  test('the summary: the whole subtree, direct reports first; days to score; finished and missed deadlines', async () => {
    const boss = await createEmployee();
    const lead = await createEmployee({ managerId: boss.id });
    const dev = await createEmployee({ managerId: lead.id });
    const scored = await shift(dev.id, 1, 8);
    await shift(dev.id, 2, 6);
    await (await client(lead.id)).Team.score({ employeeId: dev.id, shiftIds: await shiftsOn(dev.id, scored), value: 80, reason: null });

    // Finished in time by the owner; late: closed after a deadline set in advance had passed (moved back in
    // SQL to simulate time); overdue: passed and not closed, still open (decision 93).
    const api = await client(dev.id);
    const finished = await createTask(dev.id);
    await api.Task.close({ id: finished }); // "Finish"
    for (const close of [true, false]) {
      const missed = await createTask(dev.id);
      await api.Task.setDeadline({ id: missed, deadline: new Date(Date.now() + 3_600_000) });
      await sql`UPDATE finished_at SET value = NOW() - INTERVAL '1 hour', entered_at = NOW() - INTERVAL '2 days' WHERE task_id = ${missed}`;
      if (close) await api.Task.close({ id: missed });
    }
    await createTask(dev.id); // open

    const range = await lastDays(boss.id, 7);
    const members = await (await client(boss.id)).Team.summary({ from: range.from, to: range.to });
    // Me first — my own report — then direct reports, then theirs.
    expect(members.map((m) => [m.employeeId, m.self, m.direct])).toEqual([[boss.id, true, false], [lead.id, false, true], [dev.id, false, false]]);
    expect(members[2]).toMatchObject({
      stats: { workMinutes: 14 * 60, workDays: 2, scoredDays: 1, weightedScore: 80 },
      unscoredDays: 1,
      finished: 1,
      late: 1,
      openTasks: 2,
    });
    expect((await (await client(dev.id)).Team.summary({ from: range.from, to: range.to })).map((m) => m.employeeId)).toEqual([dev.id]);
  });

  test('days and metrics: the employee and the managers above; others are refused', async () => {
    const boss = await createEmployee();
    const lead = await createEmployee({ managerId: boss.id });
    const dev = await createEmployee({ managerId: lead.id });
    const peer = await createEmployee({ managerId: boss.id });

    for (const viewer of [dev, lead, boss]) {
      expect((await (await client(viewer.id)).Team.history({ employeeId: dev.id, page: 1 })).days.length).toBeGreaterThan(0);
    }
    await expect((await client(peer.id)).Team.history({ employeeId: dev.id, page: 1 })).rejects.toMatchObject({ message: 'forbidden' });
    await expect((await client(dev.id)).Team.stats(await lastDays(lead.id, 30))).rejects.toMatchObject({ message: 'forbidden' });
  });

  test('a report\'s My day for managers above: their TODO without their reminders, their tasks; nobody else', async () => {
    const boss = await createEmployee();
    const lead = await createEmployee({ managerId: boss.id });
    const dev = await createEmployee({ managerId: lead.id });
    const peer = await createEmployee();
    const devApi = await client(dev.id);
    const open = await devApi.Task.create({ tags: [`a-${randomUUID().slice(0, 8)}`] });
    const closed = await devApi.Task.create({ tags: [`a-${randomUUID().slice(0, 8)}`] });
    await devApi.Task.close({ id: closed });
    await (await client(peer.id)).Observer.request({ taskId: open });
    await devApi.Remind.add({ taskId: open, at: new Date(Date.now() + 60_000), text: 'mine alone' });
    await sql`UPDATE remind SET at = date_trunc('second', NOW()) - INTERVAL '1 second' WHERE employee_id = ${dev.id}`;
    await sql`SELECT send_due_reminds()`;
    expect((await devApi.MyDay.todo()).map((i) => i.kind).sort()).toEqual(['remind', 'request']);

    const bossApi = await client(boss.id);
    expect(await bossApi.MyDay.todo({ as: dev.id })).toMatchObject([{ kind: 'request', task: { id: open }, employeeId: peer.id }]);
    expect((await bossApi.MyDay.current({ tab: 'mine', page: 1, as: dev.id })).items.map((t) => t.id)).toEqual([open]);
    expect(await bossApi.MyDay.waiting({ as: dev.id })).toEqual([]);
    await expect((await client(peer.id)).MyDay.todo({ as: dev.id })).rejects.toMatchObject({ message: 'forbidden' });
    await expect((await client(peer.id)).TagLimit.list({ as: dev.id })).rejects.toMatchObject({ message: 'forbidden' });
  });

  test('only the direct manager scores and corrects; the score is weighted by hours; every version is mailed', async () => {
    const boss = await createEmployee();
    const lead = await createEmployee({ managerId: boss.id });
    const dev = await createEmployee({ managerId: lead.id });
    const long = await shift(dev.id, 1, 9);
    const short = await shift(dev.id, 2, 3);

    await expect((await client(boss.id)).Team.score({ employeeId: dev.id, shiftIds: await shiftsOn(dev.id, long), value: 50, reason: null }))
      .rejects.toMatchObject({ message: 'not_manager' });
    const api = await client(lead.id);
    await api.Team.score({ employeeId: dev.id, shiftIds: await shiftsOn(dev.id, long), value: 100, reason: null });
    await api.Team.score({ employeeId: dev.id, shiftIds: await shiftsOn(dev.id, short), value: 40, reason: 'Wrong priorities' });
    const week = await api.Team.stats(await lastDays(dev.id, 7));
    expect(week.stats).toMatchObject({ scoredDays: 2, weightedScore: 85, workMinutes: 12 * 60 });
    expect(week.days).toHaveLength(7);
    expect(week.days.find((d) => d.day === long)).toEqual({ day: long, workMinutes: 9 * 60, spentMinutes: 0, score: 100, backlogMinutes: 0 });

    // A correction: the interface keeps the current value, the mail keeps the history.
    await api.Team.score({ employeeId: dev.id, shiftIds: await shiftsOn(dev.id, long), value: 90, reason: 'On second thought' });
    await api.Team.score({ employeeId: dev.id, shiftIds: await shiftsOn(dev.id, long), value: 90, reason: 'On second thought' }); // unchanged: no mail
    await expect((await client(boss.id)).Team.score({ employeeId: dev.id, shiftIds: await shiftsOn(dev.id, long), value: 10, reason: 'x' }))
      .rejects.toMatchObject({ message: 'not_manager' });
    await expect(sql`DELETE FROM score WHERE shift_id IN (SELECT id FROM work WHERE employee_id = ${dev.id})`).rejects.toMatchObject({ hint: 'score_final' });
    const mails = await kinds(dev.id);
    expect(mails).toHaveLength(3);
    expect(mails[2]).toMatchObject({ kind: 'score', day: long, value: 90, reason: 'On second thought', previous: { value: 100, reason: null } });
    expect((await api.Team.stats(await lastDays(dev.id, 7))).stats).toMatchObject({ weightedScore: 77.5 });
    await expect(api.Team.stats({ employeeId: dev.id, from: '2026-01-01', to: '2027-06-01' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const [day] = (await (await client(dev.id)).MyDay.history({ page: 1 })).days.filter((d) => d.day === short);
    expect(day?.shifts.map((s) => s.score)).toEqual([{ value: 40, reason: 'Wrong priorities' }]);
  });

  test('a shift past midnight counts in both days by its share, and its score in each (decision 100)', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee({ managerId: lead.id });
    const [row] = await sql<{ at: Date }[]>`
      SELECT ((local_today(${dev.id}) - 3) + time '22:00') AT TIME ZONE (SELECT time_zone FROM employee WHERE id = ${dev.id}) AS at
    `;
    const night = row!.at;
    await (await client(dev.id)).Work.add({ startedAt: night, endedAt: new Date(night.getTime() + 4 * 3_600_000), about: 'Release' });
    const [shiftId] = await shiftsOn(dev.id, (await lastDays(dev.id, 4)).from);
    const task = await createTask(dev.id);
    await (await client(dev.id)).Time.set({ taskId: task, shiftId: shiftId!, minutes: 180 });
    await (await client(lead.id)).Team.score({ employeeId: dev.id, shiftIds: [shiftId!], value: 60, reason: null });

    const week = await (await client(lead.id)).Team.stats(await lastDays(dev.id, 7));
    expect(week.stats).toMatchObject({ workMinutes: 240, workDays: 2, spentMinutes: 180, scoredDays: 2, weightedScore: 60 });
    expect(week.days.filter((d) => d.workMinutes > 0).map((d) => [d.workMinutes, d.spentMinutes, d.score])).toEqual([[120, 90, 60], [120, 90, 60]]);
  });

  test('a shift is the employee\'s until scored: several a day, corrected and deleted; a withdrawn score frees it', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee({ managerId: lead.id });
    const devApi = await client(dev.id);
    const leadApi = await client(lead.id);
    const day = await shift(dev.id, 3, 4);
    const history = async () => (await devApi.MyDay.history({ page: 1 })).days.find((d) => d.day === day)!;
    const [morning] = (await history()).shifts;

    // A second shift the same day, then corrections: the day is not scored yet.
    const afternoon = new Date(morning!.startedAt.getTime() + 5 * 3_600_000);
    await devApi.Work.add({ startedAt: afternoon, endedAt: new Date(afternoon.getTime() + 3_600_000), about: 'Calls' });
    await devApi.Work.update({ startedAt: afternoon, newStartedAt: afternoon, endedAt: new Date(afternoon.getTime() + 2 * 3_600_000), about: 'Calls, notes' });
    expect((await history()).shifts.map((s) => [s.spentMinutes, s.about])).toEqual([[240, null], [120, 'Calls, notes']]);
    await devApi.Work.remove({ startedAt: afternoon });
    expect((await history()).shifts).toHaveLength(1);

    // A score freezes the shift and the time logged in it (decision 100).
    const task = await createTask(dev.id);
    await devApi.Time.set({ taskId: task, shiftId: morning!.id, minutes: 60 });
    await leadApi.Team.score({ employeeId: dev.id, shiftIds: [morning!.id], value: 50, reason: 'The report was late' });
    await expect(devApi.Work.update({ startedAt: morning!.startedAt, newStartedAt: morning!.startedAt, endedAt: new Date(morning!.startedAt.getTime() + 3_600_000), about: null }))
      .rejects.toMatchObject({ message: 'shift_scored' });
    await expect(devApi.Work.remove({ startedAt: morning!.startedAt })).rejects.toMatchObject({ message: 'shift_scored' });
    await expect(devApi.Time.set({ taskId: task, shiftId: morning!.id, minutes: 30 })).rejects.toMatchObject({ message: 'shift_scored' });
    // Only the report's own shifts are theirs to score.
    await expect(leadApi.Team.score({ employeeId: dev.id, shiftIds: [await shiftOn(lead.id, day)], value: 50, reason: null }))
      .rejects.toMatchObject({ message: 'not_found' });

    // Withdrawn: the reason stays, the shift counts nowhere and is open again.
    await expect((await client((await createEmployee()).id)).Team.unscore({ employeeId: dev.id, shiftId: morning!.id }))
      .rejects.toMatchObject({ message: 'not_manager' });
    await leadApi.Team.unscore({ employeeId: dev.id, shiftId: morning!.id });
    expect((await history()).shifts[0]!.score).toEqual({ value: null, reason: 'The report was late' });
    expect((await leadApi.Team.stats(await lastDays(dev.id, 7))).stats).toMatchObject({ scoredDays: 0, weightedScore: null });
    const { from, to } = await lastDays(lead.id, 7);
    expect((await leadApi.Team.summary({ from, to })).find((m) => m.employeeId === dev.id)).toMatchObject({ unscoredDays: 1 });
    await devApi.Work.update({ startedAt: morning!.startedAt, newStartedAt: morning!.startedAt, endedAt: new Date(morning!.startedAt.getTime() + 5 * 3_600_000), about: 'Report done' });

    // Scored again; the mail tells a withdrawal and a new score apart.
    await leadApi.Team.score({ employeeId: dev.id, shiftIds: [morning!.id], value: 80, reason: 'The report was late, but done well' });
    const mails = (await kinds(dev.id)).filter((m) => m.kind === 'score');
    expect(mails.map((m) => (m as unknown as { value: number | null }).value)).toEqual([50, null, 80]);
  });

  test('the summary tells how late the timesheet is written and how fast mentions are answered', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee({ managerId: lead.id });
    const day = await shift(dev.id, 2, 8); // written two days late, minus the 8 hours
    const task = await createTask(lead.id);
    await (await client(lead.id)).Observer.add({ taskId: task, employeeId: dev.id });
    const ask = (await client(lead.id)).Comment.create;
    const asked = await ask({ taskId: task, html: '<p>Look</p>', replyToId: null, files: [], mentionIds: [dev.id], taskIds: [] });
    await ask({ taskId: task, html: '<p>And this</p>', replyToId: null, files: [], mentionIds: [dev.id], taskIds: [] });
    await (await client(dev.id)).Comment.create({ taskId: task, html: '<p>Done</p>', replyToId: asked, files: [], mentionIds: [], taskIds: [] });
    const { from, to } = await lastDays(lead.id, 7);

    const member = (await (await client(lead.id)).Team.summary({ from, to })).find((m) => m.employeeId === dev.id)!;
    expect(member.recordDelayMinutes).toBeGreaterThan(24 * 60);
    // The reply answers the mention it replies to, at once; the other one waits for its own.
    expect(member.replyMinutes).toBeGreaterThanOrEqual(0);
    expect(member.replyMinutes).toBeLessThan(5);
    expect(member.unanswered).toBe(1);
    expect(member.days).toHaveLength(7);
    expect(member.days.find((d) => d.day === day)).toMatchObject({ workMinutes: 8 * 60 });
    // The same day by day, for the charts: the shift's day was written late, today's mentions answered at once.
    expect(member.days.find((d) => d.day === day)!.recordDelayMinutes).toBeGreaterThan(24 * 60);
    expect(member.days.at(-1)!.replyMinutes).toBeLessThan(5);
    expect(member.days.at(-1)!.recordDelayMinutes).toBeNull();
  });

  test('someone dismissed before the range or invited after it is not in the summary; coming back clears the date', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee({ managerId: lead.id });
    const leadApi = await client(lead.id);
    await leadApi.Employee.dismiss({ id: dev.id });
    const ids = async (days: number) => (await leadApi.Team.summary(await lastDays(lead.id, days))).map((m) => m.employeeId);
    expect(await ids(7)).toEqual([lead.id, dev.id]); // dismissed today: worked in the range
    await sql`UPDATE employee SET dismissed_at = NOW() - INTERVAL '20 days' WHERE id = ${dev.id}`;
    expect(await ids(7)).toEqual([lead.id]);
    expect(await ids(30)).toEqual([lead.id, dev.id]);
    await leadApi.Employee.restore({ id: dev.id, email: `back-${randomUUID()}@example.com` });
    expect((await leadApi.Employee.list()).find((e) => e.id === dev.id)!.dismissedAt).toBeNull();
    expect(await ids(7)).toEqual([lead.id, dev.id]);
    // Invited after the range: not in it either.
    await sql`UPDATE employee SET created_at = NOW() + INTERVAL '2 days' WHERE id = ${dev.id}`;
    expect(await ids(7)).toEqual([lead.id]);
  });

  test('the last activity of each, whatever the range: a visit or a session; never for someone who never came', async () => {
    const boss = await createEmployee();
    const active = await createEmployee({ managerId: boss.id });
    const gone = await createEmployee({ managerId: boss.id });
    const never = await createEmployee({ managerId: boss.id });
    await sql`INSERT INTO visit (employee_id, at) VALUES (${active.id}, NOW() - INTERVAL '1 hour')`;
    await sql`INSERT INTO session (hash, employee_id, last_seen_at) VALUES (digest(${randomUUID()}, 'sha256'), ${gone.id}, NOW() - INTERVAL '40 days')`;
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Map((await (await client(boss.id)).Team.summary({ from: today, to: today })).map((m) => [m.employeeId, m.lastSeenAt]));
    expect(seen.get(active.id)!.getTime()).toBeGreaterThan(Date.now() - 2 * 3600_000);
    expect(seen.get(gone.id)!.getTime()).toBeLessThan(Date.now() - 39 * 86_400_000);
    expect(seen.get(never.id)).toBeNull();
  });

  test('reaction counts working time only: a mention after the shift, answered as the next began, took nothing', async () => {
    const dev = await createEmployee();
    const day = await shift(dev.id, 1, 8); // yesterday 09:00–17:00
    const at = async (time: string, daysAgo = 1) => (await sql<{ v: Date }[]>`
      SELECT ((local_today(${dev.id}) - ${daysAgo}::int) + ${time}::time) AT TIME ZONE (SELECT time_zone FROM employee WHERE id = ${dev.id}) AS v
    `)[0]!.v;
    const minutes = async (from: Date, to: Date) =>
      Number((await sql<{ v: string }[]>`SELECT working_minutes(${dev.id}, ${from}, ${to}) AS v`)[0]!.v);
    expect(day).toBeTruthy();
    expect(await minutes(await at('17:01'), await at('09:00', 0))).toBe(0);
    expect(await minutes(await at('16:00'), await at('18:00'))).toBe(60);
    await (await client(dev.id)).Work.start({ startedAt: new Date(Date.now() - 3_600_000) });
    // The shift's start is cut to the minute: an hour and up to a minute more.
    const open = await minutes(new Date(Date.now() - 2 * 3_600_000), new Date());
    expect(open).toBeGreaterThanOrEqual(60);
    expect(open).toBeLessThanOrEqual(61);
  });

  test('backlog: planned work on open tasks, its growth over the range; how long days wait for a score', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee({ managerId: lead.id });
    const devApi = await client(dev.id);
    const a = await createTask(dev.id);
    const b = await createTask(dev.id);
    await devApi.Time.setLeft({ taskId: a, minutes: 120 });
    await devApi.Time.setLeft({ taskId: b, minutes: 60 });
    await devApi.Time.setLeft({ taskId: b, minutes: 90 }); // re-estimated: the current value counts
    const day = await shift(dev.id, 2, 8);
    await (await client(lead.id)).Team.score({ employeeId: dev.id, shiftIds: await shiftsOn(dev.id, day), value: 70, reason: null });
    const { from, to } = await lastDays(lead.id, 7);
    const summary = async () => (await (await client(lead.id)).Team.summary({ from, to }));

    let member = (await summary()).find((m) => m.employeeId === dev.id)!;
    expect(member).toMatchObject({ backlogMinutes: 210, backlogGrowthMinutes: 210 });
    expect(member.days.at(-1)).toMatchObject({ backlogMinutes: 210 });
    // Overdue, it is still open: its plan stays in the backlog (decision 93); closed, it leaves it.
    await devApi.Task.setDeadline({ id: a, deadline: new Date(Date.now() + 3_600_000) });
    await sql`UPDATE finished_at SET value = NOW() WHERE task_id = ${a} AND expired_at IS NULL`;
    member = (await summary()).find((m) => m.employeeId === dev.id)!;
    expect(member.backlogMinutes).toBe(210);
    await sql`UPDATE finished_at SET confirmed_at = NOW() WHERE task_id = ${a} AND expired_at IS NULL`;
    member = (await summary()).find((m) => m.employeeId === dev.id)!;
    expect(member.backlogMinutes).toBe(90);
  });

  test('the weekly email: Monday from 09:00 in the manager\'s time zone, once, only when there is something', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee({ managerId: lead.id });
    const late = await createTask(dev.id);
    await sql`INSERT INTO finished_at (task_id, value) VALUES (${late}, NOW() - INTERVAL '1 day')`;
    const monday = async (time: string) => (await sql<{ at: Date }[]>`
      SELECT (date_trunc('week', NOW() AT TIME ZONE time_zone)::date + 7 + ${time}::time) AT TIME ZONE time_zone AS at
        FROM employee WHERE id = ${lead.id}
    `)[0]!.at;
    const digests = async () => (await sql<{ payload: { kind: string; overdue: number } }[]>`
      SELECT payload FROM notification WHERE employee_id = ${lead.id} AND payload->>'kind' = 'weekly_digest'
    `).map((n) => n.payload);

    await sql`SELECT send_weekly_digests(${await monday('08:59')})`;
    expect(await digests()).toEqual([]);
    await sql`SELECT send_weekly_digests(${await monday('09:05')})`;
    await sql`SELECT send_weekly_digests(${await monday('10:05')})`; // once a week
    expect(await digests()).toEqual([expect.objectContaining({ overdue: 1, atRisk: 0 })]);

    // A manager with nothing waiting gets no email: a day not scored is not asked for (decision 105).
    const calm = await createEmployee();
    await shift((await createEmployee({ managerId: calm.id })).id, 2, 8);
    await sql`SELECT send_weekly_digests(${await monday('09:30')})`;
    expect(await sql`SELECT 1 FROM notification WHERE employee_id = ${calm.id} AND payload->>'kind' = 'weekly_digest'`).toHaveLength(0);
  });
});
