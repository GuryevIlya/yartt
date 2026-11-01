import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { z, ZodError } from 'zod';
import type { BotPermission } from '#shared/bot.ts';
import type { ErrorCode, ErrorData, ErrorIssue } from '#shared/errors.ts';
import type { Context } from './ctx.ts';
import { outsideDomains } from './domains.ts';
import env from './env.ts';
import { AppError, fromPostgres } from './errors.ts';
import * as Bots from './services/Bot.ts';
import { sql } from './pg.ts';

function errorData(error: TRPCError): ErrorData {
  const cause = error.cause;
  if (cause instanceof AppError) return { appCode: cause.code, params: cause.params };

  // Input validation: issues go to the client without English messages,
  // the client renders them in the user's language.
  if (error.code === 'BAD_REQUEST' && cause instanceof ZodError) {
    const issues = cause.issues.map(({ message: _message, input: _input, ...issue }) => issue as ErrorIssue);
    return { appCode: 'invalid_input', issues };
  }

  const byTrpcCode: Partial<Record<TRPCError['code'], ErrorCode>> = {
    UNAUTHORIZED: 'unauthorized',
    FORBIDDEN: 'forbidden',
    NOT_FOUND: 'not_found',
    BAD_REQUEST: 'invalid_input',
  };
  return { appCode: byTrpcCode[error.code] ?? 'internal' };
}

/**
 * `bot` — the permission a bot needs to call this mutation (db.sql,
 * bot_permission). A mutation without it is for people only; a query is
 * open to a bot, within what its relationships show it.
 */
export type Meta = {
  bot?: BotPermission;
  /** Open to a person whose email is outside the company's domains: they may only change it (decision 52). */
  outsideDomains?: true;
};

const t = initTRPC.context<Context>().meta<Meta>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const data = errorData(error);
    if (data.appCode === 'internal') console.error(error);
    return {
      ...shape,
      message: data.appCode,
      data: { code: shape.data.code, httpStatus: shape.data.httpStatus, path: shape.data.path, ...data },
    };
  },
});

const EmailRow = z.object({ email: z.string().nullable() });
const Recorded = z.object({ id: z.string() });

function toTrpcError(cause: AppError): TRPCError {
  const code =
    cause.code === 'forbidden' || cause.code === 'bot_not_permitted' || cause.code === 'email_outside_domains' ? 'FORBIDDEN'
    : cause.code === 'not_found' ? 'NOT_FOUND'
    : cause.code === 'unauthorized' ? 'UNAUTHORIZED'
    : 'BAD_REQUEST';
  return new TRPCError({ code, message: cause.code, cause });
}

// Business errors (AppError and Postgres errors) -> code the client understands.
const mapErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    const appError = cause instanceof AppError ? cause : fromPostgres(cause);
    if (appError) throw toTrpcError(appError);
  }
  return result;
});

/** What a bot was refused for: it is set up wrong, or broken. */
const REFUSALS = new Set<ErrorCode>(['bot_not_permitted', 'forbidden', 'no_access', 'not_manager']);

// Every call with a bot's key is counted for its manager (bot_usage), after
// the call and outside its transaction, so a refused one counts too. A
// failed count never fails the call.
const countBot = t.middleware(async ({ ctx, next }) => {
  const result = await next();
  if (ctx.bot && ctx.employeeId !== null) {
    const cause = result.ok ? null : result.error.cause;
    const code = cause instanceof AppError ? cause.code : fromPostgres(cause)?.code ?? null;
    await Bots.countRequest(ctx.employeeId, code !== null && REFUSALS.has(code))
      .catch((error: unknown) => console.error('[bot] counting a request failed:', error));
  }
  return result;
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Available without a session. */
export const procedure = t.procedure.use(mapErrors).use(countBot);

/**
 * Requires a session or a bot's key; `ctx.employeeId` is the signed-in
 * employee. A bot changes only what its permissions allow (Meta).
 */
export const authedProcedure = procedure.use(({ ctx, meta, type, next }) => {
  if (ctx.employeeId === null) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  if (ctx.bot && type === 'mutation' && !(meta?.bot && ctx.bot.includes(meta.bot))) {
    throw new AppError('bot_not_permitted', { permission: meta?.bot ?? null });
  }
  return next({ ctx: { ...ctx, employeeId: ctx.employeeId } });
}).use(async ({ ctx, meta, next }) => {
  // Someone whose email is outside the company's domains may only change it.
  if (env.EMAIL_DOMAINS.length && !ctx.bot && !meta?.outsideDomains) {
    const [row] = EmailRow.array().parse(await sql`SELECT email FROM employee WHERE id = ${ctx.employeeId}`);
    if (outsideDomains(row?.email ?? null)) throw new AppError('email_outside_domains');
  }
  return next();
}).use(async ({ ctx, type, next }) => {
  // A change the outbox sends again, its answer lost on the way, is applied
  // once (decision 103): its id is kept before it runs, dropped if it fails.
  if (type !== 'mutation' || ctx.changeId === null) return next();
  const recorded = Recorded.array().parse(await sql`
    INSERT INTO sent_change (id, employee_id) VALUES (${ctx.changeId}, ${ctx.employeeId})
    ON CONFLICT (id) DO NOTHING RETURNING id
  `);
  if (recorded.length === 0) throw new AppError('change_applied');
  const result = await next();
  if (!result.ok) await sql`DELETE FROM sent_change WHERE id = ${ctx.changeId}`;
  return result;
});
