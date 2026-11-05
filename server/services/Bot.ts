import { z } from 'zod';
import { Bot, BotPermission, BotStats, type BotInput, type BotKey } from '#shared/bot.ts';
import { AppError } from '../errors.ts';
import { sql, type Sql } from '../pg.ts';
import { webhookAllowed } from '../webhook.ts';
import { untilToday } from './Tags.ts';

const KeyRow = z.object({ botId: z.number(), key: z.string() });
const Key = z.object({ key: z.string() });
const Authenticated = z.object({ id: z.number(), permissions: BotPermission.array() });

const columns = (viewerId: number) => sql`
  e.id, e.full_name, e.about, e.pronoun, e.manager_id, b.permissions::text[] AS permissions,
  b.webhook_url, CASE WHEN e.manager_id = ${viewerId} THEN b.webhook_secret END AS webhook_secret,
  b.key_issued_at, e.dismissed_at,
  EXISTS (SELECT 1 FROM human m WHERE m.employee_id = e.manager_id AND m.idp_blocked_at IS NOT NULL) AS stopped
`;

/**
 * Bots the viewer answers for: their own and those of everyone under them,
 * dismissed ones included; their own first, then by name.
 */
export async function list(viewerId: number): Promise<Bot[]> {
  return Bot.array().parse(await sql`
    SELECT ${columns(viewerId)}
      FROM bot b JOIN employee e ON e.id = b.employee_id
     WHERE e.manager_id = ${viewerId} OR e.manager_id IN (SELECT subordinates(${viewerId}))
     ORDER BY e.manager_id = ${viewerId} DESC, e.dismissed_at IS NOT NULL, e.full_name, e.id
  `);
}

async function get(viewerId: number, id: number): Promise<Bot> {
  const [bot] = Bot.array().parse(await sql`
    SELECT ${columns(viewerId)} FROM bot b JOIN employee e ON e.id = b.employee_id WHERE e.id = ${id}
  `);
  if (!bot) throw new AppError('not_found');
  return bot;
}

/** A person creates a bot under themselves; its key is returned only now. */
function assertWebhook(input: BotInput): void {
  if (input.webhookUrl !== null && !webhookAllowed(input.webhookUrl)) throw new AppError('webhook_url_not_allowed');
}

export async function create(actorId: number, input: BotInput): Promise<BotKey> {
  assertWebhook(input);
  return sql.begin(async (tx) => {
    const [row] = KeyRow.array().parse(await tx`SELECT bot_id, key FROM create_bot(${actorId}, ${input.fullName})`);
    await tx`
      UPDATE employee SET pronoun = ${input.pronoun}, about = ${input.about} WHERE id = ${row!.botId}
    `;
    await tx`
      UPDATE bot SET permissions = ${tx.array([...new Set(input.permissions)])}::text[]::bot_permission[],
                     webhook_url = ${input.webhookUrl}
       WHERE employee_id = ${row!.botId}
    `;
    return { id: row!.botId, key: row!.key };
  });
}

/** Its direct manager changes it (check_bot_manager). */
export async function update(actorId: number, id: number, input: BotInput): Promise<Bot> {
  assertWebhook(input);
  await sql.begin(async (tx) => {
    await tx`SELECT check_bot_manager(${id}, ${actorId})`;
    await tx`
      UPDATE employee SET full_name = ${input.fullName}, pronoun = ${input.pronoun}, about = ${input.about}
       WHERE id = ${id}
    `;
    await tx`
      UPDATE bot SET permissions = ${tx.array([...new Set(input.permissions)])}::text[]::bot_permission[],
                     webhook_url = ${input.webhookUrl}
       WHERE employee_id = ${id}
    `;
  });
  return get(actorId, id);
}

/** See reset_bot_key() in db.sql; the new key is returned only now. */
export async function resetKey(actorId: number, id: number): Promise<BotKey> {
  const [row] = Key.array().parse(await sql`SELECT reset_bot_key(${id}, ${actorId}) AS key`);
  return { id, key: row!.key };
}

/** A new webhook secret: the old one stops signing at once. */
export async function resetWebhookSecret(actorId: number, id: number): Promise<Bot> {
  await sql.begin(async (tx) => {
    await tx`SELECT check_bot_manager(${id}, ${actorId})`;
    await tx`UPDATE bot SET webhook_secret = encode(gen_random_bytes(32), 'hex') WHERE employee_id = ${id}`;
  });
  return get(actorId, id);
}

/** See transfer_bot() in db.sql: at once, with a key nobody knows. */
export async function transfer(actorId: number, id: number, toId: number): Promise<void> {
  await sql`SELECT transfer_bot(${id}, ${actorId}, ${toId})`;
}

