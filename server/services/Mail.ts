import { z } from 'zod';
import { interpolate, TRANSLATIONS } from '#shared/i18n/index.ts';
import type { NotificationPayload } from '#shared/notification.ts';
import type { Message } from '../delivery.ts';
import env from '../env.ts';
import { sql } from '../pg.ts';

const Title = z.object({ title: z.string() });
const Name = z.object({ id: z.number(), fullName: z.string() });

/** A task "title": its tags in the order the employee sees them. */
async function taskTitle(taskId: number, employeeId: number): Promise<string> {
  const [row] = Title.array().parse(await sql`
    SELECT array_to_string(ARRAY(
             SELECT tag.name
               FROM unnest(ordered_tags(${employeeId}, k.tag_ids)) WITH ORDINALITY AS o(id, n)
               JOIN tag ON tag.id = o.id
              ORDER BY o.n
           ), ' · ') AS title
      FROM task k WHERE k.id = ${taskId}
  `);
  return row?.title ?? `#${taskId}`;
}

async function names(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = Name.array().parse(await sql`SELECT id, full_name FROM employee WHERE id = ANY(${ids})`);
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

/** Subject and plain-text body in the recipient's language. */
export async function renderMail(message: Message): Promise<{ subject: string; text: string }> {
  const t = TRANSLATIONS[message.to.locale].mail;
  const p = message.payload;
  // Nobody here yet: tags in their plain order.
  const recipientId = message.to.employeeId ?? 0;

  const personIds = [
    'by' in p ? p.by : null,
    'employeeId' in p ? p.employeeId : null,
    'from' in p ? p.from : null,
    'for' in p ? p.for : null,
  ].filter((id): id is number => typeof id === 'number');
  const people = await names(personIds);
  const person = (id: number | undefined) => (id === undefined ? '' : (people.get(id) ?? `#${id}`));

  const params: Record<string, string> = {
    task: message.taskId === null ? '' : await taskTitle(message.taskId, recipientId),
    by: person('by' in p ? p.by : undefined),
    employee: person('employeeId' in p ? p.employeeId : undefined),
    from: person('from' in p ? p.from : undefined),
    dependency: 'dependencyId' in p ? await taskTitle(p.dependencyId, recipientId) : '',
    dependent: 'dependentId' in p ? await taskTitle(p.dependentId, recipientId) : '',
    text: 'text' in p ? (p.text ?? '') : '',
    day: 'day' in p ? p.day : '',
    issued: 'issuedAt' in p
      ? new Date(p.issuedAt).toLocaleDateString(message.to.locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: message.to.timeZone })
      : '',
    url: p.kind === 'login' || p.kind === 'email_confirm' || p.kind === 'sso_email' || p.kind === 'email_outside_domains'
      ? p.url : `${env.PUBLIC_URL}/login`,
    email: 'email' in p ? p.email : '',
  };

  if (p.kind === 'score') return renderScore(message, p, params.by ?? '', person('for' in p ? p.for : undefined));
  if (p.kind === 'weekly_digest') {
    const w = t.weekly_digest;
    const lines = [w.body];
    if (p.overdue) lines.push(interpolate(w.overdue, { count: String(p.overdue) }));
    if (p.atRisk) lines.push(interpolate(w.atRisk, { count: String(p.atRisk) }));
    if (p.blocked) lines.push(interpolate(w.blocked, { count: String(p.blocked) }));
    return { subject: w.subject, text: [lines.join('\n'), interpolate(w.open, { url: `${env.PUBLIC_URL}/` })].join('\n\n') };
  }

  const template = t[p.kind];
  const lines = [interpolate(template.body, params).trim()];
  if (p.kind === 'dependency_added' && p.hard) lines.push(interpolate(t.dependency_added.limited, params));
  if (p.kind === 'finished_at_change' && p.late) lines.push(t.finished_at_change.late);
  if ('for' in p && p.for !== undefined) lines.push(interpolate(t.awayCopy, { name: person(p.for) }));
  if (message.taskId !== null) lines.push(interpolate(t.open, { url: `${env.PUBLIC_URL}/tasks/${message.taskId}` }));
  // The other task the message names is a link too.
  const other = p.kind === 'finished_at_change' || p.kind === 'dependency_done' || p.kind === 'waits_added'
    ? { id: p.dependencyId, title: params.dependency }
    : p.kind === 'dependency_added' ? { id: p.dependentId, title: params.dependent } : null;
  if (other) lines.push(interpolate(t.openOther, { task: other.title ?? '', url: `${env.PUBLIC_URL}/tasks/${other.id}` }));
  if (p.kind === 'bot_key_old') lines.push(interpolate(t.weekly_digest.open, { url: `${env.PUBLIC_URL}/` }));

  return { subject: interpolate(template.subject, params), text: lines.join('\n\n') };
}

/**
 * A score email is the record of one version of the score: value, reason,
 * the moment in the recipient's time zone and, for a correction, what it
 * replaced. The interface shows only the current version.
 */
function renderScore(message: Message, p: Extract<NotificationPayload, { kind: 'score' }>, by: string, forName: string) {
  const { locale, timeZone } = message.to;
  const t = TRANSLATIONS[locale].mail.score;
  // A shift, in the recipient's time zone (decision 100); before 0.6 a day was scored.
  const day = p.startedAt === undefined
    ? new Date(`${p.day}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : `${new Date(p.startedAt).toLocaleString(locale, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone })}`
      + `–${new Date(new Date(p.startedAt).getTime() + (p.minutes ?? 0) * 60_000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone })}`;
  const at = new Date(p.at).toLocaleString(locale, { dateStyle: 'long', timeStyle: 'short', timeZone });
  const params = { by, day, value: String(p.value ?? ''), previous: String(p.previous?.value ?? '') };
  // A score given again after a withdrawal reads as a first one.
  const kind = p.value === null ? 'withdrawn' : p.previous?.value != null ? 'changed' : 'body';

  const lines = [interpolate(t[kind], params)];
  if (p.reason) lines.push(interpolate(t.reason, { reason: p.reason }));
  if (p.previous?.reason && p.previous.reason !== p.reason) lines.push(interpolate(t.previousReason, { reason: p.previous.reason }));
  lines.push(interpolate(t.at, { at }));
  if (p.for !== undefined) lines.push(interpolate(TRANSLATIONS[locale].mail.awayCopy, { name: forName }));
  const subject = kind === 'withdrawn' ? t.withdrawnSubject : kind === 'changed' ? t.changedSubject : t.subject;
  return { subject: interpolate(subject, params), text: lines.join('\n\n') };
}
