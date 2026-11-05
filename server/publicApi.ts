import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { TRPCError } from '@trpc/server';
import express, { Router, type Request, type Response } from 'express';
import { marked } from 'marked';
import { z } from 'zod';
import type { ApiRight } from '#shared/apiKey.ts';
import { FeedFilter, Feed } from '#shared/comment.ts';
import { Employee, Id } from '#shared/employee.ts';
import { History } from '#shared/myDay.ts';
import { SearchInput, SearchResult, TaskPage } from '#shared/task.ts';
import { Member, PeriodStats } from '#shared/team.ts';
import { TodoItem, WaitingItem } from '#shared/myDay.ts';
import type { Context } from './ctx.ts';
import env from './env.ts';
import { AppError, fromPostgres } from './errors.ts';
import * as ApiKeys from './services/ApiKey.ts';
import * as Bots from './services/Bot.ts';
import trpc from './trpc/index.ts';
import { createCallerFactory } from './trpc.ts';

// The public API (decision 111): what a program may ask for with a key. It is
// a promise, so it is a list of its own, kept apart from the interface's tRPC,
// which may change with any release. Every route runs the interface's procedure,
// so the rules and the bots' permissions are the same; the list only says what is
// on offer. Writing shifts, time entries and scores is not, and neither is
// anything about keys, webhooks, profiles or dismissals.

const createCaller = createCallerFactory(trpc);
type Caller = ReturnType<typeof createCaller>;

const Param = z.coerce.number().int().positive();
const Page = z.coerce.number().int().min(1).default(1);
const Day = z.iso.date();
/** A text comes as sanitized HTML would, or in Markdown, which language models write. */
const Text = z.object({ html: z.string().min(1).optional(), markdown: z.string().min(1).optional() });
const textOf = (t: z.infer<typeof Text>): string | undefined =>
  t.markdown !== undefined ? marked.parse(t.markdown, { async: false }) : t.html;

type Route = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  /** What a person's key needs. A bot's permissions are checked by the procedure; `reports.read` is for people only. */
  right: ApiRight | null;
  input?: z.ZodType;
  output?: z.ZodType;
  run: (api: Caller, input: never) => Promise<unknown>;
};

/** Keeps the input's type between the schema and the call. */
function route<I extends z.ZodType>(r: Omit<Route, 'input' | 'run'> & { input: I; run: (api: Caller, input: z.output<I>) => Promise<unknown> }): Route {
  return r as unknown as Route;
}

const TaskId = z.object({ id: Param });

