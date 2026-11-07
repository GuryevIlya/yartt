import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sql } from '../server/pg.ts';
import { client, createEmployee, dayAgo, logTime, shiftOn } from './helpers.ts';

async function createTask(ownerId: number): Promise<number> {
  return (await client(ownerId)).Task.create({ tags: [`d-${randomUUID().slice(0, 8)}`] });
}

const comment = (taskId: number, html: string, mentionIds: number[] = []) =>
  ({ taskId, html, replyToId: null, files: [], mentionIds, taskIds: [] });

describe('waiting', () => {
  test('my requests not answered and my comments with mentions not reviewed, the longest waiting first, with their answers', async () => {
    const me = await createEmployee();
    const owner = await createEmployee();
    const helper = await createEmployee();
    const theirs = await createTask(owner.id);
    const mine = await createTask(me.id);
    const api = await client(me.id);

    await api.Observer.request({ taskId: theirs });
    await api.Observer.add({ taskId: mine, employeeId: helper.id });
    const asked = await api.Comment.create(comment(mine, '<p>Can you check?</p>', [helper.id]));
    expect(await api.MyDay.waiting()).toMatchObject([
      { kind: 'request', task: { id: theirs } },
      { kind: 'mention', task: { id: mine }, commentId: asked, excerpt: 'Can you check?', people: [{ employeeId: helper.id, closedAt: null, replies: [] }] },
    ]);

    // Answered and closed: it stays until I review it (decision 98); the request is gone once withdrawn.
    const helperApi = await client(helper.id);
    const answer = await helperApi.Comment.create({ ...comment(mine, '<p>Checked</p>'), replyToId: asked });
    await api.Observer.withdraw({ taskId: theirs });
    await helperApi.Comment.closeMention({ taskId: mine, commentId: asked });
    expect(await api.MyDay.waiting()).toMatchObject([{ kind: 'mention', people: [{ closedAt: expect.any(Date), replies: [{ id: answer, excerpt: 'Checked' }] }] }]);
    await api.Comment.reviewComment({ taskId: mine, commentId: asked });
    expect(await api.MyDay.waiting()).toEqual([]);
  });
});

