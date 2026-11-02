import { Router, type Response } from 'express';
import { parse as parseCookie } from 'cookie';
import * as client from 'openid-client';
import { z } from 'zod';
import { LOCALES, type Locale } from '#shared/employee.ts';
import { isErrorCode, type ErrorCode } from '#shared/errors.ts';
import ctx from './ctx.ts';
import { emailAllowed } from './domains.ts';
import env from './env.ts';
import { AppError, fromPostgres } from './errors.ts';
import type { Sql } from './pg.ts';
import * as Auth from './services/Auth.ts';

// Sign-in through the company's identity provider, OpenID Connect with the
// authorization code and PKCE (decision 53). Around tRPC, like files: it is
// a pair of browser redirects.
//   GET /api/sso/start[?next=/tasks/12] -> the provider
//   GET /api/sso/callback               -> a session cookie, back to `next`;
//                                          someone new -> /sso, to confirm their email
// A failure comes back to /login?error=<code>.

const FLOW_COOKIE = 'yartt_sso';
const FLOW_MAX_AGE_MS = 10 * 60 * 1000;
const CALLBACK_PATH = '/api/sso/callback';

/** Enabled by OIDC_ISSUER: then it is the only way in. */
export const ssoEnabled = () => !!env.OIDC_ISSUER;

let discovered: { issuer: string; config: Promise<client.Configuration> } | null = null;

/**
 * The provider's configuration, discovered once (and again after a
 * failure). Plain HTTP only for a provider on this machine — a test or a
 * local Keycloak.
 */
export function oidc(): Promise<client.Configuration> {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) throw new Error('OIDC_ISSUER is not configured');
  const issuer = new URL(env.OIDC_ISSUER);
  const local = issuer.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(issuer.hostname);
  if (discovered?.issuer !== env.OIDC_ISSUER) {
    const config = client.discovery(
      issuer, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET, undefined,
      local ? { execute: [client.allowInsecureRequests] } : undefined,
    ).catch((error: unknown) => {
      discovered = null;
      throw error;
    });
    discovered = { issuer: env.OIDC_ISSUER, config };
  }
  return discovered.config;
}

type Flow = { state: string; nonce: string; verifier: string; next: string };

const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: env.COOKIE_SECURE, path: `${env.BASE_PATH}/api/sso` };

/** Only a path of this application: never a way to send someone elsewhere. */
function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
}

function fail(res: Response, code: ErrorCode) {
  res.clearCookie(FLOW_COOKIE, cookieOptions);
  res.redirect(`${env.BASE_PATH}/login?error=${code}`);
}

/** The provider's locale ("ru", "en-US") if the interface speaks it. */
function localeOf(value: unknown): Locale {
  const language = typeof value === 'string' ? value.slice(0, 2).toLowerCase() : '';
  return (LOCALES as readonly string[]).includes(language) ? (language as Locale) : env.FIRST_EMPLOYEE_LOCALE;
}

function timeZoneOf(value: unknown): string {
  if (typeof value !== 'string') return env.FIRST_EMPLOYEE_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return env.FIRST_EMPLOYEE_TIME_ZONE;
  }
}

