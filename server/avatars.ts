import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import ctx from './ctx.ts';
import env from './env.ts';
import { sql } from './pg.ts';

// Avatars go around tRPC, like attachments: raw bytes.
//   PUT    /api/avatars        (body: the image)  — mine, replaces it
//   DELETE /api/avatars                           — mine, back to the initials
//   GET    /api/avatars/:employeeId[?v=<time>]    — anyone signed in; in the demo anyone (the picker shows them)
// The client crops and scales the picture; the server only checks the type
// and the size. SVG is refused: it can carry scripts.

const MAX_SIZE = 512 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AvatarRow = z.object({ value: z.instanceof(Buffer), mime: z.string(), updatedAt: z.date() });

async function employeeId(req: Request, res: Response): Promise<number | null> {
  const context = await ctx(req, res, { bots: true });
  if (context.employeeId === null) res.status(401).json({ appCode: 'unauthorized' });
  return context.employeeId;
}

export default Router()
  .put('/', express.raw({ type: () => true, limit: MAX_SIZE }), async (req, res) => {
    const id = await employeeId(req, res);
    if (id === null) return;
    const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!TYPES.has(mime) || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ appCode: 'invalid_input' });
      return;
    }
    await sql`
      INSERT INTO avatar (employee_id, value, mime) VALUES (${id}, ${req.body}, ${mime})
      ON CONFLICT (employee_id) DO UPDATE SET value = EXCLUDED.value, mime = EXCLUDED.mime, updated_at = NOW()
    `;
    res.status(204).end();
  })
  .delete('/', async (req, res) => {
    const id = await employeeId(req, res);
    if (id === null) return;
    await sql`DELETE FROM avatar WHERE employee_id = ${id}`;
    res.status(204).end();
  })
  .get('/:employeeId', async (req, res) => {
    if (!env.DEMO_DATA && (await employeeId(req, res)) === null) return;
    const target = Number(req.params.employeeId);
    const [row] = Number.isInteger(target)
      ? AvatarRow.array().parse(await sql`SELECT value, mime, updated_at FROM avatar WHERE employee_id = ${target}`)
      : [];
    if (!row) {
      res.status(404).json({ appCode: 'not_found' });
      return;
    }
    res
      .set({
        'Content-Type': row.mime,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        // The URL carries ?v=<updated_at>: a new picture is a new URL.
        'Cache-Control': 'private, max-age=31536000, immutable',
      })
      .send(row.value);
  });
