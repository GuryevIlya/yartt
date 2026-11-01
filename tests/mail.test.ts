import { describe, expect, test } from 'vitest';
import { sql } from '../server/pg.ts';
import { renderMail } from '../server/services/Mail.ts';
import { createEmployee } from './helpers.ts';

async function taskWithTags(ownerId: number, names: string[]): Promise<number> {
  const ids: number[] = [];
  for (const name of names) {
    const [row] = await sql<{ id: number }[]>`INSERT INTO tag (name) VALUES (${name}) RETURNING id`;
    ids.push(row!.id);
  }
  const [task] = await sql<{ id: number }[]>`INSERT INTO task (owner_id, tag_ids) VALUES (${ownerId}, ${ids}) RETURNING id`;
  return task!.id;
}

describe('mail', () => {
  test('rendered in the recipient language with names and the task title', async () => {
    const previous = await createEmployee();
    const me = await createEmployee();
    await sql`UPDATE employee SET full_name = 'Pavel' WHERE id = ${previous.id}`;
    const taskId = await taskWithTags(me.id, [`billing-${me.id}`, `export-${me.id}`]);
    const to = { employeeId: me.id, kind: 'human' as const, email: me.email, fullName: 'Me', locale: 'en' as const, timeZone: 'Europe/Moscow' };

    const en = await renderMail({ to, taskId, payload: { kind: 'owner_change', from: previous.id } });
    expect(en.subject).toBe(`You own: billing-${me.id} · export-${me.id}`);
    expect(en.text).toContain('Previous owner: Pavel.');
    expect(en.text).toContain(`http://yartt.test/tasks/${taskId}`);

    const ru = await renderMail({ to: { ...to, locale: 'ru' }, taskId, payload: { kind: 'owner_change', from: previous.id } });
    expect(ru.subject).toBe(`Вы владелец: billing-${me.id} · export-${me.id}`);
  });

  test('the other task a message names is a link too', async () => {
    const me = await createEmployee();
    const mine = await taskWithTags(me.id, [`mine-${me.id}`]);
    const theirs = await taskWithTags(me.id, [`theirs-${me.id}`]);
    const to = { employeeId: me.id, kind: 'human' as const, email: me.email, fullName: 'Me', locale: 'en' as const, timeZone: 'Europe/Moscow' };

    const moved = await renderMail({ to, taskId: mine, payload: { kind: 'finished_at_change', dependencyId: theirs, late: false } });
    expect(moved.text).toContain(`Open: http://yartt.test/tasks/${mine}`);
    expect(moved.text).toContain(`Open "theirs-${me.id}": http://yartt.test/tasks/${theirs}`);
  });

  test('sign-in link and a copy for an absent employee', async () => {
    const me = await createEmployee();
    const absent = await createEmployee();
    await sql`UPDATE employee SET full_name = 'Marina' WHERE id = ${absent.id}`;
    const to = { employeeId: me.id, kind: 'human' as const, email: me.email, fullName: 'Me', locale: 'en' as const, timeZone: 'Europe/Moscow' };

    const login = await renderMail({ to, taskId: null, payload: { kind: 'login', url: 'http://yartt.test/login/abc' } });
    expect(login.text).toContain('http://yartt.test/login/abc');
    expect(login.text).not.toContain('/tasks/');

    const copy = await renderMail({ to, taskId: null, payload: { kind: 'new_report', employeeId: me.id, for: absent.id } });
    expect(copy.text).toContain('A copy: Marina is away.');
  });

  test('someone added without an invite is welcomed by yartt itself, with where to sign in', async () => {
    const me = await createEmployee();
    const to = { employeeId: me.id, kind: 'human' as const, email: me.email, fullName: 'Me', locale: 'ru' as const, timeZone: 'UTC' };
    const welcome = await renderMail({ to, taskId: null, payload: { kind: 'welcome' } });
    expect(welcome.subject).toBe('Вас добавили в яртт');
    expect(welcome.text).toContain('http://yartt.test/login');
  });

  test('a score correction carries the previous value, the reason and the time', async () => {
    const boss = await createEmployee();
    const me = await createEmployee();
    await sql`UPDATE employee SET full_name = 'Marina' WHERE id = ${boss.id}`;
    const to = { employeeId: me.id, kind: 'human' as const, email: me.email, fullName: 'Me', locale: 'en' as const, timeZone: 'Europe/Moscow' };
    const mail = await renderMail({
      to,
      taskId: null,
      payload: {
        // A shift, in the recipient's time zone (decision 100).
        kind: 'score', by: boss.id, day: '2026-10-12', startedAt: '2026-10-12T06:00:00.000Z', minutes: 480, value: 90, reason: 'Good call on the release',
        at: '2026-10-15T07:30:00.000Z', previous: { value: 60, reason: 'Wrong priorities' },
      },
    });
    expect(mail.subject).toBe('Score for the shift October 12, 2026 at 09:00 AM–05:00 PM changed: 90%');
    expect(mail.text).toContain('Marina changes the score for the shift October 12, 2026 at 09:00 AM–05:00 PM: was 60%, now 90%.');
    expect(mail.text).toContain('Reason: Good call on the release');
    expect(mail.text).toContain('Previous reason: Wrong priorities');
    expect(mail.text).toContain('10:30'); // Moscow time
  });

  test('the weekly email lists only what is there, with a link to My day', async () => {
    const me = await createEmployee();
    const to = { employeeId: me.id, kind: 'human' as const, email: 'lead@example.com', fullName: 'Lead', locale: 'ru' as const, timeZone: 'UTC' };
    const mail = await renderMail({ to, taskId: null, payload: { kind: 'weekly_digest', unscored: 3, overdue: 0, atRisk: 2, blocked: 1 } });
    expect(mail.text).toContain('больше не пускает корпоративная учётная запись');
    expect(mail.subject).toBe('Неделя вашей команды');
    expect(mail.text).toContain('ждут вашей оценки: 3');
    expect(mail.text).toContain('под угрозой');
    expect(mail.text).not.toContain('автоматически');
    expect(mail.text).toMatch(/Открыть «Мой день»: http\S+\/$/m);
  });
});
