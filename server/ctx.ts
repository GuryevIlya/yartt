import type { Request, Response } from 'express';
import { parse as parseCookie } from 'cookie';
import env from './env.ts';
import type { BotPermission } from '#shared/bot.ts';
import * as Auth from './services/Auth.ts';
import * as Bots from './services/Bot.ts';

const SESSION_COOKIE = 'yartt_session';
// The session expires on inactivity (30 days, see db.sql); the cookie lives
// as long as browsers allow, the server decides when it is over.
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
// A first sign-in through the provider waits for the email to be confirmed
// in this browser (decision 86): an hour, as in the database.
const SSO_PENDING_COOKIE = 'yartt_sso_pending';
const SSO_PENDING_MAX_AGE_MS = 60 * 60 * 1000;
// The browser that asks for a sign-in link keeps a key here: the link signs
// in only where it was asked for (decision 101), for its 10 minutes.
const LOGIN_BROWSER_COOKIE = 'yartt_login';
const LOGIN_BROWSER_MAX_AGE_MS = 15 * 60 * 1000;

export type Context = {
  employeeId: number | null;
  /** A bot's permissions when its key signed the request; NULL — a person or nobody. */
  bot: BotPermission[] | null;
  sessionToken: string | null;
  setSessionCookie: (token: string) => void;
  clearSessionCookie: () => void;
  /** The browser's first sign-in through the provider, waiting for the email (Auth.beginExternal). */
  ssoPending: string | null;
  setSsoPendingCookie: (token: string) => void;
  clearSsoPendingCookie: () => void;
  /** The key of the browser that asked for sign-in links (Auth.requestLogin). */
  loginBrowser: string | null;
  setLoginBrowserCookie: (key: string) => void;
};

export default async function ctx(req: Request, res: Response): Promise<Context> {
  // A bot sends its key; a browser has the session cookie.
  const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
  const cookies = parseCookie(req.headers.cookie ?? '');
  const sessionToken = bearer ? null : cookies[SESSION_COOKIE] ?? null;
  const bot = bearer ? await Bots.authenticate(bearer) : null;
  const employeeId = bearer ? bot?.id ?? null
    : sessionToken ? await Auth.authenticate(sessionToken) : null;

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.COOKIE_SECURE,
    path: '/',
  };

  return {
    employeeId,
    bot: bot?.permissions ?? null,
    sessionToken,
    setSessionCookie: (token) => res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: COOKIE_MAX_AGE_MS }),
    clearSessionCookie: () => res.clearCookie(SESSION_COOKIE, cookieOptions),
    ssoPending: bearer ? null : cookies[SSO_PENDING_COOKIE] ?? null,
    setSsoPendingCookie: (token) => res.cookie(SSO_PENDING_COOKIE, token, { ...cookieOptions, maxAge: SSO_PENDING_MAX_AGE_MS }),
    clearSsoPendingCookie: () => res.clearCookie(SSO_PENDING_COOKIE, cookieOptions),
    loginBrowser: bearer ? null : cookies[LOGIN_BROWSER_COOKIE] ?? null,
    setLoginBrowserCookie: (key) => res.cookie(LOGIN_BROWSER_COOKIE, key, { ...cookieOptions, maxAge: LOGIN_BROWSER_MAX_AGE_MS }),
  };
}