/** The bot a key belongs to and what it may change, or null. */
export async function authenticate(key: string): Promise<z.infer<typeof Authenticated> | null> {
  const [row] = Authenticated.array().parse(await sql`
    SELECT b.employee_id AS id, b.permissions::text[] AS permissions
      FROM bot b WHERE b.employee_id = authenticate_bot(${key})
  `);
  return row ?? null;
}

/** Counts an API call of the bot (count_bot_request()). */
export async function countRequest(id: number, refused: boolean): Promise<void> {
  await sql`SELECT count_bot_request(${id}, ${refused})`;
}

/**
 * What the bots the viewer answers for did from `since` to today: their tasks now and closed in the range, comments and
 * mentions, API calls and refusals, webhook deliveries — and their last
 * call ever, for the quiet to show first.
 */
export async function stats(viewerId: number, since: string): Promise<BotStats[]> {
  const { from, to } = await untilToday(viewerId, since);
  const daily = z.object({ botId: z.number(), day: z.string(), requests: z.number(), refused: z.number() }).array().parse(await sql`
    SELECT bot_id, day::text, requests, refused FROM bot_usage
     WHERE day BETWEEN ${from}::date AND ${to}::date
       AND bot_id IN (SELECT e.id FROM employee e
                       WHERE e.kind = 'bot' AND (e.manager_id = ${viewerId} OR e.manager_id IN (SELECT subordinates(${viewerId}))))
  `);
  const dates: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  const rows = BotStats.omit({ daily: true }).array().parse(await sql`
    WITH b AS (
      SELECT e.id, e.time_zone FROM bot JOIN employee e ON e.id = bot.employee_id
       WHERE e.manager_id = ${viewerId} OR e.manager_id IN (SELECT subordinates(${viewerId}))
    ),
    -- The range in each bot's own time zone.
    r AS (
      SELECT id, (${from}::date)::timestamp AT TIME ZONE time_zone AS since,
             (${to}::date + 1)::timestamp AT TIME ZONE time_zone AS until
        FROM b
    ),
    open_task AS (
      SELECT k.id, k.owner_id FROM task k
       WHERE NOT EXISTS (SELECT 1 FROM finished_at f WHERE f.task_id = k.id AND f.expired_at IS NULL AND f.confirmed_at IS NOT NULL)
    )
    SELECT b.id,
           (SELECT count(*) FROM open_task k WHERE k.owner_id = b.id)::int AS open_tasks,
           (SELECT count(*) FROM observer o JOIN open_task k ON k.id = o.task_id
             WHERE o.value = b.id AND o.added_at IS NOT NULL AND o.deleted_at IS NULL
               AND k.owner_id IS DISTINCT FROM b.id)::int AS observed_tasks,
           (SELECT count(*) FROM task k JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
             WHERE k.owner_id = b.id AND f.confirmed_at >= r.since AND f.confirmed_at < r.until)::int AS closed_tasks,
           (SELECT count(*) FROM comment c
             WHERE c.created_by = b.id AND c.created_at >= r.since AND c.created_at < r.until)::int AS comments,
           (SELECT count(*) FROM mention m JOIN comment c ON c.task_id = m.task_id AND c.id = m.comment_id
             WHERE c.created_by = b.id AND c.created_at >= r.since AND c.created_at < r.until)::int AS mentions,
           COALESCE(u.requests, 0)::int AS requests, COALESCE(u.refused, 0)::int AS refused,
           COALESCE(u.deliveries, 0)::int AS deliveries, COALESCE(u.failed_deliveries, 0)::int AS failed_deliveries,
           (SELECT max(last_request_at) FROM bot_usage WHERE bot_id = b.id) AS last_request_at
      FROM b
      JOIN r ON r.id = b.id
      LEFT JOIN (
        SELECT bot_id, sum(requests) AS requests, sum(refused) AS refused,
               sum(deliveries) AS deliveries, sum(failed_deliveries) AS failed_deliveries
          FROM bot_usage WHERE day BETWEEN ${from}::date AND ${to}::date
         GROUP BY bot_id
      ) u ON u.bot_id = b.id
  `);
  return rows.map((row) => ({
    ...row,
    daily: dates.map((day) => {
      const d = daily.find((x) => x.botId === row.id && x.day === day);
      return { day, requests: d?.requests ?? 0, refused: d?.refused ?? 0 };
    }),
  }));
}

/** Counts an attempt to post to the bot's webhook (count_bot_delivery()). */
export async function countDelivery(db: Sql, id: number, failed: boolean): Promise<void> {
  await db`SELECT count_bot_delivery(${id}, ${failed})`;
}