export const ROUTES: Route[] = [
  route({
    method: 'get', path: '/me', summary: 'Who this key acts as.', right: null, input: z.object({}),
    run: (api) => api.Auth.me(),
  }),
  route({
    method: 'get', path: '/employees', summary: 'Everyone in the company.', right: 'tasks.read', input: z.object({}), output: Employee.array(),
    run: (api) => api.Employee.list(),
  }),
  route({
    method: 'post', path: '/tasks/search', summary: 'Tasks by tags, in the tabs of My day.', right: 'tasks.read', input: SearchInput, output: SearchResult,
    run: (api, input) => api.Task.search(input),
  }),
  route({
    method: 'get', path: '/tasks/:id', summary: 'A task; what is inside only if the key\'s owner sees it.', right: 'tasks.read', input: TaskId, output: TaskPage,
    run: (api, input) => api.Task.get(input),
  }),
  route({
    method: 'post', path: '/tasks', summary: 'A new private task owned by the key\'s owner. `waitsFor` and `waitedOnBy` link it.', right: 'tasks.write',
    input: z.object({
      tags: z.string().array().min(1).max(20),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
      deadline: z.coerce.date().nullable().optional(),
      waitsFor: Id.optional(),
      waitedOnBy: Id.optional(),
      participants: Id.array().max(100).optional(),
    }).extend(Text.shape),
    output: Id,
    run: (api, { html, markdown, ...rest }) => api.Task.create({ ...rest, context: textOf({ html, markdown }) ?? null }),
  }),
  route({
    method: 'patch', path: '/tasks/:id', summary: 'The owner changes tags, priority or context.', right: 'tasks.write',
    input: TaskId.extend({
      tags: z.string().array().min(1).max(20).optional(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
    }).extend(Text.shape),
    run: (api, { html, markdown, ...rest }) => {
      const context = textOf({ html, markdown });
      return api.Task.update({ ...rest, ...(context !== undefined && { context }) });
    },
  }),
  route({
    method: 'put', path: '/tasks/:id/deadline', summary: 'The owner sets, moves or clears the deadline. Moving it opens a closed task.', right: 'tasks.write',
    input: TaskId.extend({ deadline: z.coerce.date().nullable() }),
    run: (api, input) => api.Task.setDeadline(input),
  }),
  route({
    method: 'post', path: '/tasks/:id/close', summary: 'The owner closes the task.', right: 'tasks.write', input: TaskId,
    run: (api, input) => api.Task.close(input),
  }),
  route({
    method: 'post', path: '/tasks/:id/transfer', summary: 'Hands the task over whole.', right: 'tasks.write', input: TaskId.extend({ ownerId: Id }),
    run: (api, input) => api.Task.transfer(input),
  }),
  route({
    method: 'get', path: '/tasks/:id/comments', summary: 'The comments of a task, page by page.', right: 'tasks.read',
    input: TaskId.extend({ filter: FeedFilter.default('all'), page: Page }),
    output: Feed,
    run: (api, { id, filter, page }) => api.Comment.list({ taskId: id, filter, page }),
  }),
  route({
    method: 'post', path: '/tasks/:id/comments', summary: 'A comment, in HTML or Markdown; `mentionIds` puts it in their Waiting for me.', right: 'comments.write',
    input: TaskId.extend({
      replyToId: Id.nullable().default(null),
      mentionIds: Id.array().max(50).default([]),
      everyone: z.boolean().default(false),
      exceptIds: Id.array().max(50).default([]),
      taskIds: Id.array().max(50).default([]),
      files: z.object({ id: Id, name: z.string().trim().min(1).max(255) }).array().max(50).default([]),
    }).extend(Text.shape),
    output: Id,
    run: (api, { id, html, markdown, ...rest }) => api.Comment.create({ ...rest, taskId: id, html: textOf({ html, markdown }) ?? '' }),
  }),
  route({
    method: 'post', path: '/tasks/:id/comments/:commentId/close', summary: 'Closes the key\'s owner\'s mention in a comment.', right: 'comments.write',
    input: TaskId.extend({ commentId: Param }),
    run: (api, { id, commentId }) => api.Comment.closeMention({ taskId: id, commentId }),
  }),
  route({
    method: 'put', path: '/tasks/:id/participants/:employeeId', summary: 'Brings someone into the task.', right: 'participants.write',
    input: TaskId.extend({ employeeId: Param }),
    run: (api, { id, employeeId }) => api.Observer.add({ taskId: id, employeeId }),
  }),
  route({
    method: 'delete', path: '/tasks/:id/participants/:employeeId', summary: 'The owner removes a participant.', right: 'participants.write',
    input: TaskId.extend({ employeeId: Param }),
    run: (api, { id, employeeId }) => api.Observer.remove({ taskId: id, employeeId }),
  }),
  route({
    method: 'put', path: '/tasks/:id/waits-for/:value', summary: 'This task waits for another; the latest deadline is its owner\'s alone.', right: 'tasks.write',
    input: TaskId.extend({ value: Param, latestAt: z.coerce.date().nullable().default(null) }),
    run: (api, { id, value, latestAt }) => api.Dependency.set({ taskId: id, value, latestAt }),
  }),
  route({
    method: 'delete', path: '/tasks/:id/waits-for/:value', summary: 'Removes the link.', right: 'tasks.write',
    input: TaskId.extend({ value: Param }),
    run: (api, { id, value }) => api.Dependency.remove({ taskId: id, value }),
  }),
  route({
    method: 'get', path: '/waiting-for-me', summary: 'What waits for the key\'s owner: Waiting for me.', right: 'tasks.read', input: z.object({}), output: TodoItem.array(),
    run: (api) => api.MyDay.todo({}),
  }),
  route({
    method: 'get', path: '/waiting-for-others', summary: 'What the key\'s owner waits for from others.', right: 'tasks.read', input: z.object({}), output: WaitingItem.array(),
    run: (api) => api.MyDay.waiting({}),
  }),
  route({
    method: 'get', path: '/days', summary: 'The key\'s owner\'s past days: shifts, time entries, scores.', right: 'reports.read',
    input: z.object({ page: Page, size: z.coerce.number().int().min(1).max(100).default(30) }),
    output: History,
    run: (api, input) => api.MyDay.history(input),
  }),
  route({
    method: 'get', path: '/team', summary: 'The key\'s owner\'s people over a range of days.', right: 'reports.read',
    input: z.object({ from: Day, to: Day }), output: Member.array(),
    run: (api, input) => api.Team.summary(input),
  }),
  route({
    method: 'get', path: '/employees/:id/stats', summary: 'A person\'s figures over a range of days, for their manager or themselves.', right: 'reports.read',
    input: z.object({ id: Param, from: Day, to: Day }), output: PeriodStats,
    run: (api, { id, ...range }) => api.Team.stats({ employeeId: id, ...range }),
  }),
  route({
    method: 'get', path: '/employees/:id/days', summary: 'A person\'s past days, for their manager.', right: 'reports.read',
    input: z.object({ id: Param, page: Page, size: z.coerce.number().int().min(1).max(100).default(30) }), output: History,
    run: (api, { id, ...rest }) => api.Team.history({ employeeId: id, ...rest }),
  }),
];

/** The API's description, from the very schemas that check its calls. */
export function openApi(): object {
  const schema = (type: z.ZodType, io: 'input' | 'output') => z.toJSONSchema(type, {
    io,
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      if ((zodSchema as { _zod?: { def?: { type?: string } } })._zod?.def?.type === 'date') {
        jsonSchema.type = 'string';
        jsonSchema.format = 'date-time';
      }
    },
  });
  const paths: Record<string, Record<string, object>> = {};
  for (const r of ROUTES) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const names = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
    (paths[path] ??= {})[r.method] = {
      summary: r.summary,
      ...(r.right && { 'x-right': r.right }),
      parameters: names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'integer' } })),
      ...(r.input && r.method !== 'get' && r.method !== 'delete'
        ? { requestBody: { content: { 'application/json': { schema: schema(r.input, 'input') } } } }
        : r.input ? { 'x-query': schema(r.input, 'input') } : {}),
      responses: {
        200: r.output
          ? { description: 'OK', content: { 'application/json': { schema: schema(r.output, 'output') } } }
          : { description: 'OK, or 204 with nothing to say' },
        '4xx': { description: '{ "error": { "code": "<one of shared/errors.ts>", "params": {}, "issues": [] } }' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'yartt', version: '1' },
    servers: [{ url: `${env.PUBLIC_URL}/api/v1` }],
    security: [{ key: [] }],
    components: { securitySchemes: { key: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}

function refuse(res: Response, status: number, code: string, extra: object = {}): void {
  res.status(status).json({ error: { code, ...extra } });
}

type Authenticated = { employeeId: number; bot: Context['bot']; rights: ApiRight[] | null };

async function authenticate(req: Request): Promise<Authenticated | null> {
  const key = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!key) return null;
  const person = await ApiKeys.authenticate(key);
  if (person) return { employeeId: person.employeeId, bot: null, rights: person.rights };
  const bot = await Bots.authenticate(key);
  return bot ? { employeeId: bot.id, bot: bot.permissions, rights: null } : null;
}

const context = (who: Authenticated): Context => ({
  employeeId: who.employeeId,
  bot: who.bot,
  sessionToken: null,
  setSessionCookie: () => {},
  clearSessionCookie: () => {},
  ssoPending: null,
  setSsoPendingCookie: () => {},
  clearSsoPendingCookie: () => {},
  changeId: null,
  loginBrowser: null,
  setLoginBrowserCookie: () => {},
});

const api = Router().use(express.json({ limit: '2mb' }));

api.get('/openapi.json', (_req, res) => { res.json(openApi()); });

for (const r of ROUTES) {
  api[r.method](r.path, async (req, res) => {
    const who = await authenticate(req);
    if (!who) return refuse(res, 401, 'unauthorized');
    if (who.rights ? r.right !== null && !who.rights.includes(r.right) : r.right === 'reports.read') {
      return refuse(res, 403, who.rights ? 'key_not_permitted' : 'bot_not_permitted', { params: { permission: r.right } });
    }
    const input = (r.input ?? z.object({})).safeParse({ ...req.query, ...(req.body as object | undefined), ...req.params });
    if (!input.success) return refuse(res, 400, 'invalid_input', { issues: input.error.issues.map(({ path, code }) => ({ path, code })) });
    try {
      const result = await r.run(createCaller(context(who)), input.data as never);
      if (result === undefined) return res.status(204).end();
      return res.json(result);
    } catch (error) {
      const cause = error instanceof TRPCError ? error.cause : error;
      const app = cause instanceof AppError ? cause : fromPostgres(cause);
      if (app) return refuse(res, error instanceof TRPCError ? getHTTPStatusCodeFromError(error) : 400, app.code, { params: app.params });
      if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR') return refuse(res, getHTTPStatusCodeFromError(error), error.message);
      console.error(`[api] ${r.method} ${r.path}:`, error);
      return refuse(res, 500, 'internal');
    }
  });
}
api.use((_req, res) => refuse(res, 404, 'not_found'));

export default api;
