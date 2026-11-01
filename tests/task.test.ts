import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sql } from '../server/pg.ts';
import env from '../server/env.ts';
import * as Attachments from '../server/services/Attachment.ts';
import { client, createEmployee, dayAgo, logTime, shiftOn } from './helpers.ts';

async function createTask(ownerId: number): Promise<number> {
  return (await client(ownerId)).Task.create({ tags: [`t-${randomUUID().slice(0, 8)}`, 'shared'] });
}

async function notifications(employeeId: number) {
  return (await sql<{ payload: { kind: string; by?: number; for?: number } }[]>`
    SELECT payload FROM notification WHERE employee_id = ${employeeId} ORDER BY id
  `).map((n) => n.payload);
}

const comment = (taskId: number, html: string, mentionIds: number[] = []) =>
  ({ taskId, html, replyToId: null, files: [], mentionIds, taskIds: [] });

describe('access', () => {
  test('a new task is private: the header is for everyone, the rest for observers', async () => {
    const boss = await createEmployee();
    const owner = await createEmployee({ managerId: boss.id });
    const stranger = await createEmployee();
    const id = await createTask(owner.id);

    const mine = await (await client(owner.id)).Task.get({ id });
    expect(mine).toMatchObject({ access: 'owner', isPublic: false, ownerId: owner.id });
    expect(mine.details).not.toBeNull();
    expect(await (await client(boss.id)).Task.get({ id })).toMatchObject({ access: 'observer' });

    const theirs = await (await client(stranger.id)).Task.get({ id });
    expect(theirs).toMatchObject({ access: 'none', details: null, priority: 'NORMAL' });
    expect(theirs.tags.map((t) => t.name)).toContain('shared');
    await expect((await client(stranger.id)).Comment.list({ taskId: id, filter: 'all', page: 1 }))
      .rejects.toMatchObject({ message: 'no_access' });
  });

  test('similar tasks: the most tags in common first, never the one with exactly this title', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const [a, b] = [`a-${randomUUID().slice(0, 8)}`, `b-${randomUUID().slice(0, 8)}`];
    const both = await api.Task.create({ tags: [a, b, `x-${randomUUID().slice(0, 8)}`] });
    const one = await api.Task.create({ tags: [a, `y-${randomUUID().slice(0, 8)}`] });
    await api.Task.create({ tags: [`z-${randomUUID().slice(0, 8)}`] });
    const exact = await api.Task.create({ tags: [a, b] });

    expect((await api.Task.similar({ tags: [a, b] })).map((task) => task.id)).toEqual([both, one]);
    expect((await api.Task.similar({ tags: [b] })).map((task) => task.id)).toEqual([exact, both]);
  });

  test('who knows the subject: shared tags over tasks, only tasks the caller sees, never the caller (decision 97)', async () => {
    const [me, pavel, ivan, olga] = [await createEmployee(), await createEmployee(), await createEmployee(), await createEmployee()];
    const [api, P, I, O] = [await client(me.id), await client(pavel.id), await client(ivan.id), await client(olga.id)];
    const [a, b] = [`a-${randomUUID().slice(0, 8)}`, `b-${randomUUID().slice(0, 8)}`];
    const both = await P.Task.create({ tags: [a, b, `x-${randomUUID().slice(0, 8)}`] });
    await P.Observer.add({ taskId: both, employeeId: ivan.id });
    await P.Observer.add({ taskId: both, employeeId: me.id });
    const one = await I.Task.create({ tags: [a, `y-${randomUUID().slice(0, 8)}`] });
    await I.Observer.add({ taskId: one, employeeId: me.id });
    // Olga's task is private and I am not in it: her work there does not show through.
    const hidden = await O.Task.create({ tags: [a, b, `z-${randomUUID().slice(0, 8)}`] });
    for (const [who, task] of [[pavel, both], [ivan, both], [ivan, one], [me, both], [olga, hidden]] as const) {
      await logTime(who.id, task, await dayAgo(who.id, 1), 60);
    }

    // Ivan: two tags on one task and one on another; Pavel: two on one.
    expect(await api.Task.experts({ tags: [a, b] })).toEqual([
      { employeeId: ivan.id, tasks: 2 },
      { employeeId: pavel.id, tasks: 1 },
    ]);
    expect(await O.Task.experts({ tags: [a, b] })).toEqual([]);
  });

  test('participants come in with the new task, each told who brought them', async () => {
    const owner = await createEmployee();
    const dev = await createEmployee();
    const stranger = await createEmployee();
    const id = await (await client(owner.id)).Task.create({ tags: [`t-${randomUUID().slice(0, 8)}`], participants: [dev.id, owner.id, dev.id] });

    expect(await (await client(dev.id)).Task.get({ id })).toMatchObject({ access: 'observer', ownerId: owner.id });
    expect(await notifications(dev.id)).toEqual([expect.objectContaining({ kind: 'access_opened', by: owner.id })]);
    expect(await (await client(stranger.id)).Task.get({ id })).toMatchObject({ access: 'none' });
  });

  test('any participant adds observers, like a copy in an email; only the owner hides them; both are notified', async () => {
    const owner = await createEmployee();
    const helper = await createEmployee();
    const other = await createEmployee();
    const stranger = await createEmployee();
    const id = await createTask(owner.id);

    await (await client(owner.id)).Observer.add({ taskId: id, employeeId: helper.id });
    await expect((await client(stranger.id)).Observer.add({ taskId: id, employeeId: other.id }))
      .rejects.toMatchObject({ message: 'forbidden' });
    await (await client(helper.id)).Observer.add({ taskId: id, employeeId: other.id });
    expect(await notifications(other.id)).toEqual([expect.objectContaining({ kind: 'access_opened', by: helper.id })]);
    await expect((await client(helper.id)).Observer.remove({ taskId: id, employeeId: other.id }))
      .rejects.toMatchObject({ message: 'forbidden' });
    await (await client(owner.id)).Observer.remove({ taskId: id, employeeId: other.id });
    await (await client(owner.id)).Observer.remove({ taskId: id, employeeId: helper.id });
    await (await client(owner.id)).Observer.add({ taskId: id, employeeId: helper.id });

    expect((await notifications(helper.id)).map((n) => n.kind)).toEqual(['access_opened', 'access_closed', 'access_opened']);
    await expect((await client(owner.id)).Observer.remove({ taskId: id, employeeId: owner.id }))
      .rejects.toMatchObject({ message: 'owner_cannot_leave' });

    const people = await (await client(helper.id)).Observer.list({ taskId: id, page: 1 });
    const helperRow = people.items.find((p) => p.employeeId === helper.id)!;
    expect(helperRow.periods).toHaveLength(2);
    expect(helperRow.periods[0]).toMatchObject({ addedBy: owner.id, removedBy: owner.id });
    expect(people.items.find((p) => p.employeeId === owner.id)?.lockedBy).toBe('owner');
  });

  test('a manager is locked by the observing report', async () => {
    const boss = await createEmployee();
    const dev = await createEmployee({ managerId: boss.id });
    const owner = await createEmployee();
    const id = await createTask(owner.id);
    await (await client(owner.id)).Observer.add({ taskId: id, employeeId: dev.id });

    const people = await (await client(owner.id)).Observer.list({ taskId: id, page: 1 });
    expect(people.items.find((p) => p.employeeId === boss.id)?.lockedBy).toBe(dev.id);
    await expect((await client(owner.id)).Observer.remove({ taskId: id, employeeId: boss.id }))
      .rejects.toMatchObject({ message: 'manager_cannot_leave' });
  });

  test('requests: withdraw, approve and reject; "no intervention needed" waits for them', async () => {
    const owner = await createEmployee();
    const asker = await createEmployee();
    const id = await createTask(owner.id);
    const askerApi = await client(asker.id);
    const ownerApi = await client(owner.id);

    await askerApi.Observer.request({ taskId: id });
    expect(await askerApi.Task.get({ id })).toMatchObject({ access: 'requested' });
    await askerApi.Observer.withdraw({ taskId: id });
    await askerApi.Observer.request({ taskId: id });
    // A request is answered apart: it does not hold the review up, and stays (decision 94).
    await ownerApi.Task.markReviewed({ id });
    expect((await ownerApi.Observer.list({ taskId: id, page: 1 })).requests).toEqual([{ employeeId: asker.id }]);

    await ownerApi.Observer.reject({ taskId: id, employeeId: asker.id });
    await askerApi.Observer.request({ taskId: id });
    await ownerApi.Observer.approve({ taskId: id, employeeId: asker.id });
    await ownerApi.Task.markReviewed({ id });

    expect((await notifications(asker.id)).map((n) => n.kind)).toEqual(['access_closed', 'access_opened']);
    expect(await askerApi.Task.get({ id })).toMatchObject({ access: 'observer' });
  });
});

