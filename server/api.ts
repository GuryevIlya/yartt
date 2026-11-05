import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { Router } from 'express';
import attachments from './attachments.ts';
import avatars from './avatars.ts';
import ctx from './ctx.ts';
import { sql } from './pg.ts';
import publicApi from './publicApi.ts';
import sso from './sso.ts';
import trpc from './trpc/index.ts';

export default Router()
  // For Docker's HEALTHCHECK and load balancers: up, and the database answers. No sign-in.
  .get('/health', async (_req, res) => {
    try {
      await sql`SELECT 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  })
  .use('/trpc', createExpressMiddleware({ router: trpc, createContext: ({ req, res }) => ctx(req, res) }))
  .use('/v1', publicApi)
  .use('/sso', sso)
  .use('/attachments', attachments)
  .use('/avatars', avatars);
