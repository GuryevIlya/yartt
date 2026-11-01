import { z } from 'zod';
import { Locale } from '#shared/employee.ts';
import { NotificationPayload } from '#shared/notification.ts';
import { refreshDemo } from './demo.ts';
import { outsideDomains } from './domains.ts';
import * as Bots from './services/Bot.ts';
import { checkPeople } from './sso.ts';
import { deliver } from './delivery.ts';
import env from './env.ts';
import type { Sql } from './pg.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Cron jobs from db.sql (CRON section).
const JOBS: { name: string; every: number; run: (sql: Sql) => Promise<unknown> }[] = [
  {
    name: 'send_due_reminds',
    every: MINUTE,
    run: (sql) => sql`SELECT send_due_reminds()`,
  },
  {
    name: 'token_cleanup',
    every: HOUR,
    run: (sql) => sql`
      DELETE FROM token
       WHERE sent_at < NOW() - CASE WHEN email IS NULL THEN INTERVAL '1 hour' ELSE INTERVAL '2 days' END
    `,
  },
  {
    name: 'external_sign_in_cleanup',
    every: HOUR,
    run: (sql) => sql`DELETE FROM external_sign_in WHERE created_at < NOW() - INTERVAL '1 hour'`,
  },
  {
    name: 'weekly_digests',
    every: HOUR,
    run: (sql) => sql`SELECT send_weekly_digests()`,
  },
  {
    name: 'session_cleanup',
    every: DAY,
    run: (sql) => sql`DELETE FROM session WHERE last_seen_at < NOW() - INTERVAL '30 days'`,
  },
  {
    name: 'notification_cleanup',
    every: DAY,
    run: (sql) => sql`DELETE FROM notification WHERE added_at < NOW() - INTERVAL '1 year'`,
  },
  {
    name: 'attachment_cleanup',
    every: DAY,
    run: (sql) => sql`
      DELETE FROM attachment a
       WHERE used_at < NOW() - INTERVAL '1 day'
         AND NOT attachment_in_use(a.id)
    `,
  },
  {
    name: 'visit_cleanup',
    every: DAY,
    run: (sql) => sql`DELETE FROM visit WHERE at < NOW() - INTERVAL '1 year'`,
  },
  {
    name: 'tag_cleanup',
    every: DAY,
    run: (sql) => sql`
      DELETE FROM tag t
       WHERE created_at < NOW() - INTERVAL '1 day'
         AND NOT EXISTS (SELECT 1 FROM task WHERE tag_ids @> ARRAY[t.id])
         AND NOT EXISTS (SELECT 1 FROM user_tag WHERE tag_id = t.id)
    `,
  },
  {
    name: 'idp_check',
    every: HOUR,
    run: (sql) => checkPeople(sql),
  },
  {
    name: 'bot_usage_cleanup',
    every: DAY,
    run: (sql) => sql`DELETE FROM bot_usage WHERE day < CURRENT_DATE - 366`,
  },
  {
    name: 'bot_key_reminders',
    every: DAY,
    run: (sql) => sql`SELECT send_bot_key_reminders()`,
  },
  {
    name: 'next_day_cleanup',
    every: DAY,
    run: (sql) => sql`UPDATE human SET next_day = NULL WHERE next_day <= local_today(employee_id)`,
  },
];

// A job runs under an advisory lock: with several instances only one runs it at a time.
async function runJob(sql: Sql, job: (typeof JOBS)[number]): Promise<void> {
  await sql.begin(async (tx) => {
    const [lock] = Lock.array().parse(await tx`
      SELECT pg_try_advisory_xact_lock(hashtext(${'yartt.job.' + job.name})) AS locked
    `);
    if (lock?.locked) await job.run(tx as unknown as Sql);
  });
}

const Lock = z.object({ locked: z.boolean() });

const PendingNotification = z.object({
  // BIGSERIAL: the driver returns int8 as a string.
  id: z.string(),
  employeeId: z.number(),
  taskId: z.number().nullable(),
  payload: z.unknown(),
  kind: z.enum(['human', 'bot']),
  email: z.string().nullable(),
  dismissed: z.boolean(),
  webhookUrl: z.string().nullable(),
  webhookSecret: z.string().nullable(),
  /** Asked to change an address outside the domains within the last day. */
  toldToday: z.boolean(),
  /** An earlier attempt sent the email, the webhook failed: only the webhook now. */
  mailed: z.boolean(),
  fullName: z.string(),
  // An unsupported language falls back to the default one.
  locale: Locale.catch('ru'),
  timeZone: z.string(),
});

const NextAttempt = z.object({ next: z.date().nullable() });

const BATCH_SIZE = 20;

/** The email went before the webhook failed (DeliveryError in delivery.ts). */
const mailedBefore = (error: unknown) => typeof error === 'object' && error !== null && 'mailed' in error && error.mailed === true;