describe('mentions', () => {
  test('a private task mentions only its participants; a public one anyone, adding nobody', async () => {
    const owner = await createEmployee();
    const colleague = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);

    // Who takes part is the owner's decision: a mention does not bring anyone in.
    await expect(api.Comment.create(comment(id, '<p>Help?</p>', [colleague.id])))
      .rejects.toMatchObject({ message: 'mention_not_participant' });
    expect(await (await client(colleague.id)).Task.get({ id })).toMatchObject({ access: 'none' });
    expect(await api.Observer.mentionable({ taskId: id })).toEqual({ everyone: false, ids: [owner.id], people: [owner.id] });
    await api.Observer.add({ taskId: id, employeeId: colleague.id });
    await api.Comment.create(comment(id, '<p>Help?</p>', [colleague.id]));
    expect((await api.Observer.mentionable({ taskId: id })).ids.sort()).toEqual([owner.id, colleague.id].sort());

    await api.Task.makePublic({ id });
    expect(await api.Observer.mentionable({ taskId: id })).toMatchObject({ everyone: true, ids: [] });
    const outsider = await createEmployee();
    await api.Comment.create(comment(id, '<p>You too</p>', [outsider.id]));
    expect(await (await client(outsider.id)).Task.get({ id })).toMatchObject({ access: 'public', isPublic: true });
    await expect(api.Comment.create(comment(id, '<p>me</p>', [owner.id]))).rejects.toMatchObject({ message: 'self_mention' });
  });

  test('replies live in the thread of the first comment; the feed marks each with a line in time', async () => {
    const owner = await createEmployee();
    const dev = await createEmployee();
    const other = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    await api.Task.makePublic({ id });
    const root = await api.Comment.create(comment(id, '<p>Who takes it?</p>', [dev.id]));
    // Someone else answers first: the mention stays open, it is not theirs.
    const byOther = await (await client(other.id)).Comment.create({ ...comment(id, '<p>Not me</p>'), replyToId: root });
    const byDev = await (await client(dev.id)).Comment.create({ ...comment(id, '<p>I do</p>'), replyToId: byOther });

    const all = await api.Comment.list({ taskId: id, filter: 'all', page: 1 });
    expect(all.items.map((i) => i.kind)).toEqual(['reply', 'reply', 'comment']);
    const thread = all.items[2]!;
    expect(thread.kind === 'comment' && thread.replies.map((r) => r.id)).toEqual([byOther, byDev]);
    expect(all.items[0]).toMatchObject({ kind: 'reply', commentId: byDev, authorId: dev.id, toAuthorId: other.id, excerpt: 'I do' });
    // A reply to a reply is not a reply to the mention.
    expect(thread.kind === 'comment' && thread.mentions[0]).toMatchObject({ employeeId: dev.id, replies: [] });

    // An open mention in a reply brings its whole thread under "open mentions".
    await (await client(dev.id)).Comment.create({ ...comment(id, '<p>Owner, ok?</p>', [owner.id]), replyToId: root });
    const open = await api.Comment.list({ taskId: id, filter: 'mentions', page: 1 });
    expect(open.items.map((i) => (i.kind === 'comment' ? i.id : i.kind))).toEqual([root]);
  });

  test('the mentioned employee closes the mention; the feed filters by open mentions', async () => {
    const owner = await createEmployee();
    const dev = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    await api.Comment.create(comment(id, '<p>Plain</p>'));
    await api.Observer.add({ taskId: id, employeeId: dev.id });
    const asked = await api.Comment.create(comment(id, '<p>Check this</p>', [dev.id]));
    await api.Task.setDeadline({ id, deadline: new Date(Date.now() + 86_400_000) });

    const open = await api.Comment.list({ taskId: id, filter: 'mentions', page: 1 });
    expect(open.items.map((i) => (i.kind === 'comment' ? i.id : 'event'))).toEqual([asked]);
    expect(open).toMatchObject({ openMentions: 1, all: 3 });
    expect((await api.Comment.list({ taskId: id, filter: 'all', page: 1 })).items.map((i) => i.kind))
      .toEqual(['deadline', 'comment', 'comment']);

    await expect(api.Comment.closeMention({ taskId: id, commentId: asked })).rejects.toMatchObject({ message: 'not_found' });
    const devApi = await client(dev.id);
    await devApi.Comment.create({ ...comment(id, '<p>Checked</p>'), replyToId: asked });
    const mention = (await devApi.Comment.list({ taskId: id, filter: 'mentions', page: 1 })).items[0];
    expect(mention?.kind === 'comment' && mention.mentions[0]).toMatchObject({ employeeId: dev.id, replies: [{ excerpt: expect.any(String) }] });
    await devApi.Comment.closeMention({ taskId: id, commentId: asked });
    expect((await api.Comment.list({ taskId: id, filter: 'mentions', page: 1 })).items).toEqual([]);
  });
});

