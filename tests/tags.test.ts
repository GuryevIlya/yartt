import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sql } from '../server/pg.ts';
import { KEYBOARD_KEYS, KEYBOARDS, retype } from '../shared/keyboards.ts';
import { client, createEmployee, dayAgo, logTime } from './helpers.ts';

async function tag(name: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO tag (name) VALUES (${name}) RETURNING id`;
  return row!.id;
}

/** A tag as the API returns it to someone without a color for it. */
async function newTag(name: string): Promise<{ id: number; name: string; color: null }> {
  return { id: await tag(name), name, color: null };
}

async function ordered(employeeId: number, tagIds: number[]): Promise<number[]> {
  const [row] = await sql<{ ids: number[] }[]>`SELECT ordered_tags(${employeeId}, ${tagIds}) AS ids`;
  return row!.ids;
}

describe('task title order', () => {
  test('by weight, then by how many of my tasks carry the tag, then by id', async () => {
    const me = await createEmployee();
    const suffix = `-${me.id}`;
    const [a, b, c] = [await tag('a' + suffix), await tag('b' + suffix), await tag('c' + suffix)];
    // My tasks: a in 1, b in 3, c in 2.
    for (const tags of [[a, b, c], [b], [b, c]]) {
      await sql`INSERT INTO task (owner_id, tag_ids) VALUES (${me.id}, ${tags})`;
    }

    expect(await ordered(me.id, [a!, b!, c!])).toEqual([b, c, a]);

    await sql`INSERT INTO user_tag (employee_id, tag_id, weight) VALUES (${me.id}, ${a!}, 5)`;
    expect(await ordered(me.id, [a!, b!, c!])).toEqual([a, b, c]);

    await sql`INSERT INTO user_tag (employee_id, tag_id, weight) VALUES (${me.id}, ${c!}, 5)`;
    expect(await ordered(me.id, [a!, b!, c!])).toEqual([c, a, b]);

    // Another employee sees the same tags in their own order.
    const other = await createEmployee();
    expect(await ordered(other.id, [c!, b!, a!])).toEqual([a, b, c]);
  });
});

describe('visits', () => {
  test('logged at most once per 10 minutes per task or "My day"', async () => {
    const me = await createEmployee();
    const [t] = await sql<{ id: number }[]>`INSERT INTO tag (name) VALUES (${'visit-' + me.id}) RETURNING id`;
    const [task] = await sql<{ id: number }[]>`INSERT INTO task (owner_id, tag_ids) VALUES (${me.id}, ${[t!.id]}) RETURNING id`;
    const api = await client(me.id);

    await api.Visit.log({ taskId: null });
    await api.Visit.log({ taskId: null });
    await api.Visit.log({ taskId: task!.id });
    const count = async () =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visit WHERE employee_id = ${me.id}`)[0]!.n;
    expect(await count()).toBe(2);

    await sql`UPDATE visit SET at = at - INTERVAL '11 minutes' WHERE employee_id = ${me.id}`;
    await api.Visit.log({ taskId: null });
    expect(await count()).toBe(3);

    await expect(api.Visit.log({ taskId: 999_999 })).rejects.toMatchObject({ message: 'not_found' });
  });
});

describe('my tags', () => {
  test('the tags of tasks I see, with counts; my color and weight change only my view', async () => {
    const me = await createEmployee();
    const other = await createEmployee();
    const unique = `mt-${me.id}`;
    const api = await client(me.id);
    const a = await api.Task.create({ tags: [unique, `${unique}-x`] });
    await api.Task.create({ tags: [unique, `${unique}-y`] });
    await (await client(other.id)).Task.create({ tags: [unique, `${unique}-hidden`] });

    const list = await api.Tags.mine({ query: unique, page: 1 });
    expect(list.items.map((t) => t.name)).not.toContain(`${unique}-hidden`);
    const tag = list.items.find((t) => t.name === unique)!;
    expect(tag).toMatchObject({ tasks: 2, open: 2, color: null, weight: 0 });

    const x = list.items.find((t) => t.name === `${unique}-x`)!;
    await api.Tags.set({ tagId: x.id, color: '#ff8800', weight: 5 });
    const task = await api.Task.get({ id: a });
    expect(task.tags[0]).toMatchObject({ id: x.id, name: `${unique}-x`, color: '#ff8800' });
    expect((await api.Tags.mine({ query: unique, page: 1 })).items[0]).toMatchObject({ id: x.id, weight: 5 });
    expect((await (await client(other.id)).Task.get({ id: a })).tags.find((t) => t.id === x.id)?.color).toBeNull();

    await api.Tags.set({ tagId: x.id, color: null, weight: 0 });
    expect((await sql`SELECT 1 FROM user_tag WHERE employee_id = ${me.id}`).length).toBe(0);
  });
});

