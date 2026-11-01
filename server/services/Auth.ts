import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Employee, Locale } from '#shared/employee.ts';
import { deliver } from '../delivery.ts';
import { assertEmailAllowed } from '../domains.ts';
import { AppError } from '../errors.ts';
import env from '../env.ts';
import { sql } from '../pg.ts';
import * as Employees from './Employee.ts';

const Token = z.object({ token: z.string().nullable() });
const Session = z.object({ session: z.string().nullable() });
const EmployeeId = z.object({ id: z.number().nullable() });
const Recipient = Employee.pick({ id: true, fullName: true, timeZone: true })
  .extend({ email: z.string(), locale: Locale.catch('ru') });

/** A new key for a browser's cookie that sign-in links are bound to. */
export const newBrowserKey = () => randomBytes(32).toString('hex');

/**
 * Sends a sign-in link (email and/or webhook) right away, not through the
 * notification queue: the token must not lie in the database in plain text.
 * The link works only in the browser with this key (decision 101). Does
 * nothing for unknown or dismissed emails, so the caller cannot tell
 * whether the email exists.
 */
export async function requestLogin(email: string, browser: string): Promise<void> {
  if (env.OIDC_ISSUER) throw new AppError('sso_only');
  const [token] = Token.array().parse(await sql`SELECT issue_token(${email}, ${browser}) AS token`);
  if (!token?.token) return;

  const [employee] = Recipient.array().parse(await sql`
    SELECT id, email, full_name, locale, time_zone FROM employee WHERE email = ${email} AND dismissed_at IS NULL
  `);
  if (!employee) return;

  await deliver({
    to: { employeeId: employee.id, kind: 'human', email: employee.email, fullName: employee.fullName, locale: employee.locale, timeZone: employee.timeZone },
    taskId: null,
    payload: { kind: 'login', url: `${env.PUBLIC_URL}/login/${token.token}` },
  });
}

/**
 * Redeems a sign-in token in the browser that asked for it and returns a
 * new session token.
 * @throws invalid_token, login_other_browser
 */
export async function login(token: string, browser: string | null): Promise<string> {
  const [row] = Session.array().parse(await sql`SELECT login(${token}, ${browser}) AS session`);
  if (!row?.session) throw new AppError('invalid_token');
  return row.session;
}

/**
 * Employee id for a session token, or null; extends the session. With the
 * identity provider a session lasts a day from sign-in (decision 53).
 */
export async function authenticate(sessionToken: string): Promise<number | null> {
  const lifetime = env.OIDC_ISSUER ? '1 day' : null;
  const [row] = EmployeeId.array().parse(await sql`SELECT authenticate(${sessionToken}, ${lifetime}::interval) AS id`);
  return row?.id ?? null;
}

/** Who the identity provider let in (server/sso.ts). */
export type External = {
  sub: string;
  /**
   * Their address at the provider. Signing in, only one it vouches for,
   * inside the company's domains; waiting for confirmation, any — offered.
   */
  email: string | null;
  fullName: string;
  locale: Locale;
  timeZone: string;
  refreshToken: string | null;
};

/**
 * A session for someone the provider let in: known by their provider id,
 * or found once by the address it vouches for, or created with it
 * (sign_in_external()); null — they confirm their email first (decision 86).
 * @throws dismissed
 */
export async function signInExternal(p: External): Promise<string | null> {
  const [row] = Session.array().parse(await sql`
    SELECT sign_in_external(${p.sub}, ${p.email}, ${p.fullName}, ${p.locale}, ${p.timeZone}, ${p.refreshToken}) AS session
  `);
  return row?.session ?? null;
}

const Browser = z.object({ token: z.string() });

/** Keeps what the provider said until the email is confirmed; the token goes into the browser's cookie. */
export async function beginExternal(p: External): Promise<string> {
  const [row] = Browser.array().parse(await sql`
    SELECT begin_external_sign_in(${p.sub}, ${p.email}, ${p.fullName}, ${p.locale}, ${p.timeZone}, ${p.refreshToken}) AS token
  `);
  return row!.token;
}

const Pending = z.object({ email: z.string().nullable(), fullName: z.string(), sentTo: z.string().nullable() });
export type Pending = z.infer<typeof Pending>;

/** The sign-in of this browser waiting for an email, or null (none, or over an hour old). */
export async function pendingExternal(browser: string): Promise<Pending | null> {
  const [row] = Pending.array().parse(await sql`
    SELECT suggested_email AS email, full_name, email AS sent_to FROM external_sign_in
     WHERE hash = digest(${browser}, 'sha256') AND created_at > NOW() - INTERVAL '1 hour'
  `);
  return row ?? null;
}

const Asker = z.object({ fullName: z.string(), locale: Locale.catch('ru'), timeZone: z.string() });

/**
 * Sends the link that confirms the typed email, by email only: following
 * it in this browser signs them in as whoever works here with it, or as
 * someone new.
 * @throws sso_failed, email_not_allowed, too_many_requests
 */
export async function sendExternalEmail(browser: string, email: string): Promise<void> {
  assertEmailAllowed(email);
  const [row] = Token.array().parse(await sql`SELECT send_external_email(${browser}, ${email}) AS token`);
  const [asker] = Asker.array().parse(await sql`
    SELECT full_name, locale, time_zone FROM external_sign_in WHERE hash = digest(${browser}, 'sha256')
  `);
  await deliver({
    to: { employeeId: null, kind: 'human', email, fullName: asker!.fullName, locale: asker!.locale, timeZone: asker!.timeZone },
    taskId: null,
    payload: { kind: 'sso_email', url: `${env.PUBLIC_URL}/sso/${row!.token}`, email },
  });
}

/**
 * The link opened in the browser that signed in: a session.
 * @throws invalid_token, sso_other_browser, dismissed
 */
export async function confirmExternal(browser: string | null, token: string): Promise<string> {
  const [row] = Session.array().parse(await sql`SELECT confirm_external_email(${browser}, ${token}) AS session`);
  return row!.session!;
}

/** The demo: everyone who can sign in, in the order they joined. */
export async function demoPeople(): Promise<Employee[]> {
  return (await Employees.list()).filter((e) => e.dismissedAt === null && e.email !== null).sort((a, b) => a.id - b.id);
}

/**
 * The demo: a session for the employee, through the same one-time token a
 * link carries — issued and redeemed at once.
 */
export async function demoSignIn(employeeId: number): Promise<string> {
  const browser = newBrowserKey();
  const [token] = Token.array().parse(await sql`
    SELECT issue_token(email, ${browser}) AS token FROM employee WHERE id = ${employeeId} AND dismissed_at IS NULL
  `);
  if (!token?.token) throw new AppError('not_found');
  return login(token.token, browser);
}

export async function logout(sessionToken: string): Promise<void> {
  await sql`DELETE FROM session WHERE hash = digest(${sessionToken}, 'sha256')`;
}

export async function logoutEverywhere(employeeId: number): Promise<void> {
  await sql`DELETE FROM session WHERE employee_id = ${employeeId}`;
}