describe('mentions closed, and their comment reviewed (decisions 95, 98)', () => {
  const waitingFor = async (api: Awaited<ReturnType<typeof client>>) =>
    (await api.MyDay.waiting()).flatMap((i) => (i.kind === 'mention' ? [i] : []));

  test('closed without a reply or answered, the comment waits for the author\'s "No intervention needed"', async () => {
    const owner = await createEmployee();
    const a = await createEmployee();
    const b = await createEmployee();
    const c = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    for (const e of [a, b, c]) await api.Observer.add({ taskId: id, employeeId: e.id });
    const asked = await api.Comment.create(comment(id, '<p>Plan changed</p>', [a.id, b.id, c.id]));

    await (await client(a.id)).Comment.closeMention({ taskId: id, commentId: asked });
    await (await client(b.id)).Comment.create({ ...comment(id, '<p>Seen</p>'), replyToId: asked });
    expect(await waitingFor(api)).toMatchObject([{
      commentId: asked,
      reviewedAt: null,
      quiet: 0,
      people: [
        { employeeId: a.id, closedAt: expect.any(Date), replies: [] },
        { employeeId: b.id, closedAt: null, replies: [{ excerpt: 'Seen' }] },
        { employeeId: c.id, closedAt: null, replies: [] },
      ],
    }]);
    await expect((await client(a.id)).Comment.reviewComment({ taskId: id, commentId: asked })).rejects.toMatchObject({ message: 'forbidden' });

    // Reviewed: gone, though C never answered; open mentions stay open with those mentioned.
    await api.Comment.reviewComment({ taskId: id, commentId: asked });
    expect(await waitingFor(api)).toEqual([]);
    expect(await (await client(b.id)).MyDay.todo()).toMatchObject([{ kind: 'mention', commentId: asked }]);
    expect(await (await client(c.id)).MyDay.todo()).toMatchObject([{ kind: 'mention', commentId: asked }]);

    // A later reaction brings it back with only who reacted, and how many never answered.
    await (await client(b.id)).Comment.closeMention({ taskId: id, commentId: asked });
    expect(await waitingFor(api)).toMatchObject([{ commentId: asked, quiet: 1, people: [{ employeeId: b.id }] }]);
    const [item] = (await api.Comment.list({ taskId: id, filter: 'all', page: 1 })).items.filter((i) => i.kind === 'comment' && i.id === asked);
    expect(item).toMatchObject({ reviewedAt: expect.any(Date) });
  });

  test('the review goes up to the newest reaction shown: a later one stays', async () => {
    const owner = await createEmployee();
    const dev = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    await api.Observer.add({ taskId: id, employeeId: dev.id });
    const asked = await api.Comment.create(comment(id, '<p>Can you?</p>', [dev.id]));
    await (await client(dev.id)).Comment.create({ ...comment(id, '<p>Tomorrow</p>'), replyToId: asked });
    const [shown] = await waitingFor(api);
    const until = shown!.people[0]!.replies[0]!.at;
    await new Promise((r) => setTimeout(r, 5));
    await (await client(dev.id)).Comment.closeMention({ taskId: id, commentId: asked });

    await api.Comment.reviewComment({ taskId: id, commentId: asked, until });
    expect(await waitingFor(api)).toMatchObject([{ commentId: asked, people: [{ employeeId: dev.id, closedAt: expect.any(Date) }] }]);
  });

  test('a comment stays a comment: only its reviewed_at changes', async () => {
    const owner = await createEmployee();
    const id = await createTask(owner.id);
    const said = await (await client(owner.id)).Comment.create(comment(id, '<p>Fixed</p>'));
    await expect(sql`UPDATE comment SET value = '<p>Changed</p>' WHERE task_id = ${id} AND id = ${said}`).rejects.toMatchObject({ hint: 'immutable_row' });
    await sql`UPDATE comment SET reviewed_at = NOW() WHERE task_id = ${id} AND id = ${said}`;
  });

  test('the author adds a mention later and takes it back until a reaction', async () => {
    const owner = await createEmployee();
    const dev = await createEmployee();
    const other = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    for (const e of [dev, other]) await api.Observer.add({ taskId: id, employeeId: e.id });
    const said = await api.Comment.create(comment(id, '<p>Release on Friday</p>'));

    await expect((await client(other.id)).Comment.addMention({ taskId: id, commentId: said, employeeId: dev.id }))
      .rejects.toMatchObject({ message: 'forbidden' });
    await api.Comment.addMention({ taskId: id, commentId: said, employeeId: dev.id });
    expect(await (await client(dev.id)).MyDay.todo()).toMatchObject([{ kind: 'mention', commentId: said }]);
    expect((await notifications(dev.id)).filter((n) => n.kind === 'mention')).toHaveLength(1);
    await api.Comment.removeMention({ taskId: id, commentId: said, employeeId: dev.id });
    expect(await (await client(dev.id)).MyDay.todo()).toEqual([]);

    // A reply made before the mention does not answer it; one after does, and it can no longer be taken back.
    await (await client(other.id)).Comment.create({ ...comment(id, '<p>Earlier</p>'), replyToId: said });
    await api.Comment.addMention({ taskId: id, commentId: said, employeeId: other.id });
    expect((await waitingFor(api))[0]?.people).toMatchObject([{ employeeId: other.id, replies: [] }]);
    await (await client(other.id)).Comment.create({ ...comment(id, '<p>Fine</p>'), replyToId: said });
    await expect(api.Comment.removeMention({ taskId: id, commentId: said, employeeId: other.id }))
      .rejects.toMatchObject({ message: 'mention_answered' });
  });

  test('"All participants" mentions the people of the task but the author, the exceptions and bots', async () => {
    const owner = await createEmployee();
    const a = await createEmployee();
    const b = await createEmployee();
    const c = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    for (const e of [a, b, c]) await api.Observer.add({ taskId: id, employeeId: e.id });
    const { id: botId } = await api.Bot.create({ fullName: 'CI', pronoun: null, about: null, permissions: ['comment'], webhookUrl: null });
    await api.Observer.add({ taskId: id, employeeId: botId });

    const all = await (await client(a.id)).Comment.create({ ...comment(id, '<p>Everyone: moved to Monday</p>'), everyone: true, exceptIds: [c.id] });
    const [item] = await waitingFor(await client(a.id));
    expect(item).toMatchObject({ commentId: all });
    expect(item!.people.map((p) => p.employeeId).sort()).toEqual([owner.id, b.id].sort());
  });

  test('a manager mentioned in the same comment gets no copy for a report away', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee({ managerId: lead.id });
    const owner = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    await api.Observer.add({ taskId: id, employeeId: dev.id });
    await sql`UPDATE human SET next_day = CURRENT_DATE + 7 WHERE employee_id = ${dev.id}`;

    await api.Comment.create(comment(id, '<p>Both of you</p>', [dev.id, lead.id]));
    expect((await notifications(lead.id)).filter((n) => n.kind === 'mention')).toEqual([expect.not.objectContaining({ for: dev.id })]);
    await api.Comment.create(comment(id, '<p>Only you</p>', [dev.id]));
    expect((await notifications(lead.id)).filter((n) => n.kind === 'mention' && n.for === dev.id)).toHaveLength(1);
  });
});

