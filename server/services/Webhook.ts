import { z } from 'zod';
import { type NotificationPayload } from '#shared/notification.ts';
import { Webhook, WebhookLevels, webhookGroup, type WebhookInput } from '#shared/webhook.ts';
import type { Message } from '../delivery.ts';
import env from '../env.ts';
import { AppError } from '../errors.ts';
import { plainText } from '../html.ts';
import { sql, type Sql } from '../pg.ts';
import { sendWebhook, webhookAllowed } from '../webhook.ts';
import { countDelivery } from './Bot.ts';
import { renderMail } from './Mail.ts';

/** How many webhooks a person keeps: a channel or two, not a mailing list. */
const MAX_WEBHOOKS = 10;
/** The body's shape; a bot's webhook is version 1. */
const VERSION = 2;

const COLUMNS = sql`id, url, secret, levels, last_at, last_error`;

export async function list(employeeId: number): Promise<Webhook[]> {
  return Webhook.array().parse(await sql`
    SELECT ${COLUMNS} FROM webhook WHERE employee_id = ${employeeId} ORDER BY id
  `);
}

function assertAllowed(url: string): void {
  if (!webhookAllowed(url)) throw new AppError('webhook_url_not_allowed');
}

export async function create(employeeId: number, input: WebhookInput): Promise<Webhook> {
  assertAllowed(input.url);
  const rows = Webhook.array().parse(await sql`
    INSERT INTO webhook (employee_id, url, levels)
    SELECT ${employeeId}, ${input.url}, ${sql.json(input.levels)}
     WHERE (SELECT count(*) FROM webhook WHERE employee_id = ${employeeId}) < ${MAX_WEBHOOKS}
    RETURNING ${COLUMNS}
  `);
  if (!rows[0]) throw new AppError('webhook_limit', { limit: MAX_WEBHOOKS });
  return rows[0];
}

export async function update(employeeId: number, id: number, input: WebhookInput): Promise<Webhook> {
  assertAllowed(input.url);
  const [row] = Webhook.array().parse(await sql`
    UPDATE webhook SET url = ${input.url}, levels = ${sql.json(input.levels)}
     WHERE id = ${id} AND employee_id = ${employeeId}
    RETURNING ${COLUMNS}
  `);
  if (!row) throw new AppError('not_found');
  return row;
}

export async function remove(employeeId: number, id: number): Promise<void> {
  const rows = await sql`DELETE FROM webhook WHERE id = ${id} AND employee_id = ${employeeId} RETURNING id`;
  if (rows.length === 0) throw new AppError('not_found');
}

const Target = z.object({ id: z.number(), url: z.string(), secret: z.string(), levels: WebhookLevels });