// Delivers notifications (email and/or webhook) and returns how many were
// processed. FOR UPDATE SKIP LOCKED: several workers never take the same
// notification. A person's notification that fails waits aside for its
// next attempt (notification_failure, fail_notification() in db.sql) and
// the queue goes on: one broken address never holds the others. A bot's
// webhook is someone's program and may be down for days: it gets one
// attempt, a failure is logged and passed over. A payload that does not
// parse is logged and skipped, so it cannot block the queue. A deadline
// change is held until the deadline settles (deadline_settles() in db.sql).
// The demo's people are made up: there nothing goes out, the queue is only
// marked sent (the bell in the interface reads closed_at, not sent_at).
export async function deliverNotifications(sql: Sql): Promise<number> {
  if (env.DEMO_DATA) {
    await sql`UPDATE notification SET sent_at = NOW() WHERE sent_at IS NULL`;
    return 0;
  }
  return sql.begin(async (tx) => {
    const rows = PendingNotification.array().parse(await tx`
      SELECT n.id, n.employee_id, n.task_id, n.payload, e.kind, e.email, e.dismissed_at IS NOT NULL AS dismissed,
             e.full_name, e.locale, e.time_zone, b.webhook_url, b.webhook_secret,
             COALESCE(h.outside_domains_told_at > NOW() - INTERVAL '1 day', FALSE) AS told_today,
             COALESCE(f.mailed, FALSE) AS mailed
        FROM notification n
        JOIN employee e ON e.id = n.employee_id
        LEFT JOIN bot b ON b.employee_id = e.id
        LEFT JOIN human h ON h.employee_id = e.id
        LEFT JOIN notification_failure f ON f.notification_id = n.id
       WHERE n.sent_at IS NULL
         -- One that failed waits for its next attempt; a given-up one stays for the administrator.
         AND (f.notification_id IS NULL OR f.next_attempt_at <= NOW())
         -- A deadline change waits to settle: another one soon after replaces it.
         AND NOT (n.payload->>'kind' = 'finished_at_change' AND n.added_at > NOW() - deadline_settles())
       ORDER BY n.id
       LIMIT ${BATCH_SIZE}
         FOR UPDATE OF n SKIP LOCKED
    `);

    for (const row of rows) {
      // Dismissed after the notification was created: nobody to deliver to.
      const payload = NotificationPayload.safeParse(row.payload);
      if (!payload.success) {
        console.error(`[worker] notification ${row.id} has an invalid payload, skipped:`, payload.error.issues);
      } else if (!row.dismissed) {
        const webhook = row.webhookUrl ? { url: row.webhookUrl, secret: row.webhookSecret ?? '' } : null;
        const to = { employeeId: row.employeeId, kind: row.kind, email: row.email, fullName: row.fullName, locale: row.locale, timeZone: row.timeZone, webhook };
        // An address outside the company's domains gets no notifications by mail, only a
        // request to change it, at most once a day; the bell and the webhook still get them.
        const outside = row.kind === 'human' && outsideDomains(row.email);
        try {
          if (outside && !row.toldToday) {
            await deliver({ to, taskId: null, payload: { kind: 'email_outside_domains', url: `${env.PUBLIC_URL}/` } });
            await tx`UPDATE human SET outside_domains_told_at = NOW() WHERE employee_id = ${row.employeeId}`;
            for (const other of rows) if (other.employeeId === row.employeeId) other.toldToday = true;
          }
          await deliver({ to, taskId: row.taskId, payload: payload.data }, { mail: !outside && !row.mailed });
          if (webhook) await Bots.countDelivery(tx as unknown as Sql, row.employeeId, false);
          await tx`DELETE FROM notification_failure WHERE notification_id = ${row.id}`;
        } catch (error) {
          if (row.kind === 'human') {
            const reason = error instanceof Error ? error.message : String(error);
            const [attempt] = NextAttempt.array().parse(await tx`
              SELECT fail_notification(${row.id}, ${reason.slice(0, 1000)}, ${mailedBefore(error)}) AS next
            `);
            console.error(attempt?.next
              ? `[worker] notification ${row.id} delivery failed, next attempt at ${attempt.next.toISOString()}:`
              : `[worker] notification ${row.id} delivery failed for three days, given up:`, error);
            continue;
          }
          console.error(`[worker] notification ${row.id} delivery failed:`, error);
          if (webhook) await Bots.countDelivery(tx as unknown as Sql, row.employeeId, true);
        }
      }
      await tx`UPDATE notification SET sent_at = NOW() WHERE id = ${row.id}`;
    }
    return rows.length;
  });
}

export function startWorker(sql: Sql): () => void {
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  const guard = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((error) => console.error(`[worker] ${name} failed:`, error));
  };

  for (const job of JOBS) {
    const run = guard(job.name, () => runJob(sql, job));
    run();
    timers.push(setInterval(run, job.every));
  }

  // The demo is seeded afresh every night, so a stand left running keeps its days around today.
  const demo = env.DEMO_DATA;
  if (demo) timers.push(setInterval(guard('demo_refresh', () => refreshDemo(demo, 'night')), 10 * MINUTE));

  // Notification queue: no pause while there is work, otherwise poll every 2 seconds.
  const loop = async () => {
    while (!stopped) {
      let delivered = 0;
      try {
        delivered = await deliverNotifications(sql);
      } catch (error) {
        console.error('[worker] notification delivery failed:', error);
      }
      if (delivered < BATCH_SIZE) await new Promise((r) => setTimeout(r, 2_000));
    }
  };
  void loop();

  return () => {
    stopped = true;
    timers.forEach(clearInterval);
  };
}