describe('public tasks', () => {
  test('public: everyone comments and logs time; private again keeps owner and open mentions', async () => {
    const owner = await createEmployee();
    const mentioned = await createEmployee();
    const commenter = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    await api.Time.setLeft({ taskId: id, minutes: 60 });

    await api.Task.makePublic({ id });
    expect(await api.Time.mine({ taskId: id })).toMatchObject({ leftMinutes: 60 });
    await (await client(commenter.id)).Comment.create(comment(id, '<p>Count me in</p>'));
    await logTime(commenter.id, id, '2026-01-05', 30);
    await api.Comment.create(comment(id, '<p>Bring the keys</p>', [mentioned.id]));
    await expect(api.Observer.add({ taskId: id, employeeId: commenter.id })).rejects.toMatchObject({ message: 'task_public' });

    const people = await api.Observer.list({ taskId: id, page: 1 });
    expect(people.items.find((p) => p.employeeId === commenter.id)).toMatchObject({ spentMinutes: 30, periods: [] });

    expect(await api.Task.makePrivate({ id })).toEqual([commenter.id]);
    expect(await (await client(mentioned.id)).Task.get({ id })).toMatchObject({ access: 'observer' });
    expect(await (await client(commenter.id)).Task.get({ id })).toMatchObject({ access: 'none' });
    expect((await notifications(commenter.id)).at(-1)).toEqual({ kind: 'access_closed', by: owner.id });
    await expect((await client(commenter.id)).Time.set({ taskId: id, shiftId: await shiftOn(commenter.id, '2026-01-05'), minutes: 30 }))
      .rejects.toMatchObject({ message: 'no_access' });
  });
});

describe('rich text and attachments', () => {
  test('comments are sanitized; images must be our own readable attachments', async () => {
    const owner = await createEmployee();
    const other = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);

    const imageId = await Attachments.upload(owner.id, Buffer.from(`png-${randomUUID()}`), 'image/png');
    await api.Comment.create(comment(id,
      `<p onclick="x()">Hi <script>alert(1)</script><img src="/api/attachments/${imageId}"><img src="https://evil.test/p.png"></p>`));
    const [first] = (await api.Comment.list({ taskId: id, filter: 'all', page: 1 })).items;
    expect(first).toMatchObject({ kind: 'comment', html: `<p>Hi <img src="/api/attachments/${imageId}" /></p>` });

    // Someone who never uploaded these bytes and does not see the task cannot reuse the id.
    const otherTask = await createTask(other.id);
    await expect((await client(other.id)).Comment.create(comment(otherTask, `<p><img src="/api/attachments/${imageId}"></p>`)))
      .rejects.toMatchObject({ message: 'unknown_attachment' });
    await expect(Attachments.read(other.id, imageId)).rejects.toMatchObject({ code: 'unknown_attachment' });

    // The same bytes uploaded by them: the same row, now readable for them too.
    const [bytes] = await sql<{ value: Buffer }[]>`SELECT value FROM attachment WHERE id = ${imageId}`;
    expect(await Attachments.upload(other.id, bytes!.value, 'image/png')).toBe(imageId);
    expect((await Attachments.read(other.id, imageId)).mime).toBe('image/png');

    await expect(api.Comment.create(comment(id, '<p>  </p>'))).rejects.toMatchObject({ message: 'invalid_data' });
  });

  test('files: a size limit, a quota; kept while someone holds it; the last to let go deletes it; the same bytes bring it back', async () => {
    const me = await createEmployee();
    const other = await createEmployee();
    const stranger = await createEmployee();
    const id = await createTask(me.id);
    const api = await client(me.id);
    const otherApi = await client(other.id);
    await api.Observer.add({ taskId: id, employeeId: other.id });
    const saved = { max: env.FILE_MAX_MB, quota: env.FILE_QUOTA_MB };
    env.FILE_MAX_MB = 2 / 1024; // 2 KB
    env.FILE_QUOTA_MB = 3 / 1024; // 3 KB
    try {
      const kb = (n: number) => Buffer.from(`${randomUUID()}`.padEnd(n * 1024, 'x'));
      await expect(Attachments.upload(me.id, kb(3), 'text/plain')).rejects.toMatchObject({ code: 'file_too_big', params: { maxMb: 2 / 1024 } });
      const firstBytes = kb(2);
      const first = await Attachments.upload(me.id, firstBytes, 'text/plain');
      await expect(Attachments.upload(me.id, kb(2), 'text/plain')).rejects.toMatchObject({ code: 'file_quota' });
      // The same bytes again take no more space.
      expect(await Attachments.upload(me.id, firstBytes, 'text/plain')).toBe(first);

      await api.Comment.create({ ...comment(id, '<p>the report</p>'), files: [{ id: first, name: 'report.txt' }] });
      expect((await api.Attachment.mine()).files).toMatchObject([{ id: first, held: true, holders: 1, names: ['report.txt'], taskIds: [id] }]);

      // Someone who sees it keeps it: in their quota, theirs whoever lets it go; a stranger cannot.
      await expect((await client(stranger.id)).Attachment.keep({ id: first })).rejects.toMatchObject({ message: 'unknown_attachment' });
      let [c] = (await otherApi.Comment.list({ taskId: id, filter: 'all', page: 1 })).items;
      expect(c).toMatchObject({ files: [{ id: first, kept: false }] });
      await otherApi.Attachment.keep({ id: first });
      [c] = (await otherApi.Comment.list({ taskId: id, filter: 'all', page: 1 })).items;
      expect(c).toMatchObject({ files: [{ id: first, kept: true }] });
      expect((await otherApi.Attachment.mine()).usedBytes).toBe(firstBytes.length);

      // I let it go: my quota is free, the file stays for them.
      await api.Attachment.release({ id: first });
      expect((await api.Attachment.mine()).usedBytes).toBe(0);
      expect((await api.Attachment.mine()).files).toMatchObject([{ id: first, held: false, holders: 1, purgedAt: null }]);
      expect((await Attachments.read(me.id, first)).value).toEqual(firstBytes);
      await expect(api.Attachment.release({ id: first })).rejects.toMatchObject({ message: 'not_found' });

      // The last one lets it go: the content goes, the comment keeps the link and says so.
      await otherApi.Attachment.release({ id: first });
      await expect(Attachments.read(me.id, first)).rejects.toMatchObject({ code: 'file_purged' });
      [c] = (await api.Comment.list({ taskId: id, filter: 'all', page: 1 })).items;
      expect(c).toMatchObject({ files: [{ id: first, uploadedBy: [me.id], purgedAt: expect.any(Date) }] });
      await expect(otherApi.Attachment.keep({ id: first })).rejects.toMatchObject({ message: 'file_purged' });

      // Anyone with the bytes brings it back in place: every link works again.
      expect(await Attachments.upload(other.id, firstBytes, 'text/plain')).toBe(first);
      expect((await Attachments.read(me.id, first)).value).toEqual(firstBytes);
    } finally {
      env.FILE_MAX_MB = saved.max;
      env.FILE_QUOTA_MB = saved.quota;
    }
  });

  test('the context keeps its images out of the cleanup', async () => {
    const owner = await createEmployee();
    const id = await createTask(owner.id);
    const imageId = await Attachments.upload(owner.id, Buffer.from(`ctx-${randomUUID()}`), 'image/png');
    await (await client(owner.id)).Task.update({ id, context: `<p>Plan</p><img src="/api/attachments/${imageId}">` });
    const [row] = await sql<{ inUse: boolean }[]>`SELECT attachment_in_use(${imageId}) AS in_use`;
    expect(row!.inUse).toBe(true);
    await expect((await client(owner.id)).Task.update({ id, context: '<p>x</p>', priority: 'HIGH' })).resolves.toBeUndefined();
    expect(await (await client(owner.id)).Task.get({ id })).toMatchObject({ priority: 'HIGH', details: { context: '<p>x</p>' } });
  });
});

