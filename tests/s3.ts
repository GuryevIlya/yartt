import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An S3-compatible storage for the tests: path-style PUT, GET and DELETE
 * of objects kept in memory. A request must be signed (SigV4) with the
 * given key, and a PUT must carry the hash of its body; `failing` makes it
 * answer 500, as a storage that is down.
 */
export async function fakeS3(accessKeyId: string) {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const state = { failing: false, requests: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.requests++;
      const body = Buffer.concat(chunks);
      const signed = String(req.headers.authorization ?? '').startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`);
      if (!signed) return res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
      if (state.failing) return res.writeHead(500).end('<Error><Code>InternalError</Code></Error>');
      const key = decodeURIComponent(req.url ?? '');
      if (req.method === 'PUT') {
        if (req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) {
          return res.writeHead(400).end('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
        }
        objects.set(key, { body, type: String(req.headers['content-type'] ?? '') });
        return res.writeHead(200).end();
      }
      if (req.method === 'GET') {
        const object = objects.get(key);
        if (!object) return res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
        return res.writeHead(200, { 'content-type': object.type, 'content-length': object.body.length }).end(object.body);
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return res.writeHead(204).end();
      }
      res.writeHead(405).end();
    });
  }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    endpoint: `http://localhost:${(server.address() as AddressInfo).port}`,
    objects,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
