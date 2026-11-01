import { describe, expect, test } from 'vitest';
import { sql } from '../server/pg.ts';
import { client, createEmployee } from './helpers.ts';

describe('employee', () => {
  test('invite inherits locale and time zone, notifies invitee', async () => {
    const inviter = await createEmployee();
    await sql`UPDATE employee SET locale = 'en', time_zone = 'Asia/Almaty' WHERE id = ${inviter.id}`;

    const api = await client(inviter.id);
    const invited = await api.Employee.invite({ email: 'New.Person@yartt.test', fullName: 'New Person' });
    expect(invited).toMatchObject({ locale: 'en', timeZone: 'Asia/Almaty', managerId: null });

    const [notification] = await sql<{ payload: { kind: string; by: number } }[]>`
      SELECT payload FROM notification WHERE employee_id = ${invited.id}
    `;
    expect(notification?.payload).toEqual({ kind: 'invite', by: inviter.id });

    await expect(api.Employee.invite({ email: 'new.person@YARTT.test', fullName: 'Dup' }))
      .rejects.toMatchObject({ message: 'email_taken' });
  });

  test('settings: invalid time zone is rejected with a code, left-out fields stay', async () => {
    const me = await createEmployee();
    const api = await client(me.id);

    expect(await api.Employee.updateSettings({ timeZone: 'Europe/Moscow', locale: 'en' }))
      .toMatchObject({ timeZone: 'Europe/Moscow', locale: 'en' });
    expect(await api.Employee.updateSettings({ nextDay: '2026-12-31' }))
      .toMatchObject({ timeZone: 'Europe/Moscow', locale: 'en', nextDay: '2026-12-31' });
    expect(await api.Employee.updateSettings({ locale: 'ru' })).toMatchObject({ nextDay: '2026-12-31' });
    expect(await api.Employee.updateSettings({ nextDay: null })).toMatchObject({ nextDay: null });
    await expect(api.Employee.updateSettings({ timeZone: 'Mars/Base' }))
      .rejects.toMatchObject({ message: 'invalid_time_zone' });
    await expect(api.Employee.updateSettings({ nextDay: '2026-13-01' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('profile: name and about; the email is not changed there', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    expect(await api.Employee.updateProfile({ fullName: 'Me', about: 'QA lead' }))
      .toMatchObject({ fullName: 'Me', email: me.email, about: 'QA lead' });
  });

  test('output contract catches data the client does not know', async () => {
    const me = await createEmployee();
    // The database accepts any language code, the contract only supported ones.
    await sql`UPDATE employee SET locale = 'de' WHERE id = ${me.id}`;
    try {
      await expect((await client(me.id)).Auth.me()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    } finally {
      await sql`UPDATE employee SET locale = 'ru' WHERE id = ${me.id}`;
    }
  });

  test('nextDay stays a plain date', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    await api.Employee.updateSettings({ timeZone: 'Pacific/Kiritimati' });
    const saved = await api.Employee.updateSettings({ nextDay: '2026-12-31' });
    expect(saved.nextDay).toBe('2026-12-31');
  });

  test('nobody is their own manager', async () => {
    const boss = await createEmployee();
    await expect((await client(boss.id)).Employee.setManager({ managerId: boss.id }))
      .rejects.toMatchObject({ message: 'manager_self' });
  });

  test('managers may form a ring: each sees the others\' tasks, rights stay with the direct manager', async () => {
    const a = await createEmployee();
    const b = await createEmployee({ managerId: a.id });
    const c = await createEmployee({ managerId: b.id });
    const dev = await createEmployee({ managerId: c.id });
    const [tag] = await sql<{ id: number }[]>`INSERT INTO tag (name) VALUES (${'ring-' + a.id}) RETURNING id`;
    const [devTask] = await sql<{ id: number }[]>`INSERT INTO task (owner_id, tag_ids) VALUES (${dev.id}, ${[tag!.id]}) RETURNING id`;
    await (await client(a.id)).Employee.setManager({ managerId: c.id }); // a -> c -> b -> a
    const [tag2] = await sql<{ id: number }[]>`INSERT INTO tag (name) VALUES (${'ring2-' + a.id}) RETURNING id`;
    const [aTask] = await sql<{ id: number }[]>`INSERT INTO task (owner_id, tag_ids) VALUES (${a.id}, ${[tag2!.id]}) RETURNING id`;

    const sees = async (taskId: number) => (await sql<{ v: boolean }[]>`
      SELECT array_agg(can_see(${taskId}, x) ORDER BY x) AS v FROM unnest(${[a.id, b.id, c.id]}::int[]) x
    `)[0]!.v;
    expect(await sees(devTask!.id)).toEqual([true, true, true]);
    expect(await sees(aTask!.id)).toEqual([true, true, true]);
    // The others of the ring are one's reports, never oneself.
    const [under] = await sql<{ ids: number[] }[]>`SELECT array_agg(s ORDER BY s) AS ids FROM subordinates(${a.id}) s`;
    expect(under!.ids).toEqual([b.id, c.id, dev.id].sort((x, y) => x - y));
    const today = new Date().toISOString().slice(0, 10);
    const team = await (await client(a.id)).Team.summary({ from: today, to: today });
    expect(team.map((m) => m.employeeId).sort((x, y) => x - y)).toEqual([a.id, b.id, c.id, dev.id].sort((x, y) => x - y));

    // Everyone of the ring away: a notification goes round once — a copy each — and stops.
    await sql`UPDATE human SET next_day = CURRENT_DATE + 7 WHERE employee_id IN (${a.id}, ${b.id}, ${c.id})`;
    await sql`SELECT notify(${a.id}, NULL, '{"kind": "invite", "by": 0}'::jsonb)`;
    const [sent] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notification WHERE employee_id IN (${a.id}, ${b.id}, ${c.id}) AND payload->>'kind' = 'invite' AND payload->>'by' = '0'
    `;
    expect(sent!.n).toBe(3);
    await sql`UPDATE human SET next_day = NULL WHERE employee_id IN (${a.id}, ${b.id}, ${c.id})`;

    // Only the direct manager dismisses, in a ring too; the last pair leaves one without a manager.
    await expect((await client(b.id)).Employee.dismiss({ id: a.id })).rejects.toMatchObject({ message: 'not_manager' });
    await (await client(c.id)).Employee.dismiss({ id: a.id }); // b moves to c: b <-> c
    await (await client(b.id)).Employee.dismiss({ id: c.id }); // b and dev move to b: b has none
    const managers = new Map((await (await client(b.id)).Employee.list()).map((e) => [e.id, e.managerId]));
    expect([managers.get(b.id), managers.get(dev.id), managers.get(c.id)]).toEqual([null, b.id, b.id]);
  });

  test('only the direct manager dismisses; tasks and reports move to them', async () => {
    const top = await createEmployee();
    const middle = await createEmployee({ managerId: top.id });
    const bottom = await createEmployee({ managerId: middle.id });
    const [tag] = await sql<{ id: number }[]>`INSERT INTO tag (name) VALUES (${'t-' + middle.id}) RETURNING id`;
    const [task] = await sql<{ id: number }[]>`
      INSERT INTO task (owner_id, tag_ids) VALUES (${middle.id}, ${[tag!.id]}) RETURNING id
    `;

    // Not the manager (a report, a stranger), and nobody above the top.
    await expect((await client(bottom.id)).Employee.dismiss({ id: middle.id }))
      .rejects.toMatchObject({ message: 'not_manager', cause: { params: { employeeId: middle.id } } });
    await expect((await client(middle.id)).Employee.dismiss({ id: top.id }))
      .rejects.toMatchObject({ message: 'not_manager' });

    const api = await client(top.id);
    await api.Employee.dismiss({ id: middle.id });
    const list = await api.Employee.list();
    // Dismissed, with the email kept for coming back.
    expect(list.find((e) => e.id === middle.id)).toMatchObject({ email: middle.email, dismissedAt: expect.any(Date) });
    expect(list.find((e) => e.id === bottom.id)?.managerId).toBe(top.id);
    const [owner] = await sql<{ ownerId: number }[]>`SELECT owner_id FROM task WHERE id = ${task!.id}`;
    expect(owner?.ownerId).toBe(top.id);

    await expect(api.Employee.dismiss({ id: middle.id })).rejects.toMatchObject({ message: 'not_found' });
  });

  test('only the direct manager brings back', async () => {
    const boss = await createEmployee();
    const other = await createEmployee();
    const dev = await createEmployee({ managerId: boss.id });
    await (await client(boss.id)).Employee.dismiss({ id: dev.id });

    await expect((await client(other.id)).Employee.restore({ id: dev.id }))
      .rejects.toMatchObject({ message: 'not_manager' });
    // Nothing to type: they come back with the email they had.
    expect(await (await client(boss.id)).Employee.restore({ id: dev.id }))
      .toMatchObject({ email: dev.email, dismissedAt: null });
    await expect((await client(boss.id)).Employee.restore({ id: dev.id }))
      .rejects.toMatchObject({ message: 'not_found' });
  });

  test('a dismissed employee does not hold their email: someone new may get it, and the one coming back takes another', async () => {
    const boss = await createEmployee();
    const dev = await createEmployee({ managerId: boss.id });
    const api = await client(boss.id);
    await api.Employee.dismiss({ id: dev.id });
    const [token] = await sql<{ token: string | null }[]>`SELECT issue_token(${dev.email}, 'browser') AS token`;
    expect(token?.token).toBeNull();

    const successor = await api.Employee.invite({ email: dev.email, fullName: 'Successor' });
    expect(successor.email).toBe(dev.email);
    await expect(api.Employee.restore({ id: dev.id })).rejects.toMatchObject({ message: 'email_taken' });
    expect(await api.Employee.restore({ id: dev.id, email: `back-${dev.email}` }))
      .toMatchObject({ email: `back-${dev.email}`, dismissedAt: null });
  });

  test('someone working without an email still gets notifications in the bell', async () => {
    const boss = await createEmployee();
    const dev = await createEmployee();
    await sql`UPDATE employee SET email = NULL WHERE id = ${dev.id}`;
    await (await client(dev.id)).Employee.setManager({ managerId: boss.id });
    await (await client(boss.id)).Employee.dismiss({ id: dev.id });
    await sql`SELECT notify(${dev.id}, NULL, ${sql.json({ kind: 'new_report', employeeId: boss.id })})`;
    expect(await sql`SELECT 1 FROM notification WHERE employee_id = ${dev.id}`).toHaveLength(0);
    await (await client(boss.id)).Employee.restore({ id: dev.id });
    await sql`SELECT notify(${dev.id}, NULL, ${sql.json({ kind: 'new_report', employeeId: boss.id })})`;
    expect(await sql`SELECT 1 FROM notification WHERE employee_id = ${dev.id}`).toHaveLength(1);
  });

  test('a dismissed employee always has a manager to bring them back: theirs, or the one above when theirs leaves', async () => {
    const top = await createEmployee();
    const lead = await createEmployee({ managerId: top.id });
    const dev = await createEmployee({ managerId: lead.id });
    await (await client(lead.id)).Employee.dismiss({ id: dev.id });
    await (await client(top.id)).Employee.dismiss({ id: lead.id });
    // The lead's dismissed report moved up with the rest: the top manager brings them back.
    expect((await (await client(top.id)).Employee.list()).find((e) => e.id === dev.id)?.managerId).toBe(top.id);
    await expect(sql`UPDATE employee SET manager_id = NULL WHERE id = ${dev.id}`)
      .rejects.toMatchObject({ constraint_name: 'chk_employee_dismissed_manager' });
  });

  test('brought back under the same manager; another manager is then the employee\'s own choice', async () => {
    const boss = await createEmployee();
    const peer = await createEmployee();
    const dev = await createEmployee({ managerId: boss.id });
    const api = await client(boss.id);
    await api.Employee.dismiss({ id: dev.id });
    expect(await api.Employee.restore({ id: dev.id }))
      .toMatchObject({ email: dev.email, managerId: boss.id, dismissedAt: null });
    await (await client(dev.id)).Employee.setManager({ managerId: peer.id });
    expect((await api.Employee.list()).find((e) => e.id === dev.id)?.managerId).toBe(peer.id);
  });

  test('someone at the top leaves through their own people: the successor becomes their manager, dismisses them', async () => {
    const top = await createEmployee();
    const heir = await createEmployee({ managerId: top.id });
    const other = await createEmployee({ managerId: top.id });
    const gone = await createEmployee({ managerId: top.id });
    await (await client(top.id)).Employee.dismiss({ id: gone.id });

    // A ring for a moment: the heir is under the top, and the top under the heir.
    await (await client(top.id)).Employee.setManager({ managerId: heir.id });
    const heirApi = await client(heir.id);
    await heirApi.Employee.dismiss({ id: top.id });
    const managers = new Map((await heirApi.Employee.list()).map((e) => [e.id, e.managerId]));
    expect([managers.get(heir.id), managers.get(top.id), managers.get(other.id), managers.get(gone.id)])
      .toEqual([null, heir.id, heir.id, heir.id]);
    // Only the heir brings back the top and the one dismissed before.
    await expect((await client(other.id)).Employee.restore({ id: top.id })).rejects.toMatchObject({ message: 'not_manager' });
    await heirApi.Employee.restore({ id: gone.id });
  });

  test('the administrator dismisses someone at the top with an heir from their own team', async () => {
    const top = await createEmployee();
    const lead = await createEmployee({ managerId: top.id });
    const heir = await createEmployee({ managerId: lead.id }); // deep in the top's team
    const gone = await createEmployee({ managerId: top.id });
    await (await client(top.id)).Employee.dismiss({ id: gone.id });

    await sql`SELECT dismiss_with_heir(${top.id}, ${heir.id})`;
    const managers = new Map((await (await client(heir.id)).Employee.list()).map((e) => [e.id, e]));
    expect(managers.get(top.id)).toMatchObject({ dismissedAt: expect.any(Date), managerId: heir.id });
    expect([managers.get(heir.id)!.managerId, managers.get(lead.id)!.managerId, managers.get(gone.id)!.managerId])
      .toEqual([null, heir.id, heir.id]);
    await (await client(heir.id)).Employee.restore({ id: top.id });

    // An heir from elsewhere just becomes the manager; the heir must be someone else, and active.
    const other = await createEmployee();
    await expect(sql`SELECT dismiss_with_heir(${other.id}, ${other.id})`).rejects.toMatchObject({ hint: 'not_found' });
    await sql`SELECT dismiss_with_heir(${top.id}, ${lead.id})`;
    expect((await (await client(lead.id)).Employee.list()).find((e) => e.id === top.id)).toMatchObject({ dismissedAt: expect.any(Date), managerId: lead.id });
  });

  test('the new manager is notified', async () => {
    const boss = await createEmployee();
    const dev = await createEmployee();
    await (await client(dev.id)).Employee.setManager({ managerId: boss.id });

    const rows = await sql<{ payload: unknown }[]>`SELECT payload FROM notification WHERE employee_id = ${boss.id}`;
    expect(rows.map((r) => r.payload)).toEqual([{ kind: 'new_report', employeeId: dev.id }]);
  });
});

describe('pronoun', () => {
  test('set, cleared, and only he or she', async () => {
    const me = await createEmployee();
    const api = await client(me.id);
    expect(await api.Employee.updateSettings({ pronoun: 'she' })).toMatchObject({ pronoun: 'she' });
    expect(await api.Employee.updateSettings({ locale: 'en' })).toMatchObject({ pronoun: 'she' });
    expect(await api.Employee.updateSettings({ pronoun: null })).toMatchObject({ pronoun: null });
    // @ts-expect-error — not a pronoun
    await expect(api.Employee.updateSettings({ pronoun: 'it' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