describe('search', () => {
  test('tags find any task, mine apart from the others', async () => {
    const owner = await createEmployee();
    const stranger = await createEmployee();
    const tag = `s-${randomUUID().slice(0, 8)}`;
    const id = await (await client(owner.id)).Task.create({ tags: [tag] });
    const tagId = (await (await client(stranger.id)).Tags.suggest({ text: tag })).tags[0]!.id;

    const byTag = await (await client(stranger.id)).Task.search({ tagIds: [tagId], tab: 'others', page: 1 });
    expect(byTag).toMatchObject({ items: [{ id, canSee: false }], counts: { mine: 0, others: 1 } });
    expect((await (await client(owner.id)).Task.search({ tagIds: [tagId], tab: 'mine', page: 1 })).items)
      .toMatchObject([{ id, canSee: true }]);
    await expect((await client(stranger.id)).Task.create({ tags: [tag] })).rejects.toMatchObject({ message: 'tag_set_taken' });
  });

});

describe('observer list', () => {
  test('one line per person after public and private again; periods and the reason are kept', async () => {
    const boss = await createEmployee();
    const owner = await createEmployee({ managerId: boss.id });
    const helper = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    await api.Observer.add({ taskId: id, employeeId: helper.id });
    await (await client(owner.id)).Comment.create(comment(id, '<p>Look</p>', [helper.id]));

    await api.Task.makePublic({ id });
    await api.Task.makePrivate({ id });

    const people = await api.Observer.list({ taskId: id, page: 1 });
    const ids = people.items.map((p) => p.employeeId);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(people.total).toBe(3);
    const helperRow = people.items.find((p) => p.employeeId === helper.id)!;
    expect(helperRow).toMatchObject({ active: true, openMention: true, lockedBy: null });
    expect(helperRow.periods).toHaveLength(2);
    expect(people.items.find((p) => p.employeeId === boss.id)).toMatchObject({ lockedBy: owner.id, openMention: false });
  });
});

describe('feed events', () => {
  test('mentions in other tasks, time logged and planned are events of "all"', async () => {
    const owner = await createEmployee();
    const id = await createTask(owner.id);
    const other = await createTask(owner.id);
    const api = await client(owner.id);

    await api.Comment.create({ ...comment(other, '<p>See this</p>'), taskIds: [id] });
    await logTime(owner.id, id, '2026-01-02', 30);
    await api.Time.setLeft({ taskId: id, minutes: 120 });
    await api.Time.setLeft({ taskId: id, minutes: 60 });
    await api.Time.setLeft({ taskId: id, minutes: null });

    const feed = await api.Comment.list({ taskId: id, filter: 'all', page: 1 });
    expect(feed.all).toBe(5);
    expect(feed.items.map((i) => i.kind).sort()).toEqual(['mentioned_in', 'plan', 'plan', 'plan', 'spent']);
    expect(feed.items.find((i) => i.kind === 'mentioned_in')).toMatchObject({ task: { id: other } });
    expect(feed.items.filter((i) => i.kind === 'plan').map((i) => i.kind === 'plan' && i.minutes).sort()).toEqual([120, 60, null].sort());
    expect(feed.items.find((i) => i.kind === 'spent')).toMatchObject({ employeeId: owner.id, minutes: 30, entries: [{ day: '2026-01-02', minutes: 30 }] });
    expect((await api.Comment.list({ taskId: id, filter: 'mentions', page: 1 })).total).toBe(0);
  });
});