describe('suggestions', () => {
  test('tags are lower case: the API lowers them, the database refuses capitals', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const id = await api.Task.create({ tags: [`  Склад  Б-${me.id} `] });
    expect((await api.Task.get({ id })).tags.map((t) => t.name)).toEqual([`склад б-${me.id}`]);
    await expect(sql`INSERT INTO tag (name) VALUES (${`Склад-${me.id}`})`).rejects.toMatchObject({ constraint_name: 'chk_tag_name' });
  });

  test('typos, transliteration and the other keyboard layout find the tag', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const name = `инвентаризация-${me.id}`;
    const { id } = await newTag(name);
    const [swapped] = retype(name, ['ru', 'en']);
    for (const text of [`инвентризация-${me.id}`, `inventarizatsiya-${me.id}`, swapped!, 'инвентар']) {
      const found = await api.Tags.suggest({ text });
      expect(found.tags.map((t) => t.id), text).toContain(id);
      expect(found.exact).toBe(false);
    }
    expect((await api.Tags.suggest({ text: name.toUpperCase() })).exact).toBe(true);
  });

  test('a text is read as existing tags, the words around them as new ones', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const stock = await newTag(`склад-${me.id}`);
    const audit = await newTag(`инвентаризация-${me.id}`);

    const tail = await api.Tags.suggest({ text: `склад-${me.id} инвентризация-${me.id} перенос стеллажей` });
    expect(tail.variants[0]).toEqual([{ tag: stock }, { tag: audit }, { name: 'перенос стеллажей' }]);

    const between = await api.Tags.suggest({ text: `Склад-${me.id} срочно инвентаризация-${me.id}` });
    expect(between.variants[0]).toEqual([{ tag: stock }, { name: 'срочно' }, { tag: audit }]);

    expect((await api.Tags.suggest({ text: `склад-${me.id}` })).variants).toEqual([]);
  });

  test('the layouts are the person\'s: "б" and "ж" typed as "," and ";" stay inside words', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const budget = await newTag(`бюджет-${me.id}`);
    const office = await newTag(`офис-${me.id}`);
    const text = retype(`бюджет-${me.id} офис-${me.id}`, ['ru', 'en'])[0]!;
    expect(text).toBe(`,.l;tn-${me.id} jabc-${me.id}`);
    expect((await api.Tags.suggest({ text })).variants[0]).toEqual([{ tag: budget }, { tag: office }]);

    // Someone who types only in English gets no reading in another layout.
    await api.Employee.updateSettings({ keyboards: ['en'] });
    expect((await api.Tags.suggest({ text: `jabc-${me.id}` })).tags.map((t) => t.id)).not.toContain(office.id);
    await api.Employee.updateSettings({ keyboards: ['uk', 'en'] });
    expect((await api.Tags.suggest({ text: `jabc-${me.id}` })).tags.map((t) => t.id)).toContain(office.id);
  });

  test('the layouts in the database are the ones the application has keys for', async () => {
    const [row] = await sql<{ values: string[] }[]>`SELECT enum_range(NULL::keyboard)::text[] AS values`;
    expect(row!.values).toEqual([...KEYBOARDS]);
    expect(Object.keys(KEYBOARD_KEYS)).toEqual([...KEYBOARDS]);
    for (const keys of Object.values(KEYBOARD_KEYS)) expect([...keys]).toHaveLength(47);
  });
});

