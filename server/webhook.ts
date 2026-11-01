import { createHmac } from 'node:crypto';
import env from './env.ts';

/** The envelope's version: a receiver tells formats apart by it. */
export const WEBHOOK_VERSION = 1;

export type WebhookMessage = {
  kind: string;
  to: {
    employeeId: number;
    kind: 'human' | 'bot';
    /** NULL — no address (a bot never has one). */
    email: string | null;
    fullName: string;
    locale: string;
    timeZone: string;
  };
  taskId?: number | null;
  data: Record<string, unknown>;
};

/** Where to post and the key that signs the body. */
export type WebhookTarget = { url: string; secret: string };

// People's messages go to the company's webhook (WEBHOOK_URL): the delivery
// channel (email, Telegram, ...) and the text in the recipient's language
// are up to its receiver. A bot's go to its own (bot.webhook_url), signed
// with its own secret. Without WEBHOOK_URL a person's message is logged
// (development mode).
export async function sendWebhook(message: WebhookMessage, target?: WebhookTarget): Promise<void> {
  const body = JSON.stringify({ version: WEBHOOK_VERSION, ...message });
  const to = target ?? (env.WEBHOOK_URL ? { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET ?? '' } : null);

  if (!to) {
    console.log(`[webhook] ${body}`);
    return;
  }

  // The moment is signed with the body: a receiver refuses an old one, so a
  // request caught on the way cannot be sent to it again later.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', to.secret).update(`${timestamp}.${body}`).digest('hex');
  const response = await fetch(to.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-yartt-timestamp': timestamp,
      'x-yartt-signature': `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Webhook responded with ${response.status}`);
  }
}
