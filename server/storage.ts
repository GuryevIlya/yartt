import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AwsClient } from 'aws4fetch';
import env from './env.ts';

// Files in an S3-compatible object storage (AWS, Yandex Object Storage,
// MinIO, ...), when S3_BUCKET is set: the content of an attachment is the
// object attachments/<id>, the database keeps everything else. Without it
// files stay in PostgreSQL (attachment.value). Path-style addresses:
// <S3_ENDPOINT>/<bucket>/<key>, which every such storage understands.

let cached: { settings: string; client: AwsClient } | null = null;

/** True when files go to the object storage (S3_BUCKET). */
export const storageEnabled = () => !!env.S3_BUCKET;

const keyOf = (attachmentId: number) => `attachments/${attachmentId}`;

function urlOf(attachmentId: number): string {
  const endpoint = env.S3_ENDPOINT.replace(/\/+$/, '');
  return `${endpoint}/${encodeURIComponent(env.S3_BUCKET!)}/${keyOf(attachmentId)}`;
}

function s3(): AwsClient {
  if (!env.S3_BUCKET) throw new Error('S3_BUCKET is not configured');
  const settings = [env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY, env.S3_REGION].join('\n');
  if (cached?.settings !== settings) {
    cached = {
      settings,
      client: new AwsClient({
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
        service: 's3',
        region: env.S3_REGION,
        retries: 2,
      }),
    };
  }
  return cached.client;
}

async function failed(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  return new Error(`S3 ${what} answered ${response.status}: ${body.slice(0, 300)}`);
}

/** Stores the content of an attachment; the same id again replaces it. */
export async function put(attachmentId: number, value: Buffer, mime: string): Promise<void> {
  const response = await s3().fetch(urlOf(attachmentId), {
    method: 'PUT',
    body: value as Uint8Array<ArrayBuffer>,
    // The storage checks the body against its hash: a file damaged on the way is refused.
    headers: { 'content-type': mime, 'content-length': String(value.length), 'x-amz-content-sha256': createHash('sha256').update(value).digest('hex') },
  });
  if (!response.ok) throw await failed(response, `PUT ${keyOf(attachmentId)}`);
}

/** The content of an attachment as a stream, read as it is sent on. */
export async function get(attachmentId: number): Promise<Readable> {
  const response = await s3().fetch(urlOf(attachmentId));
  if (!response.ok || !response.body) throw await failed(response, `GET ${keyOf(attachmentId)}`);
  return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
}

/** Deletes the content of an attachment; one already gone is no error. */
export async function remove(attachmentId: number): Promise<void> {
  const response = await s3().fetch(urlOf(attachmentId), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw await failed(response, `DELETE ${keyOf(attachmentId)}`);
}