describe('deadline changes settle', () => {
  const day = (n: number) => new Date(Date.UTC(2030, 0, n, 12));
  const rows = async (id: number) => (await sql<{ value: Date; expired: boolean }[]>`
    SELECT value, expired_at IS NOT NULL AS expired FROM finished_at WHERE task_id = ${id} ORDER BY entered_at, expired_at NULLS LAST
  `).map((r) => [r.value.toISOString().slice(0, 10), r.expired ? 'old' : 'now']);
  // A minute and more goes by: the last change has settled.
  const later = (id: number) => Promise.all([
    sql`UPDATE finished_at SET entered_at = entered_at - INTERVAL '2 minutes', expired_at = expired_at - INTERVAL '2 minutes' WHERE task_id = ${id}`,
    sql`UPDATE notification SET added_at = added_at - INTERVAL '2 minutes' WHERE sent_at IS NULL AND payload->>'dependencyId' = ${String(id)}`,
  ]);

  test('a change within a minute replaces the last one in the history; changed back, nothing happened', async () => {
    const owner = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);
    const deadlines = async () => (await api.Comment.list({ taskId: id, filter: 'all', page: 1 })).items
      .flatMap((i) => (i.kind === 'deadline' ? [[i.from?.toISOString().slice(0, 10) ?? null, i.to?.toISOString().slice(0, 10) ?? null]] : []));

    // Picking a date: only the last pick stays, as one move from no deadline.
    await api.Task.setDeadline({ id, deadline: day(1) });
    await api.Task.setDeadline({ id, deadline: day(2) });
    expect(await rows(id)).toEqual([['2030-01-02', 'now']]);
    expect(await deadlines()).toEqual([[null, '2030-01-02']]);

    // Later, a move — and back again within the minute: as if never moved.
    await later(id);
    await api.Task.setDeadline({ id, deadline: day(3) });
    expect(await rows(id)).toEqual([['2030-01-02', 'old'], ['2030-01-03', 'now']]);
    await api.Task.setDeadline({ id, deadline: day(2) });
    expect(await rows(id)).toEqual([['2030-01-02', 'now']]);

    // A clear and a new date soon after: one move.
    await api.Task.setDeadline({ id, deadline: null });
    await api.Task.setDeadline({ id, deadline: day(4) });
    expect(await rows(id)).toEqual([['2030-01-02', 'old'], ['2030-01-04', 'now']]);
    // The same value again is no change at all.
    await later(id);
    await api.Task.setDeadline({ id, deadline: day(4) });
    expect(await rows(id)).toEqual([['2030-01-02', 'old'], ['2030-01-04', 'now']]);
    // A clear right after a move: the clear of what was before it.
    await later(id);
    await api.Task.setDeadline({ id, deadline: day(5) });
    await api.Task.setDeadline({ id, deadline: null });
    expect(await rows(id)).toEqual([['2030-01-02', 'old'], ['2030-01-04', 'old']]);
    expect(await deadlines()).toEqual([['2030-01-04', null], ['2030-01-02', '2030-01-04'], [null, '2030-01-02']]);
  });

  test('a dependent task\'s owner is told once, about the deadline that settled', async () => {
    const owner = await createEmployee();
    const other = await createEmployee();
    const id = await createTask(owner.id);
    const base = await createTask(other.id);
    const otherApi = await client(other.id);
    await otherApi.Observer.add({ taskId: base, employeeId: owner.id });
    await (await client(owner.id)).Dependency.set({ taskId: id, value: base, latestAt: day(2) });
    const told = async () => (await notifications(owner.id)).filter((n) => n.kind === 'finished_at_change');

    await otherApi.Task.setDeadline({ id: base, deadline: day(1) });
    await otherApi.Task.setDeadline({ id: base, deadline: day(3) });
    expect(await told()).toEqual([{ kind: 'finished_at_change', dependencyId: base, late: true }]);

    // Settled, then moved and moved back: nothing more to tell.
    await later(base);
    await otherApi.Task.setDeadline({ id: base, deadline: day(1) });
    await otherApi.Task.setDeadline({ id: base, deadline: day(3) });
    expect(await told()).toHaveLength(1);
  });
});

describe('dependencies', () => {
  test('they are set with or without a latest deadline; cycles are refused; a broken latest deadline is a risk, not an error', async () => {
    const owner = await createEmployee();
    const other = await createEmployee();
    const stranger = await createEmployee();
    const id = await createTask(owner.id);
    const base = await createTask(other.id);
    const api = await client(owner.id);
    const otherApi = await client(other.id);
    const day = (n: number) => new Date(Date.now() + n * 86_400_000);

    await expect((await client(stranger.id)).Dependency.set({ taskId: id, value: base, latestAt: null }))
      .rejects.toMatchObject({ message: 'no_access' });
    // A link joins two tasks its author sees, the same from either side (decision 94).
    await expect(api.Dependency.set({ taskId: id, value: base, latestAt: null })).rejects.toMatchObject({ message: 'no_access' });
    await otherApi.Observer.add({ taskId: base, employeeId: owner.id });
    await api.Dependency.set({ taskId: id, value: base, latestAt: null });
    expect((await api.Task.get({ id })).details?.waitsFor).toMatchObject([{ id: base, latestAt: null, late: [], delays: [] }]);
    expect(await notifications(other.id)).toContainEqual(expect.objectContaining({ kind: 'dependency_added', by: owner.id, hard: false }));

    await api.Observer.add({ taskId: id, employeeId: other.id });
    await expect(otherApi.Dependency.set({ taskId: base, value: id, latestAt: null }))
      .rejects.toMatchObject({ message: 'dependency_cycle' });
    await expect(api.Dependency.set({ taskId: id, value: id, latestAt: null })).rejects.toMatchObject({ message: 'dependency_cycle' });

    // I need theirs by tomorrow; they have no deadline: both at risk, nothing refused.
    await api.Dependency.set({ taskId: id, value: base, latestAt: day(1) });
    expect(await api.Task.get({ id })).toMatchObject({ late: [base], delays: [] });
    expect(await api.Task.get({ id: base })).toMatchObject({ late: [], delays: [id] });

    // In time: no risk. Moved past it: allowed, both at risk again, and I am told it is late.
    await otherApi.Task.setDeadline({ id: base, deadline: new Date(Date.now() + 86_400_000 / 2) });
    expect(await api.Task.get({ id })).toMatchObject({ late: [], delays: [] });
    await otherApi.Task.setDeadline({ id: base, deadline: day(3) });
    expect(await api.Task.get({ id })).toMatchObject({ late: [base] });
    expect((await notifications(owner.id)).at(-1)).toEqual({ kind: 'finished_at_change', dependencyId: base, late: true });
    const [risk] = await sql<{ value: boolean }[]>`SELECT at_risk(${base}) AS value`;
    expect(risk!.value).toBe(true);

    // Due in time but overdue past the latest deadline: still late, as it is not closed (decision 93); closed, not any more.
    await otherApi.Task.setDeadline({ id: base, deadline: new Date(Date.now() + 86_400_000 / 2) });
    await sql`UPDATE dependency SET latest_at = NOW() - INTERVAL '1 hour' WHERE task_id = ${id}`;
    await sql`UPDATE finished_at SET value = NOW() - INTERVAL '2 hours' WHERE task_id = ${base} AND expired_at IS NULL`;
    expect(await api.Task.get({ id })).toMatchObject({ late: [base] });
    await otherApi.Task.close({ id: base });
    expect(await api.Task.get({ id })).toMatchObject({ late: [] });

    await api.Dependency.remove({ taskId: id, value: base });
    expect((await api.Task.get({ id })).details?.waitsFor).toEqual([]);
    await expect(api.Dependency.remove({ taskId: id, value: base })).rejects.toMatchObject({ message: 'not_found' });
  });
});