describe('todo', () => {
  test('a passed deadline: a day of warning, then overdue and open until its owner closes it, done for what waits only then', async () => {
    const owner = await createEmployee();
    const helper = await createEmployee();
    const waiting = await createEmployee();
    const task = await createTask(owner.id);
    const dependent = await createTask(waiting.id);
    const api = await client(owner.id);
    const helperApi = await client(helper.id);
    const waitingApi = await client(waiting.id);
    // A link joins two tasks its author sees (decision 94).
    await api.Observer.add({ taskId: task, employeeId: waiting.id });
    await waitingApi.Dependency.set({ taskId: dependent, value: task, latestAt: null });
    await api.Observer.add({ taskId: task, employeeId: helper.id });
    await helperApi.Time.setLeft({ taskId: task, minutes: 120 });
    const kinds = async (employeeId: number) => (await sql<{ payload: { kind: string } }[]>`
      SELECT payload FROM notification WHERE employee_id = ${employeeId} ORDER BY id
    `).map((n) => n.payload.kind);
    const todo = async (employeeId: number) =>
      (await (await client(employeeId)).MyDay.todo()).filter((i) => i.kind === 'review' || i.kind === 'plan_left');

    // Set two days ahead, now 12 hours away: in the review, computed — nothing is sent.
    await api.Task.setDeadline({ id: task, deadline: new Date(Date.now() + 12 * 3_600_000) });
    await sql`UPDATE finished_at SET entered_at = NOW() - INTERVAL '2 days' WHERE task_id = ${task}`;
    const [closing] = await todo(owner.id);
    expect(closing).toMatchObject({ kind: 'review', task: { id: task }, deadline: { overdue: false } });
    // A notice a day before it: a review takes it away.
    await api.Task.markReviewed({ id: task, until: closing?.kind === 'review' ? closing.at : undefined });
    expect(await todo(owner.id)).toEqual([]);

    // The deadline came: the task is overdue, still open; the owner closes it once Helper's plan is gone.
    await sql`UPDATE finished_at SET value = NOW() - INTERVAL '1 minute' WHERE task_id = ${task} AND expired_at IS NULL`;
    expect(await todo(owner.id)).toMatchObject([{
      kind: 'review', task: { id: task, closed: false }, deadline: { overdue: true, plans: [{ employeeId: helper.id, minutes: 120 }] },
    }]);
    expect(await todo(helper.id)).toMatchObject([{ kind: 'plan_left', task: { id: task }, minutes: 120 }]);
    expect(await todo(waiting.id)).toEqual([]);
    expect((await api.MyDay.current({ tab: 'mine', page: 1 })).items.map((t) => t.id)).toContain(task);
    // A review never takes an overdue task away, nor closes it: only closing or moving the deadline does.
    await api.Task.markReviewed({ id: task });
    expect(await todo(owner.id)).toMatchObject([{ kind: 'review', deadline: { overdue: true } }]);
    await expect(waitingApi.Task.close({ id: task })).rejects.toMatchObject({ message: 'forbidden' });
    await expect(api.Task.close({ id: task })).rejects.toMatchObject({ message: 'plans_left' });

    await helperApi.Time.setLeft({ taskId: task, minutes: null });
    expect(await todo(helper.id)).toEqual([]);
    await api.Task.close({ id: task });
    expect(await todo(owner.id)).toEqual([]);
    // Closed late, at the deadline it missed: the deadline stays where it was.
    const [row] = await sql<{ late: boolean }[]>`
      SELECT confirmed_at > value AS late FROM finished_at WHERE task_id = ${task} AND expired_at IS NULL`;
    expect(row).toEqual({ late: true });
    expect(await todo(waiting.id)).toMatchObject([{ kind: 'review', task: { id: dependent }, done: [{ task: { id: task } }] }]);
    expect(await kinds(waiting.id)).toContain('dependency_done');
    expect((await kinds(owner.id)).filter((k) => k.startsWith('deadline'))).toEqual([]);

    // Taking note is "No intervention needed" of the waiting task; closing again tells nobody twice.
    await waitingApi.Task.markReviewed({ id: dependent });
    expect(await todo(waiting.id)).toEqual([]);
    await api.Task.close({ id: task });
    expect((await kinds(waiting.id)).filter((k) => k === 'dependency_done')).toHaveLength(1);
  });

  test('closing an open task sets the deadline to now: refused while plans are left; a moved deadline opens it again', async () => {
    const owner = await createEmployee();
    const waiting = await createEmployee();
    const task = await createTask(owner.id);
    const dependent = await createTask(waiting.id);
    const api = await client(owner.id);
    const waitingApi = await client(waiting.id);
    // A link joins two tasks its author sees (decision 94).
    await api.Observer.add({ taskId: task, employeeId: waiting.id });
    await waitingApi.Dependency.set({ taskId: dependent, value: task, latestAt: null });

    await api.Time.setLeft({ taskId: task, minutes: 30 });
    await expect(api.Task.close({ id: task })).rejects.toMatchObject({ message: 'plans_left' });
    expect(await sql`SELECT count(*)::int AS n FROM finished_at WHERE task_id = ${task}`).toEqual([{ n: 0 }]);

    await api.Time.setLeft({ taskId: task, minutes: null });
    await api.Task.close({ id: task });
    const overdue = async () => (await api.MyDay.todo()).filter((i) => i.kind === 'review' && i.deadline?.overdue);
    const done = async () => (await waitingApi.MyDay.todo()).filter((i) => i.kind === 'review' && i.done.length > 0);
    expect(await overdue()).toEqual([]);
    expect(await done()).toHaveLength(1);
    expect((await api.MyDay.current({ tab: 'closed', page: 1 })).items.filter((t) => t.id === task)).toMatchObject([{ closed: true }]);

    // A deadline put in the past by hand does not close a task: it is overdue.
    await api.Task.setDeadline({ id: task, deadline: new Date(Date.now() - 86_400_000) });
    expect(await overdue()).toHaveLength(1);
    expect(await done()).toEqual([]);

    // A year typed digit by digit passes through 0002: a slip, never a plan.
    await expect(api.Task.setDeadline({ id: task, deadline: new Date('0002-03-15T10:00:00Z') })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.Task.setDeadline({ id: task, deadline: new Date('2100-01-01T00:00:00Z') })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Moved ahead: open, not overdue.
    await api.Task.setDeadline({ id: task, deadline: new Date(Date.now() + 86_400_000 * 3) });
    expect(await overdue()).toEqual([]);
    expect((await api.MyDay.current({ tab: 'closed', page: 1 })).items.filter((t) => t.id === task)).toEqual([]);
  });

  test('an open mention stays until "Done" or "No reply needed"', async () => {
    const owner = await createEmployee();
    const helper = await createEmployee();
    const id = await createTask(owner.id);
    await (await client(owner.id)).Observer.add({ taskId: id, employeeId: helper.id });
    const commentId = await (await client(owner.id)).Comment.create(comment(id, '<p>Please look</p>', [helper.id]));

    const api = await client(helper.id);
    expect(await api.MyDay.todo()).toMatchObject([
      { kind: 'mention', task: { id }, commentId, authorId: owner.id, excerpt: 'Please look', replies: [] },
    ]);
    // A comment elsewhere in the task is not an answer.
    await api.Comment.create(comment(id, '<p>Something else</p>'));
    expect(await api.MyDay.todo()).toMatchObject([{ kind: 'mention', replies: [] }]);
    // Every reply to it shows inside the mention, oldest first.
    const first = await api.Comment.create({ ...comment(id, '<p>On it</p>'), replyToId: commentId });
    const second = await api.Comment.create({ ...comment(id, '<p>Done, see the file</p>'), replyToId: commentId });
    expect((await api.MyDay.todo())[0]).toMatchObject({ replies: [{ id: first, excerpt: 'On it' }, { id: second, excerpt: 'Done, see the file' }] });
    await api.Comment.closeMention({ taskId: id, commentId });
    expect(await api.MyDay.todo()).toEqual([]);
  });

  test('my task with comments by others until "No intervention needed"; requests first, answered apart', async () => {
    const owner = await createEmployee();
    const helper = await createEmployee();
    const stranger = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    expect(await api.MyDay.todo()).toEqual([]);

    await api.Observer.add({ taskId: id, employeeId: helper.id });
    await (await client(helper.id)).Comment.create(comment(id, '<p>One</p>'));
    await (await client(helper.id)).Comment.create(comment(id, '<p>Two</p>'));
    await (await client(stranger.id)).Observer.request({ taskId: id });

    const items = await api.MyDay.todo();
    expect(items).toMatchObject([
      { kind: 'request', task: { id }, employeeId: stranger.id },
      { kind: 'review', task: { id }, comments: { count: 2, authorIds: [helper.id] } },
    ]);
    expect((await api.Comment.unreviewed({ taskId: id })).map((c) => c.html)).toEqual(['<p>One</p>', '<p>Two</p>']);
    await expect((await client(helper.id)).Comment.unreviewed({ taskId: id })).rejects.toMatchObject({ message: 'forbidden' });

    // Only what was shown is taken away: a comment that came after it stays.
    await (await client(helper.id)).Comment.create(comment(id, '<p>Three</p>'));
    const shown = items.find((i) => i.kind === 'review');
    await api.Task.markReviewed({ id, until: shown?.kind === 'review' ? shown.at : undefined });
    // The request is a group of its own: the review does not wait for it, nor take it away.
    expect(await api.MyDay.todo()).toMatchObject([{ kind: 'request' }, { kind: 'review', comments: { count: 1 } }]);
    await api.Observer.reject({ taskId: id, employeeId: stranger.id });
    expect((await api.Comment.unreviewed({ taskId: id })).map((c) => c.html)).toEqual(['<p>Three</p>']);
    // Never back, never past now.
    await api.Task.markReviewed({ id, until: new Date(0) });
    expect(await api.MyDay.todo()).toMatchObject([{ kind: 'review', comments: { count: 1 } }]);
    await api.Task.markReviewed({ id, until: new Date(Date.now() + 86_400_000) });
    expect(await api.MyDay.todo()).toEqual([]);
    const [row] = await sql<{ future: boolean }[]>`SELECT reviewed_at > NOW() AS future FROM task WHERE id = ${id}`;
    expect(row).toEqual({ future: false });
  });

  test('a link someone else adds is in the review of both owners; a handover is the new owner\'s first notice', async () => {
    const owner = await createEmployee();
    const other = await createEmployee();
    const doer = await createEmployee();
    const heir = await createEmployee();
    const mine = await createTask(owner.id);
    const theirs = await createTask(other.id);
    await (await client(owner.id)).Observer.add({ taskId: mine, employeeId: doer.id });
    await (await client(other.id)).Observer.add({ taskId: theirs, employeeId: doer.id });

    await (await client(doer.id)).Dependency.set({ taskId: mine, value: theirs, latestAt: null });
    expect((await (await client(owner.id)).MyDay.todo())).toMatchObject([
      { kind: 'review', task: { id: mine }, links: [{ task: { id: theirs }, waits: true, by: doer.id }] },
    ]);
    expect((await (await client(other.id)).MyDay.todo())).toMatchObject([
      { kind: 'review', task: { id: theirs }, links: [{ task: { id: mine }, waits: false, by: doer.id }] },
    ]);
    expect(await (await client(doer.id)).MyDay.todo()).toEqual([]);

    // Handed over: until accepted, the new owner sees the handover alone — not what came before it,
    // nor after; an access request does not hold the acceptance up.
    await (await client(owner.id)).Task.transfer({ id: mine, ownerId: heir.id });
    await (await client(doer.id)).Comment.create(comment(mine, '<p>Welcome</p>'));
    const heirApi = await client(heir.id);
    const [handed] = await heirApi.MyDay.todo();
    expect(handed).toMatchObject({ kind: 'review', task: { id: mine }, handedAt: expect.any(Date), links: [], comments: null });
    await heirApi.Task.markReviewed({ id: mine });
    // Accepted: what came after the handover is the review now.
    expect(await heirApi.MyDay.todo()).toMatchObject([{ kind: 'review', handedAt: null, comments: { count: 1 } }]);
  });

  test('tasks by deadline, the overdue and nearest first, no deadline last; the same deadline, the newer first', async () => {
    const owner = await createEmployee();
    const helper = await createEmployee();
    const api = await client(owner.id);
    const later = await createTask(owner.id);
    const none = await createTask(owner.id);
    const soon = await createTask(owner.id);
    const sameA = await createTask(owner.id);
    const sameB = await createTask(owner.id);
    const at = new Date(Date.now() + 5 * 86_400_000);
    await api.Task.setDeadline({ id: later, deadline: new Date(Date.now() + 9 * 86_400_000) });
    await api.Task.setDeadline({ id: soon, deadline: new Date(Date.now() + 2 * 86_400_000) });
    await api.Task.setDeadline({ id: sameA, deadline: at });
    await api.Task.setDeadline({ id: sameB, deadline: at });
    for (const id of [later, none, soon, sameA, sameB]) {
      await api.Observer.add({ taskId: id, employeeId: helper.id });
      await (await client(helper.id)).Comment.create(comment(id, '<p>Hi</p>'));
    }
    expect((await api.MyDay.todo()).map((i) => i.task.id)).toEqual([soon, sameB, sameA, later, none]);
    expect((await api.MyDay.todo({ taskId: sameA })).map((i) => i.task.id)).toEqual([sameA]);
  });
});

describe('current tasks', () => {
  test('mine apart from the others; closed tasks leave; public tasks are everyone\'s', async () => {
    const boss = await createEmployee();
    const report = await createEmployee({ managerId: boss.id });
    const stranger = await createEmployee();
    const own = await createTask(boss.id);
    const theirs = await createTask(report.id);
    const closed = await createTask(boss.id);
    await (await client(boss.id)).Task.close({ id: closed });

    const api = await client(boss.id);
    const mine = await api.MyDay.current({ tab: 'mine', page: 1 });
    expect(mine.items.map((t) => t.id)).toContain(own);
    expect(mine.items.map((t) => t.id)).not.toContain(closed);
    expect(mine.items.map((t) => t.id)).not.toContain(theirs);
    expect((await api.MyDay.current({ tab: 'team', page: 1 })).items.map((t) => t.id)).toContain(theirs);
    expect((await api.MyDay.current({ tab: 'others', page: 1 })).items.map((t) => t.id)).not.toContain(theirs);

    const strangerApi = await client(stranger.id);
    expect((await strangerApi.MyDay.current({ tab: 'others', page: 1 })).items.map((t) => t.id)).not.toContain(own);
    await api.Task.makePublic({ id: own });
    expect((await strangerApi.MyDay.current({ tab: 'others', page: 1 })).items.map((t) => t.id)).toContain(own);
  });

  test('a task I plan time on is mine, one my people plan on is the team\'s, with the plan on the line', async () => {
    const boss = await createEmployee();
    const dev = await createEmployee({ managerId: boss.id });
    const owner = await createEmployee();
    const task = await createTask(owner.id);
    await (await client(owner.id)).Observer.add({ taskId: task, employeeId: dev.id });
    const devApi = await client(dev.id);
    expect((await devApi.MyDay.current({ tab: 'others', page: 1 })).items.map((t) => t.id)).toContain(task);

    await devApi.Time.setLeft({ taskId: task, minutes: 240 });
    const mine = await devApi.MyDay.current({ tab: 'mine', page: 1 });
    expect(mine.items.map((t) => t.id)).toEqual([task]);
    expect(mine.plans).toEqual([{ taskId: task, minutes: 240 }]);
    const team = await (await client(boss.id)).MyDay.current({ tab: 'team', page: 1 });
    expect(team.items.map((t) => t.id)).toEqual([task]);
    expect(team.plans).toEqual([{ taskId: task, minutes: 240 }]);

    // Everyone's time on the line, logged → left, for whoever sees the task; nothing for whoever does not.
    const ownerApi = await client(owner.id);
    await logTime(owner.id, task, await dayAgo(owner.id, 1), 30);
    expect((await devApi.MyDay.current({ tab: 'mine', page: 1 })).hours).toEqual([{ taskId: task, spentMinutes: 30, leftMinutes: 240 }]);
    const tagIds = (await ownerApi.Task.get({ id: task })).tags.map((tag) => tag.id);
    expect((await ownerApi.Task.search({ tagIds, tab: 'mine', page: 1 })).hours).toEqual([{ taskId: task, spentMinutes: 30, leftMinutes: 240 }]);
    expect((await (await client((await createEmployee()).id)).Task.search({ tagIds, tab: 'others', page: 1 })).hours).toEqual([]);

    // The plan cleared: back among the others.
    await devApi.Time.setLeft({ taskId: task, minutes: null });
    expect((await devApi.MyDay.current({ tab: 'mine', page: 1 })).items).toEqual([]);
  });

  test('my team: tasks my people own down the chain, apart from the others, in the search too', async () => {
    const boss = await createEmployee();
    const lead = await createEmployee({ managerId: boss.id });
    const dev = await createEmployee({ managerId: lead.id });
    const outsider = await createEmployee();
    const tag = `t-${randomUUID().slice(0, 8)}`;
    const api = await client(boss.id);
    const devTask = await (await client(dev.id)).Task.create({ tags: [tag, 'dev'] });
    const outsiderTask = await (await client(outsider.id)).Task.create({ tags: [tag, 'outsider'] });
    await (await client(outsider.id)).Task.makePublic({ id: outsiderTask });

    const team = await api.MyDay.current({ tab: 'team', page: 1 });
    expect(team.items.map((t) => t.id)).toEqual([devTask]);
    expect(team.counts).toMatchObject({ mine: 0, team: 1 });
    expect((await api.MyDay.current({ tab: 'others', page: 1 })).items.map((t) => t.id)).toContain(outsiderTask);

    const [tagRow] = await sql<{ id: number }[]>`SELECT id FROM tag WHERE name = ${tag}`;
    const found = await api.Task.search({ tagIds: [tagRow!.id], tab: 'team', page: 1 });
    expect(found.items.map((t) => t.id)).toEqual([devTask]);
    expect(found.counts).toEqual({ mine: 0, team: 1, others: 1, closed: 0 });
  });

  test('by deadline, nearest first; the same moment and no deadline — by priority, no deadline last', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const at = new Date(Date.now() + 86_400_000);
    const make = (priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL', deadline: Date | null) =>
      api.Task.create({ tags: [`o-${randomUUID().slice(0, 8)}`], priority, deadline });
    const later = await make('CRITICAL', new Date(at.getTime() + 60_000));
    const low = await make('LOW', at);
    const high = await make('HIGH', at);
    const none = await make('NORMAL', null);
    const noneCritical = await make('CRITICAL', null);
    const { items } = await api.MyDay.current({ tab: 'mine', page: 1 });
    expect(items.map((i) => i.id)).toEqual([high, low, later, noneCritical, none]);
  });
});

describe('history', () => {
  test('today is always there, with visits, time logged and the shift', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const empty = await api.MyDay.history({ page: 1 });
    expect(empty.days).toMatchObject([{ day: empty.today, shifts: [], entries: [], visits: [], firstActivity: null }]);
    expect(empty.total).toBe(1);

    const id = await createTask(me.id);
    await api.Visit.log({ taskId: null });
    await api.Visit.log({ taskId: id });
    // An hour ago, but not before today began in their time zone: the shift must be today's.
    const [midnight] = await sql<{ at: Date }[]>`
      SELECT local_today(id)::timestamp AT TIME ZONE time_zone AS at FROM employee WHERE id = ${me.id}
    `;
    const startedAt = new Date(Math.max(Date.now() - 3_600_000, midnight!.at.getTime()));
    await api.Work.start({ startedAt });
    await expect(api.Work.start({ startedAt: new Date() })).rejects.toMatchObject({ message: 'shift_overlap_open' });
    // Time goes into the shift (decision 100): an open one holds what has passed since it began.
    const shiftId = await shiftOn(me.id, empty.today);
    await api.Time.set({ taskId: id, shiftId, minutes: 1 });

    const [today] = (await api.MyDay.history({ page: 1 })).days;
    expect(today!.visits.map((v) => v.taskId)).toEqual([null, id]);
    expect(today!.entries).toMatchObject([{ taskId: id, shiftId, minutes: 1 }]);
    expect(today!.shifts).toMatchObject([{ spentMinutes: null }]);
    expect(today!.firstActivity).not.toBeNull();

    await api.Work.close({ startedAt, endedAt: new Date(), about: 'Done' });
    const [closed] = (await api.MyDay.history({ page: 1 })).days;
    expect(closed!.shifts).toMatchObject([{ about: 'Done' }]);
    expect(closed!.shifts[0]!.spentMinutes).toBe(Math.floor(Date.now() / 60_000) - Math.floor(startedAt.getTime() / 60_000));
    await expect(api.Work.remove({ startedAt: new Date(0) })).rejects.toMatchObject({ message: 'not_found' });

    // The shift is never shorter than the time in it; 0 removes the entry, then it may be deleted.
    await expect(api.Work.remove({ startedAt })).rejects.toMatchObject({ message: 'shift_has_entries' });
    await api.Time.set({ taskId: id, shiftId, minutes: 0 });
    expect((await api.MyDay.history({ page: 1 })).days[0]!.entries).toEqual([]);
    await api.Work.remove({ startedAt });
  });

  test('what was done, for the ribbon: comments and time logged, in order; My day asks for two days', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const id = await createTask(me.id);
    const { today } = await api.MyDay.history({ page: 1 });
    await api.Comment.create({ taskId: id, html: '<p>Started</p>', replyToId: null, files: [], mentionIds: [], taskIds: [] });
    await logTime(me.id, id, today, 1);
    const [day] = (await api.MyDay.history({ page: 1, size: 2 })).days;
    expect(day!.actions.map((a) => [a.kind, a.taskId])).toEqual([['comment', id], ['time', id]]);

    // A day logged earlier: two days fit, the third is on the next page.
    for (const back of [3, 5]) {
      await logTime(me.id, id, await dayAgo(me.id, back), 10);
    }
    const two = await api.MyDay.history({ page: 1, size: 2 });
    expect(two.days.map((d) => d.day)).toHaveLength(2);
    expect(two.total).toBe(3);
  });

  test('a shift just started closes as one minute: its end may be the end of the current minute', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    await api.Work.start({ startedAt: new Date() });
    const open = (await api.Work.open())!;
    // What the close dialog offers: now rounded up to the minute.
    const endedAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000);
    await api.Work.close({ startedAt: open.startedAt, endedAt, about: null });
    const [today] = (await api.MyDay.history({ page: 1 })).days;
    expect(today!.shifts[0]!.spentMinutes).toBe((endedAt.getTime() - open.startedAt.getTime()) / 60_000);

    // Past the current minute is the future.
    const other = await createEmployee();
    await expect(sql`
      INSERT INTO work (employee_id, started_at, spent_minutes)
      VALUES (${other.id}, date_trunc('minute', NOW()) - INTERVAL '10 minutes', 12)
    `).rejects.toMatchObject({ hint: 'shift_in_future' });
    await sql`
      INSERT INTO work (employee_id, started_at, spent_minutes)
      VALUES (${other.id}, date_trunc('minute', NOW()) - INTERVAL '10 minutes', 11)
    `;
  });

  test('started again in the minute it was closed, a shift goes on instead of overlapping', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    await api.Work.start({ startedAt: new Date() });
    const open = (await api.Work.open())!;
    const endedAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000);
    await api.Work.close({ startedAt: open.startedAt, endedAt, about: 'Done' });
    // Closing rounded the end up to the next minute: a new shift from now would overlap it.
    await api.Work.start({ startedAt: new Date() });
    const again = (await api.Work.open())!;
    const shifts = (await api.MyDay.history({ page: 1 })).days[0]!.shifts;
    if (again.startedAt.getTime() === open.startedAt.getTime()) {
      // The same minute: the closed shift is open again, with what was written about it.
      expect(shifts.map((s) => [s.spentMinutes, s.about])).toEqual([[null, 'Done']]);
    } else {
      // The minute had passed: a shift of its own, right after the closed one.
      expect(again.startedAt.getTime()).toBeGreaterThanOrEqual(endedAt.getTime());
      expect(shifts).toHaveLength(2);
    }
  });

  test('days without activity are skipped; earlier days are on further pages', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    // Ten past days with a confirmed shift each, every other day — at noon in UTC, the employee's
    // time zone: an hour counted back from now would cross midnight when run late in the evening.
    const noon = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 12 * 3_600_000;
    for (let i = 1; i <= 10; i++) {
      const startedAt = new Date(noon - i * 2 * 86_400_000);
      await api.Work.add({ startedAt, endedAt: new Date(startedAt.getTime() + 3_600_000), about: null });
    }
    const first = await api.MyDay.history({ page: 1 });
    expect(first.days).toHaveLength(7);
    expect(first.days[0]!.day).toBe(first.today);
    expect(first.total).toBe(11);
    const second = await api.MyDay.history({ page: 2 });
    expect(second.days).toHaveLength(4);
    expect(second.days[0]!.day < first.days[6]!.day).toBe(true);
    expect(second.days.every((d) => d.shifts.length === 1 && d.shifts[0]!.spentMinutes === 60)).toBe(true);
  });

  test('several shifts in one day; an open one after a closed one', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const hour = 3_600_000;
    // Yesterday in UTC, the employee's time zone: hours counted back from now could cross midnight.
    const midnight = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000);
    const at = (h: number) => new Date(midnight.getTime() + h * hour);
    await api.Work.add({ startedAt: at(8), endedAt: at(10), about: 'Morning' });
    await expect(api.Work.add({ startedAt: at(9), endedAt: at(11), about: null }))
      .rejects.toMatchObject({ message: 'shift_overlap_with' });
    expect(await api.Work.open()).toBeNull();
    await api.Work.start({ startedAt: at(20) });
    expect((await api.Work.open())?.startedAt.getTime()).toBe(at(20).getTime());

    const days = (await api.MyDay.history({ page: 1 })).days;
    // The open shift runs past midnight: it is in both days, the same shift (decision 100).
    const all = days.flatMap((d) => d.shifts);
    const shifts = [...new Map(all.map((s) => [s.id, s])).values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    expect(shifts.map((s) => s.spentMinutes)).toEqual([120, null]);
    expect(all.filter((s) => s.id === shifts[1]!.id)).toHaveLength(2);
    await api.Work.close({ startedAt: shifts[1]!.startedAt, endedAt: at(21), about: 'Evening' });
    expect(await api.Work.open()).toBeNull();
    const range = { employeeId: me.id, from: days[days.length - 1]!.day, to: days[0]!.day };
    expect((await api.Team.stats(range)).stats.workMinutes).toBe(180);
  });

  test('a shift may run past midnight, never longer than a day; an overlap names the shift in the way', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const hour = 3_600_000;
    // Two days ago in UTC, the employee's time zone: a shift past midnight must be over at any hour of today.
    const midnight = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 2 * 86_400_000);
    const at = (h: number, m = 0) => new Date(midnight.getTime() + h * hour + m * 60_000);

    await api.Work.add({ startedAt: at(10), endedAt: at(12, 30), about: null });
    // A shift around all of the day's shifts says which one is in the way, with its times.
    await expect(api.Work.add({ startedAt: at(8), endedAt: at(18), about: null }))
      .rejects.toMatchObject({ message: 'shift_overlap_with', cause: { params: { from: '10:00', to: '12:30' } } });
    // Past midnight is fine (decision 100): the shift is in both days, each with its share.
    await api.Work.add({ startedAt: at(20), endedAt: at(24), about: null });
    await api.Work.update({ startedAt: at(20), newStartedAt: at(20), endedAt: at(25), about: null });
    const days = (await api.MyDay.history({ page: 1 })).days;
    const evening = days.flatMap((d) => d.shifts.filter((s) => s.startedAt.getTime() === at(20).getTime()).map(() => d.day));
    expect(evening).toHaveLength(2);
    expect(days.find((d) => d.day === evening[0])!.workedMinutes + days.find((d) => d.day === evening[1])!.workedMinutes)
      .toBe(150 + 300);
    // Longer than a day is a slip, not work.
    await expect(api.Work.add({ startedAt: at(-72), endedAt: at(-48, 1), about: null }))
      .rejects.toMatchObject({ message: 'shift_too_long' });

    await api.Work.start({ startedAt: new Date(Date.now() - 60_000) });
    await expect(api.Work.start({ startedAt: new Date() })).rejects.toMatchObject({ message: 'shift_overlap_open' });
  });

  test('two shifts started at the same minute at once: a known error, not an internal one', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const startedAt = new Date(Date.now() - 3_600_000);
    const results = await Promise.allSettled([api.Work.start({ startedAt }), api.Work.start({ startedAt })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(['shift_overlap', 'shift_overlap_open']).toContain((failed as PromiseRejectedResult).reason.message);
  });

  test('a shift holds the time logged in it: all tasks of the shift together, the entry replaced counted once', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const first = await createTask(me.id);
    const second = await createTask(me.id);
    const shiftId = await shiftOn(me.id, '2026-01-02');
    await api.Time.set({ taskId: first, shiftId, minutes: 20 * 60 });
    // Replacing the same entry is not adding to it.
    await api.Time.set({ taskId: first, shiftId, minutes: 22 * 60 });
    await api.Time.set({ taskId: second, shiftId, minutes: 2 * 60 });
    await expect(api.Time.set({ taskId: second, shiftId, minutes: 2 * 60 + 1 }))
      .rejects.toMatchObject({ message: 'spent_over_shift', cause: { params: { logged: '22:00', left: '2:00' } } });
    // Nor can the shift shrink under it; another shift is a shift of its own; someone else's is not mine.
    const [w] = await sql<{ startedAt: Date }[]>`SELECT started_at FROM work WHERE id = ${shiftId}`;
    await expect(api.Work.update({ startedAt: w!.startedAt, newStartedAt: w!.startedAt, endedAt: new Date(w!.startedAt.getTime() + 23 * 3_600_000), about: null }))
      .rejects.toMatchObject({ message: 'shift_shorter_than_entries', cause: { params: { logged: '24:00' } } });
    await logTime(me.id, second, '2026-01-03', 24 * 60);
    await expect((await client((await createEmployee()).id)).Time.set({ taskId: first, shiftId, minutes: 1 })).rejects.toMatchObject({ message: 'not_found' });
  });

  test('one entry per task and shift: replaced, not added; 0 removes it; the last change is kept', async () => {
    const me = await createEmployee();
    const other = await createEmployee();
    const id = await createTask(me.id);
    const api = await client(me.id);
    const shiftId = await shiftOn(me.id, '2026-01-01');
    await api.Time.set({ taskId: id, shiftId, minutes: 10 });
    await sql`UPDATE spent_minutes SET updated_at = NOW() - INTERVAL '1 day' WHERE "by" = ${me.id}`;
    await api.Time.set({ taskId: id, shiftId, minutes: 40 });
    const rows = await sql<{ value: number; updatedAt: Date }[]>`SELECT value, updated_at FROM spent_minutes WHERE "by" = ${me.id}`;
    expect(rows.map((r) => r.value)).toEqual([40]);
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await api.Time.mine({ taskId: id })).entries).toMatchObject([{ shiftId, minutes: 40 }]);
    // Someone else's entry is never theirs to change: setting 0 touches only their own.
    await (await client(other.id)).Time.set({ taskId: id, shiftId, minutes: 0 }).catch(() => {});
    expect(await sql`SELECT 1 FROM spent_minutes WHERE "by" = ${me.id}`).toHaveLength(1);
    const elsewhere = await shiftOn(me.id, '2026-01-02');
    await expect(sql`UPDATE spent_minutes SET shift_id = ${elsewhere} WHERE "by" = ${me.id}`).rejects.toMatchObject({ hint: 'spent_immutable' });
    await api.Time.set({ taskId: id, shiftId, minutes: 0 });
    expect(await sql`SELECT 1 FROM spent_minutes WHERE "by" = ${me.id}`).toHaveLength(0);
  });
});