async function send(db: Sql, target: { id: number; url: string; secret: string }, body: string): Promise<boolean> {
  let failure: string | null = null;
  try {
    await sendWebhook(body, target);
  } catch (error) {
    failure = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  await db`UPDATE webhook SET last_at = NOW(), last_error = ${failure} WHERE id = ${target.id}`;
  return failure === null;
}

/** Minutes until the next attempt after each failed one; past the last it is dropped. */
const RETRY_MINUTES = [1, 5, 15, 60];
const nextAt = (attempts: number) => new Date(Date.now() + RETRY_MINUTES[attempts - 1]! * 60_000);

/** A message a webhook did not take: tried again apart from the queue, one broken receiver holds nobody. */
export async function retryLater(db: Sql, target: { webhookId: number } | { botId: number }, body: string): Promise<void> {
  await db`
    INSERT INTO webhook_retry (webhook_id, bot_id, body, next_at)
    VALUES (${'webhookId' in target ? target.webhookId : null}, ${'botId' in target ? target.botId : null}, ${body}, ${nextAt(1)})
  `;
}

const Due = z.object({
  id: z.string(),
  webhookId: z.number().nullable(),
  botId: z.number().nullable(),
  body: z.string(),
  attempts: z.number(),
  url: z.string().nullable(),
  secret: z.string().nullable(),
});

/** Tries again what is due. FOR UPDATE SKIP LOCKED: several workers never take the same one. */
export async function retryDue(sql_: Sql): Promise<number> {
  return sql_.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const rows = Due.array().parse(await db`
      SELECT r.id, r.webhook_id, r.bot_id, r.body, r.attempts,
             COALESCE(w.url, b.webhook_url) AS url, COALESCE(w.secret, b.webhook_secret) AS secret
        FROM webhook_retry r
        LEFT JOIN webhook w ON w.id = r.webhook_id
        LEFT JOIN bot b ON b.employee_id = r.bot_id
       WHERE r.next_at <= NOW()
       ORDER BY r.next_at
       LIMIT 50
         FOR UPDATE OF r SKIP LOCKED
    `);
    for (const row of rows) {
      let done = row.url === null; // a bot's webhook taken away: nowhere to send it
      if (!done) {
        if (row.webhookId !== null) {
          done = await send(db, { id: row.webhookId, url: row.url!, secret: row.secret! }, row.body);
        } else {
          try {
            await sendWebhook(row.body, { url: row.url!, secret: row.secret ?? '' });
            done = true;
          } catch (error) {
            console.error(`[worker] webhook retry of bot ${row.botId} failed:`, error);
          }
          await countDelivery(db, row.botId!, !done);
        }
      }
      if (done || row.attempts >= RETRY_MINUTES.length) await db`DELETE FROM webhook_retry WHERE id = ${row.id}`;
      else await db`UPDATE webhook_retry SET attempts = attempts + 1, next_at = ${nextAt(row.attempts + 1)} WHERE id = ${row.id}`;
    }
    return rows.length;
  });
}

/** Sends the owner a test: says whether the address takes it. */
export async function test(employeeId: number, id: number): Promise<Webhook> {
  const [target] = Target.array().parse(await sql`
    SELECT id, url, secret, levels FROM webhook WHERE id = ${id} AND employee_id = ${employeeId}
  `);
  if (!target) throw new AppError('not_found');
  await send(sql, target, JSON.stringify({ version: VERSION, kind: 'test', to: { employeeId }, taskId: null, url: `${env.PUBLIC_URL}/` }));
  const [row] = (await list(employeeId)).filter((w) => w.id === id);
  return row!;
}

const CommentText = z.object({ value: z.string() });

/**
 * A notification to a person's webhooks, each getting as much as it was told
 * to for this kind of event. A failure is tried again a few times apart from
 * the queue (retryDue): a webhook is someone's program, and the email and the
 * bell have told the person anyway. Never throws.
 */
export async function deliver(db: Sql, to: Message['to'], taskId: number | null, payload: NotificationPayload): Promise<void> {
  if (to.employeeId === null) return;
  const targets = Target.array().parse(await db`
    SELECT id, url, secret, levels FROM webhook WHERE employee_id = ${to.employeeId}
  `);
  if (targets.length === 0) return;
  const level = (t: z.infer<typeof Target>) => t.levels[webhookGroup(payload.kind)];
  const envelope = {
    kind: payload.kind,
    to: { employeeId: to.employeeId },
    taskId,
    url: `${env.PUBLIC_URL}${taskId === null ? '/' : `/tasks/${taskId}`}`,
  };
  const rendered = targets.some((t) => level(t) === 'title' || level(t) === 'text')
    ? await renderMail({ to, taskId, payload })
    : null;
  let comment: string | null = null;
  if (targets.some((t) => level(t) === 'text') && taskId !== null && 'commentId' in payload) {
    const [row] = CommentText.array().parse(await db`SELECT value FROM comment WHERE task_id = ${taskId} AND id = ${payload.commentId}`);
    comment = row ? plainText(row.value) : null;
  }
  for (const target of targets) {
    const how = level(target);
    if (how === 'off') continue;
    const body = JSON.stringify({
      version: VERSION,
      ...envelope,
      ...(how !== 'event' && { subject: rendered?.subject }),
      ...(how === 'text' && { text: rendered?.text, comment, data: payload }),
    });
    if (!(await send(db, target, body))) await retryLater(db, { webhookId: target.id }, body);
  }
}