describe('creating with details', () => {
  test('priority, deadline, context and a dependency either way come with the task', async () => {
    const me = await createEmployee();
    const other = await createEmployee();
    const api = await client(me.id);
    const theirs = await createTask(other.id);
    const mine = await createTask(me.id);
    const deadline = new Date(Date.now() + 86_400_000);
    await (await client(other.id)).Observer.add({ taskId: theirs, employeeId: me.id });

    const id = await api.Task.create({
      tags: [`n-${randomUUID().slice(0, 8)}`], priority: 'HIGH', deadline, context: '<p>why</p>', waitsFor: theirs,
    });
    const task = await api.Task.get({ id });
    expect(task).toMatchObject({ priority: 'HIGH', deadline });
    expect(task.details?.context).toBe('<p>why</p>');
    expect(task.details?.waitsFor.map((d) => d.id)).toEqual([theirs]);
    expect((await notifications(other.id)).map((n) => n.kind)).toContain('dependency_added');

    const blocker = await api.Task.create({ tags: [`n-${randomUUID().slice(0, 8)}`], waitedOnBy: mine });
    expect((await api.Task.get({ id: mine })).details?.waitsFor.map((d) => d.id)).toEqual([blocker]);
  });

  test("a task one does not see cannot be made to wait; nothing is created then", async () => {
    const me = await createEmployee();
    const theirs = await createTask((await createEmployee()).id);
    const tag = `n-${randomUUID().slice(0, 8)}`;
    await expect((await client(me.id)).Task.create({ tags: [tag], waitedOnBy: theirs })).rejects.toMatchObject({ message: 'no_access' });
    expect(await sql`SELECT 1 FROM tag WHERE name = ${tag}`).toHaveLength(0);
  });

  test('a participant links what the task waits for: its owner is told and sees it done; the latest deadline stays the owner\'s', async () => {
    const owner = await createEmployee();
    const doer = await createEmployee();
    const other = await createEmployee();
    const task = await createTask(owner.id);
    const theirs = await createTask(other.id);
    await (await client(owner.id)).Observer.add({ taskId: task, employeeId: doer.id });
    await (await client(other.id)).Observer.add({ taskId: theirs, employeeId: doer.id });
    const api = await client(doer.id);

    const part = await api.Task.create({ tags: [`n-${randomUUID().slice(0, 8)}`], waitedOnBy: task });
    expect(await api.Task.get({ id: part })).toMatchObject({ ownerId: doer.id });
    expect((await api.Task.get({ id: task })).details?.waitsFor).toMatchObject([{ id: part, addedBy: doer.id }]);
    expect(await notifications(owner.id)).toContainEqual(expect.objectContaining({ kind: 'waits_added', by: doer.id, dependencyId: part }));

    // An existing task too, someone else's: both owners are told; a latest deadline is not the participant's to set.
    await expect(api.Dependency.set({ taskId: task, value: theirs, latestAt: new Date() })).rejects.toMatchObject({ message: 'forbidden' });
    await api.Dependency.set({ taskId: task, value: theirs, latestAt: null });
    expect(await notifications(other.id)).toContainEqual(expect.objectContaining({ kind: 'dependency_added', by: doer.id, dependentId: task }));
    await (await client(owner.id)).Dependency.set({ taskId: task, value: theirs, latestAt: new Date(Date.now() + 86_400_000) });
    // Linked already: nothing for the participant to change, the owner's latest deadline stays.
    await api.Dependency.set({ taskId: task, value: theirs, latestAt: null });
    expect((await api.Task.get({ id: task })).details?.waitsFor.find((d) => d.id === theirs)?.latestAt).not.toBeNull();
    // Removed by whoever added it or the owner of the waiting task; nobody else.
    await expect((await client(other.id)).Dependency.remove({ taskId: task, value: theirs })).rejects.toMatchObject({ message: 'forbidden' });
    await api.Dependency.remove({ taskId: task, value: theirs });

    // Done by its owner: the owner of the waiting task sees it.
    await api.Task.close({ id: part });
    expect((await (await client(owner.id)).MyDay.todo()).filter((i) => i.kind === 'review'))
      .toMatchObject([{ task: { id: task }, done: [{ task: { id: part } }] }]);
  });
});

describe('deadline at risk', () => {
  test("a plan that does not fit the person's working time before the deadline marks the task", async () => {
    const owner = await createEmployee();
    const dev = await createEmployee();
    const api = await client(owner.id);
    const id = await createTask(owner.id);
    await api.Observer.add({ taskId: id, employeeId: dev.id });
    await api.Task.setDeadline({ id, deadline: new Date(Date.now() + 2 * 86_400_000) });
    expect((await api.Task.get({ id })).risk).toBeNull(); // nobody planned it

    // No timesheet: a 40-hour week, so two days give about 11.4 hours.
    await (await client(dev.id)).Time.setLeft({ taskId: id, minutes: 5 * 60 });
    expect((await api.Task.get({ id })).risk).toBeNull();
    await (await client(dev.id)).Time.setLeft({ taskId: id, minutes: 20 * 60 });
    const { risk } = await api.Task.get({ id });
    expect(risk).toMatchObject({ employeeId: dev.id, plannedMinutes: 20 * 60 });
    expect(risk!.capacityMinutes).toBeGreaterThan(11 * 60);
    expect(risk!.capacityMinutes).toBeLessThan(12 * 60);

    const { from, to } = { from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) };
    await sql`UPDATE employee SET manager_id = ${owner.id} WHERE id = ${dev.id}`;
    const me = (await api.Team.summary({ from, to })).find((m) => m.self)!;
    expect(me.atRisk).toBe(1);
  });
});

describe('reminders', () => {
  test('for oneself, in the future; delivered once due, then waits in TODO until removed or put off; leaving the task drops them', async () => {
    const owner = await createEmployee();
    const helper = await createEmployee();
    const stranger = await createEmployee();
    const id = await createTask(owner.id);
    await (await client(owner.id)).Observer.add({ taskId: id, employeeId: helper.id });
    const api = await client(helper.id);
    const later = new Date(Date.now() + 3_600_000);

    await expect(api.Remind.add({ taskId: id, at: new Date(Date.now() - 1000), text: null })).rejects.toMatchObject({ message: 'remind_in_past' });
    await expect((await client(stranger.id)).Remind.add({ taskId: id, at: later, text: null })).rejects.toMatchObject({ message: 'no_access' });
    await api.Remind.add({ taskId: id, at: later, text: 'Check the build' });
    await api.Remind.add({ taskId: id, at: new Date(Date.now() + 7_200_000), text: null });
    expect(await api.Remind.list({ taskId: id })).toMatchObject([{ at: later, text: 'Check the build', due: false }, { text: null }]);
    expect(await (await client(owner.id)).Remind.list({ taskId: id })).toEqual([]);

    // Due: the worker's job sends it once, and it waits in TODO.
    await sql`UPDATE remind SET at = date_trunc('second', NOW()) - INTERVAL '1 second' WHERE employee_id = ${helper.id} AND value = 'Check the build'`;
    await sql`SELECT send_due_reminds()`;
    await sql`SELECT send_due_reminds()`;
    expect((await notifications(helper.id)).filter((n) => n.kind === 'remind')).toEqual([expect.objectContaining({ text: 'Check the build' })]);
    const [due] = await api.Remind.list({ taskId: id });
    expect(due).toMatchObject({ text: 'Check the build', due: true });
    expect((await api.MyDay.todo()).filter((i) => i.kind === 'remind')).toMatchObject([{ task: { id }, at: due!.at, text: 'Check the build' }]);

    // Put off: not due till then, out of TODO; it keeps its text.
    await expect(api.Remind.move({ taskId: id, at: due!.at, to: new Date(Date.now() - 1000) })).rejects.toMatchObject({ message: 'remind_in_past' });
    const tomorrow = new Date(Date.now() + 86_400_000);
    await api.Remind.move({ taskId: id, at: due!.at, to: tomorrow });
    expect(await api.Remind.list({ taskId: id })).toMatchObject([{ due: false }, { at: tomorrow, text: 'Check the build', due: false }]);
    expect((await api.MyDay.todo()).filter((i) => i.kind === 'remind')).toEqual([]);

    // Due again, then removed: gone from TODO.
    await sql`UPDATE remind SET at = date_trunc('second', NOW()) - INTERVAL '1 second' WHERE employee_id = ${helper.id} AND value = 'Check the build'`;
    await sql`SELECT send_due_reminds()`;
    const [again] = (await api.MyDay.todo()).filter((i) => i.kind === 'remind');
    await api.Remind.remove({ taskId: id, at: again!.at });
    expect((await api.MyDay.todo()).filter((i) => i.kind === 'remind')).toEqual([]);

    await api.Observer.leave({ taskId: id });
    expect((await sql`SELECT 1 FROM remind WHERE employee_id = ${helper.id}`).length).toBe(0);
  });
});

