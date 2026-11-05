import type { Locale } from '#shared/employee.ts';
import type { NotificationPayload } from '#shared/notification.ts';
import { mailEnabled, sendMail } from './mail.ts';
import { renderMail } from './services/Mail.ts';
import { WEBHOOK_VERSION, sendWebhook, type WebhookTarget } from './webhook.ts';

export type Recipient = {
  /** NULL — nobody here yet: someone confirming their email on their first sign-in through the provider. */
  employeeId: number | null;
  kind: 'human' | 'bot';
  /** NULL — no address: the webhook only. */
  email: string | null;
  fullName: string;
  locale: Locale;
  /** Moments in emails are shown in it. */
  timeZone: string;
  /** A bot's own webhook; NULL — it has none, and gets nothing outside its bell. */
  webhook?: WebhookTarget | null;
};

/**
 * A notification from the queue, or a link that never touches the queue:
 * to sign in, or to confirm a new email (and the word to the old one).
 */
export type Payload = NotificationPayload
  | { kind: 'login'; url: string }
  | { kind: 'email_confirm'; url: string; email: string }
  | { kind: 'sso_email'; url: string; email: string }
  | { kind: 'email_changing'; email: string }
  | { kind: 'email_outside_domains'; url: string };

export type Message = {
  to: Recipient;
  taskId: number | null;
  payload: Payload;
};

// An email in the recipient's language (SMTP_URL); with none configured the
// message is logged (development mode). A bot gets JSON on its own webhook
// only. A link that proves a mailbox or signs someone in goes nowhere else:
// a person's webhooks get notifications only (services/Webhook.ts), from the worker.
export async function deliver(message: Message, options: { mail?: boolean } = {}): Promise<void> {
  const { kind, ...data } = message.payload;
  const { webhook, ...recipient } = message.to;
  if (recipient.kind === 'bot') {
    if (webhook && recipient.employeeId !== null) {
      await sendWebhook(JSON.stringify({
        version: WEBHOOK_VERSION, kind, to: { ...recipient, employeeId: recipient.employeeId }, taskId: message.taskId, data,
      }), webhook);
    }
    return;
  }
  if (mailEnabled && message.to.email !== null && options.mail !== false) {
    const mail = await renderMail(message);
    await sendMail(message.to.email, mail.subject, mail.text);
  } else if (!mailEnabled) {
    console.log(`[delivery] ${JSON.stringify({ kind, to: message.to.email, taskId: message.taskId, data })}`);
  }
}