describe('phrases and rubrics', () => {
  test('the tags that go together are offered: rubrics, never a phrase of one task', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    const rubric = `r-${randomUUID().slice(0, 8)}`;
    const often = `o-${randomUUID().slice(0, 8)}`;
    const phrase = `подписать акт ${randomUUID().slice(0, 8)}`;
    const id = await api.Task.create({ tags: [rubric, often, phrase] });
    await api.Task.create({ tags: [rubric, often, `другое ${randomUUID().slice(0, 8)}`] });

    const page = await api.Task.get({ id });
    expect(page.tags.map((tag) => tag.name).sort()).toEqual([rubric, often, phrase].sort());

    const rubricId = page.tags.find((tag) => tag.name === rubric)!.id;
    expect((await api.Tags.related({ tagIds: [rubricId] })).map((tag) => tag.name)).toEqual([often]);
    // Nothing picked: the rubrics of my own tasks, not their phrases, not someone else's.
    expect((await api.Tags.related({ tagIds: [] })).map((tag) => tag.name).sort()).toEqual([rubric, often].sort());
    expect(await (await client((await createEmployee()).id)).Tags.related({ tagIds: [] })).toEqual([]);
  });
});

describe('tag summary', () => {
  test('per tag, on the tasks I see, over a range; picked tags add all of them together and any of them', async () => {
    const me = await createEmployee();
    const dev = await createEmployee({ managerId: me.id });
    const api = await client(me.id);
    const devApi = await client(dev.id);
    const a = `sa-${randomUUID().slice(0, 8)}`;
    const b = `sb-${randomUUID().slice(0, 8)}`;
    const both = await devApi.Task.create({ tags: [a, b, `phrase ${randomUUID().slice(0, 6)}`] });
    const onlyA = await devApi.Task.create({ tags: [a, `phrase ${randomUUID().slice(0, 6)}`] });
    const hidden = await (await client((await createEmployee()).id)).Task.create({ tags: [a, `phrase ${randomUUID().slice(0, 6)}`] });
    const today = (await devApi.MyDay.history({ page: 1 })).today;
    // Logged yesterday, in a shift (decision 100): the period starts yesterday.
    const yesterday = await dayAgo(dev.id, 1);
    await logTime(dev.id, both, yesterday, 90);
    await devApi.Comment.create({ taskId: onlyA, html: '<p>Done</p>', replyToId: null, files: [], mentionIds: [], taskIds: [] });
    await devApi.Task.close({ id: onlyA });
    expect(hidden).toBeGreaterThan(0);

    const ids = (await sql<{ id: number }[]>`SELECT id FROM tag WHERE name IN (${a}, ${b}) ORDER BY name`).map((r) => r.id);
    const summary = await api.Tags.stats({ since: yesterday, tagIds: ids, page: 1 });
    const line = (kind: string, name?: string) => summary.rows.find((r) => r.group.kind === kind && (!name || r.tags[0]!.name === name))!;
    // The hidden task of a stranger is not counted: only what I see (dev's tasks, through the manager chain).
    // The dev logged 90 minutes under a (and under b): the line's hours are everyone's together.
    expect(line('tag', a)).toMatchObject({
      open: 1, stale: 0, finished: 1, late: 0, active: 2, comments: 1, discussed: 1, minutes: 90, leftMinutes: 0, people: 1, planners: 0, lastDay: today,
    });
    expect(line('tag', b)).toMatchObject({ open: 1, finished: 0, active: 1, comments: 0, discussed: 0, minutes: 90, people: 1 });
    expect(line('all')).toMatchObject({ open: 1, finished: 0 });
    expect(line('any')).toMatchObject({ open: 1, finished: 1 });

    // Unpicked: rubrics only — the phrases of one task are not lines.
    const all = await api.Tags.stats({ since: yesterday, tagIds: [], page: 1 });
    // Any column sorts, the largest (the latest) first.
    for (const sort of ['open', 'closed', 'comments', 'hours', 'last'] as const) {
      const sorted = await api.Tags.stats({ since: yesterday, tagIds: ids, page: 1, sort });
      expect(sorted.rows.filter((r) => r.group.kind === 'tag')).toHaveLength(2);
    }
    const byClosed = await api.Tags.stats({ since: yesterday, tagIds: ids, page: 1, sort: 'closed' });
    expect(byClosed.rows[0]!.tags[0]!.name).toBe(a);
    expect(all.rows.every((r) => !r.tags[0]!.name.startsWith('phrase'))).toBe(true);

    await devApi.Time.setLeft({ taskId: both, minutes: 120 });
    const detail = await api.Tags.detail({ since: yesterday, group: { kind: 'tag', tagId: ids[0]! } });
    expect(detail.days).toEqual([yesterday, today]);
    // Each person's time and plan, each with its detail: the comments of the day, the tasks the plan covers.
    expect(detail.persons).toEqual([{
      employeeId: dev.id, minutes: 90, share: 1, leftMinutes: 120, comments: 1,
      daily: [90, 0], dailyTasks: [1, 0], dailyComments: [0, 1], planned: [0, 120], plannedTasks: [0, 1],
    }]);
    expect((await api.Tags.stats({ since: yesterday, tagIds: ids, page: 1 })).rows[0]).toMatchObject({ planners: 1, leftMinutes: 120 });
  });

  test('a task shows what its tags mean along its owner\'s chain, the same for everyone; a dismissed author\'s pass up', async () => {
    const top = await createEmployee();
    const lead = await createEmployee({ managerId: top.id });
    const dev = await createEmployee({ managerId: lead.id });
    const stranger = await createEmployee();
    const tag = `d-${randomUUID().slice(0, 8)}`;
    const api = await client(dev.id);
    const id = await api.Task.create({ tags: [tag] });
    const tagId = (await api.Task.get({ id })).tags[0]!.id;
    await (await client(top.id)).Tags.setDescription({ tagId, html: '<p>Сверху</p>' });
    await (await client(lead.id)).Tags.setDescription({ tagId, html: '<p>У нас</p><img src="/api/attachments/1">' });
    await api.Tags.setDescription({ tagId, html: '<p>Заметка</p>' });
    await (await client(stranger.id)).Tags.setDescription({ tagId, html: '<p>В другом отделе иначе</p>' });

    const expected = [{ authorId: top.id, html: '<p>Сверху</p>' }, { authorId: lead.id, html: '<p>У нас</p>' }, { authorId: dev.id, html: '<p>Заметка</p>' }];
    expect((await api.Task.get({ id })).details?.tagDescriptions).toMatchObject(expected);
    // Someone from another department sees the same, not their own: whose task, that meaning.
    await api.Observer.add({ taskId: id, employeeId: stranger.id });
    expect((await (await client(stranger.id)).Task.get({ id })).details?.tagDescriptions).toMatchObject(expected);
    // Their own chain, for a task of their own.
    expect(await (await client(stranger.id)).Tags.descriptions({ tagIds: [tagId] })).toMatchObject([{ authorId: stranger.id }]);

    // Dismissed, the words stay with the manager; what the manager wrote wins.
    await (await client(lead.id)).Employee.dismiss({ id: dev.id });
    expect((await (await client(lead.id)).Tags.descriptions({ tagIds: [tagId] }))).toMatchObject([{ authorId: top.id }, { authorId: lead.id, html: '<p>У нас</p>' }]);
    await (await client(lead.id)).Tags.setDescription({ tagId, html: null });
    expect((await (await client(lead.id)).Tags.descriptions({ tagIds: [tagId] }))).toMatchObject([{ authorId: top.id }]);
  });

  test('a ring of managers does not loop', async () => {
    const a = await createEmployee();
    const b = await createEmployee({ managerId: a.id });
    await sql`UPDATE employee SET manager_id = ${b.id} WHERE id = ${a.id}`;
    const api = await client(a.id);
    const id = await api.Task.create({ tags: [`r-${randomUUID().slice(0, 8)}`] });
    const tagId = (await api.Task.get({ id })).tags[0]!.id;
    await (await client(b.id)).Tags.setDescription({ tagId, html: '<p>Слово</p>' });
    expect((await api.Task.get({ id })).details?.tagDescriptions).toMatchObject([{ authorId: b.id }]);
  });
});
