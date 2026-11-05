import { z } from 'zod';
import { Id } from './employee.ts';
import type { NotificationPayload } from './notification.ts';

/** What a person's webhook gets of an event: nothing, that it happened with a link, the title too, the whole text. */
export const WebhookLevel = z.enum(['off', 'event', 'title', 'text']);
export type WebhookLevel = z.infer<typeof WebhookLevel>;

export const WEBHOOK_GROUPS = ['mentions', 'comments', 'deadlines', 'links', 'access', 'handover', 'reminders', 'scores', 'other'] as const;
export type WebhookGroup = (typeof WEBHOOK_GROUPS)[number];

/** For each group of events, how much is sent. */
export const WebhookLevels = z.object(
  Object.fromEntries(WEBHOOK_GROUPS.map((g) => [g, WebhookLevel])) as Record<WebhookGroup, typeof WebhookLevel>,
);
export type WebhookLevels = z.infer<typeof WebhookLevels>;

const GROUP: Partial<Record<NotificationPayload['kind'], WebhookGroup>> = {
  mention: 'mentions',
  comment: 'comments',
  task_mention: 'comments',
  finished_at_change: 'deadlines',
  dependency_added: 'links',
  dependency_done: 'links',
  waiter_closed: 'links',
  waits_added: 'links',
  access_request: 'access',
  access_opened: 'access',
  access_closed: 'access',
  owner_change: 'handover',
  owner_handed: 'handover',
  remind: 'reminders',
  score: 'scores',
};
export const webhookGroup = (kind: NotificationPayload['kind']): WebhookGroup => GROUP[kind] ?? 'other';

export const WebhookInput = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2000),
  levels: WebhookLevels,
});
export type WebhookInput = z.infer<typeof WebhookInput>;

export const Webhook = WebhookInput.extend({
  id: Id,
  /** Signs each body; a receiver may check it. The address itself is secret too. */
  secret: z.string(),
  /** The last attempt. */
  lastAt: z.date().nullable(),
  /** What it failed with; NULL — it went through, or none yet. */
  lastError: z.string().nullable(),
});
export type Webhook = z.infer<typeof Webhook>;
