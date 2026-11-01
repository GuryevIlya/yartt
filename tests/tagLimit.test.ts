import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sql } from '../server/pg.ts';
import { client, createEmployee, dayAgo, logTime } from './helpers.ts';

// Limits of hours on tag combinations (decision 69).
describe('tag limits', () => {
  test('count the hours of who set it and everyone under them, with plans; seen up and down the chain; a change is a new version', async () => {
    const lead = await createEmployee();
    const dev = await createEmployee({ managerId: lead.id });
    const stranger = await createEmployee();
    const leadApi = await client(lead.id);
    const devApi = await client(dev.id);
    const strangerApi = await client(stranger.id);
    const rubric = `lim-${randomUUID().slice(0, 8)}`;
    const both = await devApi.Task.create({ tags: [rubric, `a ${randomUUID().slice(0, 6)}`] });
    const other = await strangerApi.Task.create({ tags: [rubric, `b ${randomUUID().slice(0, 6)}`] });
    const today = (await devApi.MyDay.history({ page: 1 })).today;
    // Logged yesterday, in a shift (decision 100): the limit runs from yesterday to today.
    const yesterday = await dayAgo(dev.id, 1);
    await logTime(dev.id, both, yesterday, 120);
    await devApi.Time.setLeft({ taskId: both, minutes: 60 });
    await logTime(stranger.id, other, await dayAgo(stranger.id, 1), 500); // not one of the lead's people
    const [tag] = await sql<{ id: number }[]>`SELECT id FROM tag WHERE name = ${rubric}`;

    const id = await leadApi.TagLimit.set({ replaces: null, tagIds: [tag!.id], startsOn: yesterday, endsOn: today, minutes: 150 });
    const [mine] = (await leadApi.TagLimit.list()).current;
    expect(mine).toMatchObject({
      // The pace: 120 minutes in 28 days, for the one day left — of the plan, 4 minutes fit.
      id, employeeId: lead.id, minutes: 150, spentMinutes: 120, leftMinutes: 60, aheadMinutes: 4, forecastMinutes: 124,
      days: [yesterday, today], cumulative: [120, 120], changed: false,
    });
    // The dev sees the lead's limit — it counts their hours; a stranger does not.
    expect((await devApi.TagLimit.list()).current.map((l) => l.id)).toEqual([id]);
    expect((await strangerApi.TagLimit.list()).current).toEqual([]);
    expect((await devApi.TagLimit.forTask({ taskId: both })).map((l) => l.id)).toEqual([id]);
    await expect(devApi.TagLimit.remove({ id })).rejects.toMatchObject({ message: 'forbidden' });

    // A change is a new version, the old one closed and kept; never edited in place.
    const next = await leadApi.TagLimit.set({ replaces: id, tagIds: [tag!.id], startsOn: today, endsOn: today, minutes: 300 });
    expect((await leadApi.TagLimit.list()).current).toMatchObject([{ id: next, minutes: 300, changed: true }]);
    expect((await leadApi.TagLimit.history({ id: next })).map((v) => [v.id, v.minutes, v.expiredAt === null]))
      .toEqual([[next, 300, true], [id, 150, false]]);
    await expect(leadApi.TagLimit.set({ replaces: id, tagIds: [tag!.id], startsOn: today, endsOn: today, minutes: 1 }))
      .rejects.toMatchObject({ message: 'not_found' });
    await expect(sql`UPDATE tag_limit SET minutes = 1 WHERE id = ${next}`).rejects.toMatchObject({ hint: 'forbidden' });
    await expect(sql`DELETE FROM tag_limit WHERE id = ${id}`).rejects.toMatchObject({ hint: 'forbidden' });

    await leadApi.TagLimit.remove({ id: next });
    expect(await leadApi.TagLimit.list()).toMatchObject({ current: [], removed: [{ id: next, minutes: 300 }] });
  });

  test('the forecast counts of the plans what fits in the period at the pace of the last 28 days', async () => {
    const lead = await createEmployee();
    const api = await client(lead.id);
    const plus = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const tagOf = async (name: string) => (await sql<{ id: number }[]>`SELECT id FROM tag WHERE name = ${name}`)[0]!.id;
    const today = (await api.MyDay.history({ page: 1 })).today;
    const paced = `pace-${randomUUID().slice(0, 8)}`;
    const fresh = `fresh-${randomUUID().slice(0, 8)}`;
    const task = await api.Task.create({ tags: [paced] });
    await logTime(lead.id, task, plus(today, -10), 280); // 10 minutes a day
    await api.Time.setLeft({ taskId: task, minutes: 6000 });
    const other = await api.Task.create({ tags: [fresh] });
    await api.Time.setLeft({ taskId: other, minutes: 6000 });

    // Ten days from today at 10 a day: 100 of the 6000 planned fit; logged before the period is not in it.
    await api.TagLimit.set({ replaces: null, tagIds: [await tagOf(paced)], startsOn: today, endsOn: plus(today, 9), minutes: 600 });
    // Nothing logged in 28 days: no pace to go by, all the plans count.
    await api.TagLimit.set({ replaces: null, tagIds: [await tagOf(fresh)], startsOn: today, endsOn: plus(today, 9), minutes: 600 });
    const byTag = new Map((await api.TagLimit.list()).current.map((l) => [l.tags[0]!.name, l]));
    expect(byTag.get(paced)).toMatchObject({ spentMinutes: 0, leftMinutes: 6000, aheadMinutes: 100, forecastMinutes: 100 });
    expect(byTag.get(fresh)).toMatchObject({ spentMinutes: 0, leftMinutes: 6000, aheadMinutes: null, forecastMinutes: 6000 });

    // A plan smaller than the pace counts in full: the work ends with it.
    await api.Time.setLeft({ taskId: task, minutes: 30 });
    expect((await api.TagLimit.forTask({ taskId: task }))[0]).toMatchObject({ aheadMinutes: 100, forecastMinutes: 30 });
  });
});
