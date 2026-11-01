import type { Locale } from '#shared/employee.ts';
import type { NotificationPayload } from '#shared/notification.ts';
import env from './env.ts';
import { mailEnabled, sendMail } from './mail.ts';
import { renderMail } from './services/Mail.ts';
import { sendWebhook, type WebhookTarget } from './webhook.ts';

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

/** Only by email: a link that proves the mailbox must not arrive anywhere else; a request about the address itself. */
const MAIL_ONLY = new Set<Payload['kind']>(['email_confirm', 'sso_email', 'email_changing', 'email_outside_domains']);

/** The webhook failed after the email went: a retry sends only to the webhook. */
export class DeliveryError extends Error {
  readonly mailed: boolean;
  constructor(mailed: boolean, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.mailed = mailed;
  }
}

export type Message = {
  to: Recipient;
  taskId: number | null;
  payload: Payload;
};

// Every outgoing message goes through here: an email in the recipient's
// language (SMTP_URL) and/or the webhook (WEBHOOK_URL) for other channels.
// With neither configured the message is logged (development mode). A bot
// gets JSON on its own webhook only.
export async function deliver(message: Message, options: { mail?: boolean } = {}): Promise<void> {
  const { kind, ...data } = message.payload;
  const { webhook, ...recipient } = message.to;
  // A webhook speaks of an employee; someone not here yet gets mail only.
  const to = recipient.employeeId === null ? null : { ...recipient, employeeId: recipient.employeeId };

  if (recipient.kind === 'bot') {
    if (webhook && to) await sendWebhook({ kind, to, taskId: message.taskId, data }, webhook);
    return;
  }

  let mailed = false;
  if (mailEnabled && message.to.email !== null && options.mail !== false) {
    const mail = await renderMail(message);
    await sendMail(message.to.email, mail.subject, mail.text);
    mailed = true;
  }
  if (env.WEBHOOK_URL && to && !MAIL_ONLY.has(kind)) {
    try {
      await sendWebhook({ kind, to, taskId: message.taskId, data });
    } catch (error) {
      throw new DeliveryError(mailed, error);
    }
  }
  if (!mailEnabled && (!env.WEBHOOK_URL || !to || MAIL_ONLY.has(kind))) {
    console.log(`[delivery] ${JSON.stringify({ kind, to: message.to.email, taskId: message.taskId, data })}`);
  }
}