export default Router()
  .get('/start', async (req, res) => {
    if (!ssoEnabled()) {
      res.redirect(`${env.BASE_PATH}/login`);
      return;
    }
    try {
      const config = await oidc();
      const flow: Flow = {
        state: client.randomState(),
        nonce: client.randomNonce(),
        verifier: client.randomPKCECodeVerifier(),
        next: safeNext(req.query.next),
      };
      const scopes = ['openid', 'email', 'profile'];
      const params: Record<string, string> = {
        redirect_uri: env.PUBLIC_URL + CALLBACK_PATH,
        code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: 'S256',
        state: flow.state,
        nonce: flow.nonce,
      };
      // A refresh token lets the worker ask every day whether the person may still sign in.
      if (config.serverMetadata().scopes_supported?.includes('offline_access')) scopes.push('offline_access');
      if (config.serverMetadata().issuer === 'https://accounts.google.com') {
        params.access_type = 'offline';
        params.prompt = 'consent';
      }
      params.scope = scopes.join(' ');
      res.cookie(FLOW_COOKIE, Buffer.from(JSON.stringify(flow)).toString('base64url'), { ...cookieOptions, maxAge: FLOW_MAX_AGE_MS });
      res.redirect(client.buildAuthorizationUrl(config, params).toString());
    } catch (error) {
      console.error('[sso] start failed:', error);
      fail(res, 'sso_failed');
    }
  })
  .get('/callback', async (req, res) => {
    if (!ssoEnabled()) {
      res.redirect(`${env.BASE_PATH}/login`);
      return;
    }
    let flow: Flow;
    try {
      flow = JSON.parse(Buffer.from(parseCookie(req.headers.cookie ?? '')[FLOW_COOKIE] ?? '', 'base64url').toString()) as Flow;
      if (!flow.state || !flow.nonce || !flow.verifier) throw new Error('no flow');
    } catch {
      fail(res, 'sso_failed');
      return;
    }
    try {
      const config = await oidc();
      const query = req.originalUrl.slice(req.originalUrl.indexOf('?'));
      const tokens = await client.authorizationCodeGrant(config, new URL(env.PUBLIC_URL + CALLBACK_PATH + query), {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims()!;
      const context = await ctx(req, res);
      res.clearCookie(FLOW_COOKIE, cookieOptions);
      // Some providers (Entra) send no email claim: the sign-in name, if it is an address, unvouched.
      const email = typeof claims.email === 'string' ? claims.email
        : typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@') ? claims.preferred_username : null;
      const vouched = typeof claims.email === 'string' && claims.email_verified === true && emailAllowed(claims.email);
      const name = [claims.name, [claims.given_name, claims.family_name].filter(Boolean).join(' '), claims.preferred_username, email]
        .find((v): v is string => typeof v === 'string' && v.trim() !== '')!;
      const person = {
        sub: claims.sub,
        fullName: name.trim().slice(0, 255),
        locale: localeOf(claims.locale),
        timeZone: timeZoneOf(claims.zoneinfo),
        refreshToken: tokens.refresh_token ?? null,
      };
      const session = await Auth.signInExternal({ ...person, email: vouched ? email : null });
      if (session) {
        context.setSessionCookie(session);
        res.redirect(env.BASE_PATH + flow.next);
        return;
      }
      // No address the provider vouches for: they confirm one, as without the
      // provider (decision 86), so whoever was created by it is found. The
      // provider's is offered.
      context.setSsoPendingCookie(await Auth.beginExternal({ ...person, email: email && emailAllowed(email) ? email : null }));
      res.redirect(`${env.BASE_PATH}/sso`);
    } catch (error) {
      const appError = error instanceof AppError ? error : fromPostgres(error);
      if (appError && isErrorCode(appError.code)) {
        fail(res, appError.code);
        return;
      }
      console.error('[sso] callback failed:', error);
      fail(res, 'sso_failed');
    }
  });

const Due = z.object({ employeeId: z.number(), idpRefreshToken: z.string() });
const CHECK_BATCH = 100;

/**
 * The idp_check cron: asks the provider, with each person's refresh
 * token, whether they may still sign in — once a day each. A refusal
 * (invalid_grant) ends their sessions and stops their bots
 * (idp_refused()); a provider that is down changes nothing.
 */
export async function checkPeople(db: Sql): Promise<number> {
  if (!ssoEnabled()) return 0;
  const config = await oidc();
  const due = Due.array().parse(await db`
    SELECT h.employee_id, h.idp_refresh_token
      FROM human h JOIN employee e ON e.id = h.employee_id
     WHERE h.idp_refresh_token IS NOT NULL AND e.dismissed_at IS NULL
       AND (h.idp_checked_at IS NULL OR h.idp_checked_at < NOW() - INTERVAL '1 day')
     ORDER BY h.idp_checked_at NULLS FIRST
     LIMIT ${CHECK_BATCH}
       FOR UPDATE OF h SKIP LOCKED
  `);
  let refused = 0;
  for (const person of due) {
    try {
      const tokens = await client.refreshTokenGrant(config, person.idpRefreshToken);
      await db`
        UPDATE human SET idp_refresh_token = COALESCE(${tokens.refresh_token ?? null}, idp_refresh_token), idp_checked_at = NOW()
         WHERE employee_id = ${person.employeeId}
      `;
    } catch (error) {
      if (error instanceof client.ResponseBodyError && error.error === 'invalid_grant') {
        await db`SELECT idp_refused(${person.employeeId})`;
        refused++;
      } else {
        console.error(`[sso] checking employee ${person.employeeId} failed:`, error);
      }
    }
  }
  return refused;
}
