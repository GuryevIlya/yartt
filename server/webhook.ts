import { createHmac } from 'node:crypto';
import { lookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
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

const TIMEOUT_MS = 10_000;

// Addresses a bot's webhook never reaches: the server's own, the company's
// network, the cloud's metadata service. Any employee may set a bot's URL,
// and it must not become a way to make the server call inside.
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) PRIVATE.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) PRIVATE.addSubnet(network, prefix, 'ipv6');

/** An address inside: private, loopback, link-local, reserved (an IPv4 one written as IPv6 too). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return PRIVATE.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, 'ipv4');
  }
  const family = isIP(address);
  return family === 0 || PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

class PrivateAddressError extends Error {}

/**
 * Resolves as usual, refusing a name that leads inside. Checked at the
 * connection itself, so a name that resolved outside a moment ago cannot
 * lead inside now.
 */
const publicOnly: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true } as LookupAllOptions, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, '', 0);
    const inside = addresses.find((a) => isPrivateAddress(a.address));
    if (inside) return callback(new PrivateAddressError(`${hostname} resolves to ${inside.address}, inside the network`), '', 0);
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/** POSTs the body; only to an outside address unless `anywhere`. Resolves with the status. */
function post(url: URL, headers: Record<string, string>, body: string, anywhere: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const allowed = anywhere;
    if (!allowed && isIP(host) && isPrivateAddress(host)) {
      reject(new PrivateAddressError(`${host} is inside the network`));
      return;
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      timeout: TIMEOUT_MS,
      ...(!allowed && { lookup: publicOnly }),
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('timeout', () => request.destroy(new Error(`Webhook did not answer in ${TIMEOUT_MS / 1000} s`)));
    request.on('error', reject);
    request.end(body);
  });
}

/**
 * May a webhook go there? With WEBHOOK_ALLOWED_URLS only to what it lists,
 * inside the network too: host and port as written (any port if none is) and
 * the path from its start, so "corp.local.evil.com" or "corp.local@evil.com"
 * never pass for "corp.local". Without it, anywhere outside the network, which
 * is checked at the connection.
 */
export function webhookListed(address: URL): boolean {
  return env.WEBHOOK_ALLOWED_URLS.some((allowed) => {
    const prefix = new URL(allowed);
    return prefix.protocol === address.protocol && prefix.hostname === address.hostname
      && (prefix.port === '' || prefix.port === address.port)
      && address.pathname.startsWith(prefix.pathname) && address.username === '' && address.password === '';
  });
}

/** May this address be saved as a webhook? */
export function webhookAllowed(address: string): boolean {
  return env.WEBHOOK_ALLOWED_URLS.length === 0 || webhookListed(new URL(address));
}

/**
 * POSTs a signed body: a bot's message to its webhook, or a person's to theirs.
 * The moment is signed with the body: a receiver refuses an old one, so a
 * request caught on the way cannot be sent to it again later.
 */
export async function sendWebhook(body: string, to: WebhookTarget): Promise<void> {
  const url = new URL(to.url);
  const listed = webhookListed(url);
  if (env.WEBHOOK_ALLOWED_URLS.length > 0 && !listed) throw new Error(`${url.host} is not among the allowed webhook addresses`);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', to.secret).update(`${timestamp}.${body}`).digest('hex');
  const status = await post(url, {
    'content-type': 'application/json',
    'x-yartt-timestamp': timestamp,
    'x-yartt-signature': `sha256=${signature}`,
  }, body, listed);
  if (status < 200 || status >= 300) throw new Error(`Webhook responded with ${status}`);
}
