import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sql } from '../server/pg.ts';
import * as Attachments from '../server/services/Attachment.ts';
import { client, createEmployee, shiftOn } from './helpers.ts';

// The access matrix: everyone in a different relation to a private task,
// against every query that shows what is inside a task. Each must answer
// exactly as can_see() in db.sql does, so a new query that forgets the
// check, or a check that drifts from the rule, fails here. The header
// (tags, owner, deadline) is for everyone and is not part of it.

type Person = { id: number; email: string };

/** What each query shows this person of the task: true — its inside. */
async function shown(person: Person, taskId: number, fileId: number): Promise<Record<string, boolean>> {
  const api = await client(person.id);
  const refused = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return false;
    } catch (error) {
      if ((error as { message?: string; code?: string }).message === 'no_access'
        || (error as { code?: string }).code === 'unknown_attachment') return true;
      throw error;
    }
  };
  const page = await api.Task.get({ id: taskId });
  const preview = await api.Task.preview({ id: taskId });
  const [tag] = await sql<{ id: number }[]>`SELECT tag_ids[1] AS id FROM task WHERE id = ${taskId}`;
  const found = (await api.Task.search({ tagIds: [tag!.id], tab: 'all', page: 1 })).items.find((t) => t.id === taskId);
  return {
    'Task.get details': page.details !== null,
    'Task.preview': preview.visible && preview.context !== null && preview.people.length > 0,
    'Task.search canSee': found?.canSee === true,
    'Comment.list': !(await refused(() => api.Comment.list({ taskId, filter: 'all', page: 1 }))),
    'Observer.list': !(await refused(() => api.Observer.list({ taskId, page: 1 }))),
    'Observer.mentionable': !(await refused(() => api.Observer.mentionable({ taskId }))),
    'Attachment.read': !(await refused(() => Attachments.read(person.id, fileId))),
  };
}

async function sees(person: Person, taskId: number): Promise<boolean> {
  const [row] = await sql<{ sees: boolean }[]>`SELECT can_see(${taskId}, ${person.id}) AS sees`;
  return row!.sees;
}

describe('access matrix', () => {
  test('every query shows the inside of a task exactly to those can_see() lets in', async () => {
    const top = await createEmployee();
    const boss = await createEmployee({ managerId: top.id });
    const owner = await createEmployee({ managerId: boss.id });
    const pm = await createEmployee({ managerId: top.id });
    const participant = await createEmployee({ managerId: pm.id });
    const former = await createEmployee();
    const requester = await createEmployee();
    const outsider = await createEmployee();
    const peer = await createEmployee({ managerId: boss.id });
    const people = { top, boss, owner, pm, participant, former, requester, outsider, peer };

    const ownerApi = await client(owner.id);
    const taskId = await ownerApi.Task.create({ tags: [`matrix-${randomUUID().slice(0, 8)}`], context: '<p>Salaries for next year</p>' });
    await ownerApi.Observer.add({ taskId, employeeId: participant.id });
    await ownerApi.Observer.add({ taskId, employeeId: former.id });
    await ownerApi.Observer.remove({ taskId, employeeId: former.id });
    await (await client(requester.id)).Observer.request({ taskId });
    const fileId = await Attachments.upload(owner.id, Buffer.from(`matrix-${randomUUID()}`), 'text/plain');
    await ownerApi.Comment.create({ taskId, html: '<p>The numbers</p>', replyToId: null, files: [{ id: fileId, name: 'numbers.txt' }], mentionIds: [], taskIds: [] });
    await ownerApi.Time.set({ taskId, shiftId: await shiftOn(owner.id, (await sql<{ d: string }[]>`SELECT local_today(${owner.id})::text AS d`)[0]!.d), minutes: 30 });

    const expected = { top: true, boss: true, owner: true, pm: true, participant: true, former: false, requester: false, outsider: false, peer: false };
    for (const [name, person] of Object.entries(people)) {
      expect(await sees(person, taskId), `can_see for ${name}`).toBe(expected[name as keyof typeof expected]);
    }

    const check = async () => {
      for (const [name, person] of Object.entries(people)) {
        const rule = await sees(person, taskId);
        const answers = await shown(person, taskId, fileId);
        for (const [query, inside] of Object.entries(answers)) expect(inside, `${query} for ${name}`).toBe(rule);
      }
    };
    await check();

    // Made public: everyone sees it, and every query says so.
    await ownerApi.Task.makePublic({ id: taskId });
    expect(await sees(outsider, taskId)).toBe(true);
    await check();
  });
});