describe('time in the feed', () => {
  test("one person's entries in a row are one event; anything between them splits it", async () => {
    const owner = await createEmployee();
    const helper = await createEmployee();
    const id = await createTask(owner.id);
    await (await client(owner.id)).Observer.add({ taskId: id, employeeId: helper.id });
    const mine = await client(owner.id);
    const theirs = await client(helper.id);

    // Oldest first: mine ×3, a comment, mine ×1, theirs ×2, mine ×1.
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) await logTime(owner.id, id, day, 60);
    await mine.Comment.create(comment(id, '<p>Between</p>'));
    await logTime(owner.id, id, '2026-01-04', 30);
    await logTime(helper.id, id, '2026-01-04', 20);
    await logTime(helper.id, id, '2026-01-05', 25);
    await logTime(owner.id, id, '2026-01-05', 15);

    const feed = await mine.Comment.list({ taskId: id, filter: 'all', page: 1 });
    const shape = feed.items.map((i) => (i.kind === 'spent' ? [i.employeeId, i.minutes, i.entries.length] : i.kind));
    expect(shape).toEqual([
      [owner.id, 15, 1],
      [helper.id, 45, 2],
      [owner.id, 30, 1],
      'comment',
      [owner.id, 180, 3],
    ]);
    expect(feed.all).toBe(5);
    const run = feed.items[4]!;
    expect(run.kind === 'spent' && run.entries.map((e) => e.day)).toEqual(['2026-01-03', '2026-01-02', '2026-01-01']);
  });

  test('a plan says what its hours are for; it goes with the plan and stays in the history', async () => {
    const owner = await createEmployee();
    const id = await createTask(owner.id);
    const api = await client(owner.id);

    await api.Time.setLeft({ taskId: id, minutes: 180, about: '  the export and its tests  ' });
    expect(await api.Time.mine({ taskId: id })).toMatchObject({ leftMinutes: 180, leftAbout: 'the export and its tests' });
    // Only minutes: not said, rather than empty.
    await api.Time.setLeft({ taskId: id, minutes: 60, about: '   ' });
    expect(await api.Time.mine({ taskId: id })).toMatchObject({ leftMinutes: 60, leftAbout: null });

    const plans = (await api.Comment.list({ taskId: id, filter: 'all', page: 1 })).items
      .flatMap((i) => (i.kind === 'plan' ? [[i.minutes, i.about]] : []));
    expect(plans).toEqual([[60, null], [180, 'the export and its tests']]);
    await expect(api.Time.setLeft({ taskId: id, minutes: 60, about: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('titles', () => {
  test('a taken title is told by its tags before saving; a name no tag has means free', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const a = `t-${randomUUID().slice(0, 8)}`;
    const b = `t-${randomUUID().slice(0, 8)}`;
    const id = await api.Task.create({ tags: [a, b] });
    expect(await api.Task.byTags({ tags: [b, a] })).toEqual({ id });
    expect(await api.Task.byTags({ tags: [a] })).toBeNull();
    expect(await api.Task.byTags({ tags: [a, b, `${b} новое`] })).toBeNull();
    await expect(api.Task.create({ tags: [b, a] })).rejects.toMatchObject({ message: 'tag_set_taken' });
  });

  test('closed tasks have a tab of their own, the most recently closed first — in the search too', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const tag = `c-${randomUUID().slice(0, 8)}`;
    const first = await api.Task.create({ tags: [tag, 'a'] });
    const second = await api.Task.create({ tags: [tag, 'b'] });
    const open = await api.Task.create({ tags: [tag, 'c'] });
    // Closed by their owner an hour apart; a passed deadline alone is not closed (decision 93).
    await sql`SELECT set_finished_at(${first}, NOW() - INTERVAL '2 hours')`;
    await sql`SELECT set_finished_at(${second}, NOW() - INTERVAL '3 hours')`;
    await sql`UPDATE finished_at SET confirmed_at = NOW() - INTERVAL '2 hours' WHERE task_id = ${first}`;
    await sql`UPDATE finished_at SET confirmed_at = NOW() - INTERVAL '1 hour' WHERE task_id = ${second}`;

    // Other tests leave public tasks behind: only mine are looked at.
    const ours = (items: { id: number }[]) => items.map((i) => i.id).filter((id) => [first, second, open].includes(id));
    expect(ours((await api.MyDay.current({ tab: 'closed', page: 1 })).items)).toEqual([second, first]);
    expect((await api.MyDay.current({ tab: 'mine', page: 1 })).items.map((i) => i.id)).toEqual([open]);

    const [tagId] = (await sql<{ id: number }[]>`SELECT id FROM tag WHERE name = ${tag}`).map((r) => r.id);
    const found = await api.Task.search({ tagIds: [tagId!], tab: 'closed', page: 1 });
    expect(found.items.map((i) => i.id)).toEqual([second, first]);
    expect(found.counts).toEqual({ mine: 1, team: 0, others: 0, closed: 2 });
  });
});

describe('preview', () => {
  test('the hint over a task: its context and each one\'s time, only for someone who sees it', async () => {
    const me = await createEmployee();
    const dev = await createEmployee({ managerId: me.id });
    const stranger = await createEmployee();
    const devApi = await client(dev.id);
    const id = await devApi.Task.create({ tags: [`p-${randomUUID().slice(0, 8)}`], context: '<p>Сверить акт</p>' });
    await logTime(dev.id, id, await dayAgo(dev.id, 1), 45);
    await devApi.Time.setLeft({ taskId: id, minutes: 60 });

    expect(await (await client(me.id)).Task.preview({ id })).toEqual({
      visible: true, context: '<p>Сверить акт</p>', people: [{ employeeId: dev.id, spentMinutes: 45, leftMinutes: 60 }],
    });
    expect(await (await client(stranger.id)).Task.preview({ id })).toEqual({ visible: false, context: null, people: [] });
  });
});
