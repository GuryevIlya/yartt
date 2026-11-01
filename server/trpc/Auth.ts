import { z } from 'zod';
import { Email, Employee, Me } from '#shared/employee.ts';
import env from '../env.ts';
import { AppError } from '../errors.ts';
import * as Auth from '../services/Auth.ts';
import { outsideDomains } from '../domains.ts';
import * as Employees from '../services/Employee.ts';
import { authedProcedure, procedure, router } from '../trpc.ts';

export default router({
  /**
   * How one signs in here: through the company's identity provider (its
   * name for the button), or — without one — by a link sent by email.
   */
  config: procedure
    .output(z.object({ sso: z.object({ name: z.string() }).nullable() }))
    .query(() => ({ sso: env.OIDC_ISSUER ? { name: env.OIDC_NAME } : null })),

  /**
   * Sends a one-time sign-in link (valid for 10 minutes) by email and/or
   * the webhook; it works only in this browser (decision 101), which keeps
   * a key for it in a cookie. Always succeeds, so it cannot be used to
   * check whether an email exists.
   * @throws sso_only — sign-in goes through the identity provider.
   */
  requestLogin: procedure
    .input(z.object({ email: Email }))
    .output(z.void())
    .mutation(({ input, ctx }) => {
      const browser = ctx.loginBrowser ?? Auth.newBrowserKey();
      ctx.setLoginBrowserCookie(browser);
      return Auth.requestLogin(input.email, browser);
    }),

  /**
   * Redeems the token from the sign-in link and sets the session cookie.
   * @throws invalid_token — the token is unknown, used or older than 10 minutes.
   * @throws login_other_browser — opened outside the browser that asked for it; the link still works there.
   */
  login: procedure
    .input(z.object({ token: z.string().min(1).max(200) }))
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      ctx.setSessionCookie(await Auth.login(input.token, ctx.loginBrowser));
    }),

  /**
   * Follows the link sent to a new address: it becomes the sign-in email of
   * whoever asked. Signs nobody in. Anyone may call it — the token is the proof.
   * @throws invalid_token — unknown, used or older than a day.
   * @throws email_taken — someone took the address since.
   */
  confirmEmail: procedure
    .input(z.object({ token: z.string().min(1).max(200) }))
    .output(z.void())
    .mutation(({ input }) => Employees.confirmEmailChange(input.token)),

  /**
   * The first sign-in through the identity provider waiting in this
   * browser for the email to be confirmed (decision 86): the address the
   * provider offers, the name, and where the last link went. Null — none,
   * or over an hour old. Anyone may call it.
   */
  ssoPending: procedure
    .output(z.object({ email: z.string().nullable(), fullName: z.string(), sentTo: z.string().nullable() }).nullable())
    .query(({ ctx }) => (ctx.ssoPending ? Auth.pendingExternal(ctx.ssoPending) : null)),

  /**
   * Sends a link to the typed email, by email only; opened in this browser
   * it signs them in as whoever works here with that address, or as
   * someone new. A new link voids the one before.
   * @throws sso_failed — no sign-in through the provider waits here, or it is over an hour old.
   * @throws email_not_allowed — outside the company's domains.
   * @throws too_many_requests — 5 links already.
   */
  ssoSendEmail: procedure
    .input(z.object({ email: Email }))
    .output(z.void())
    .mutation(({ input, ctx }) => {
      if (!ctx.ssoPending) throw new AppError('sso_failed');
      return Auth.sendExternalEmail(ctx.ssoPending, input.email);
    }),

  /**
   * Follows the link from that email and sets the session cookie: the
   * provider account is theirs from now on.
   * @throws invalid_token — unknown, replaced or over an hour old.
   * @throws sso_other_browser — opened outside the browser that signed in.
   * @throws dismissed
   */
  ssoConfirm: procedure
    .input(z.object({ token: z.string().min(1).max(200) }))
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      const session = await Auth.confirmExternal(ctx.ssoPending, input.token);
      ctx.clearSsoPendingCookie();
      ctx.setSessionCookie(session);
    }),

  /** Ends the current session and clears the cookie. */
  logout: authedProcedure.meta({ outsideDomains: true }).output(z.void()).mutation(async ({ ctx }) => {
    if (ctx.sessionToken) await Auth.logout(ctx.sessionToken);
    ctx.clearSessionCookie();
  }),

  /** Ends all sessions of the signed-in employee on every device. */
  logoutEverywhere: authedProcedure.meta({ outsideDomains: true }).output(z.void()).mutation(async ({ ctx }) => {
    await Auth.logoutEverywhere(ctx.employeeId);
    ctx.clearSessionCookie();
  }),

  /**
   * The demo (DEMO_DATA): who can be picked to see the interface as —
   * everyone who can sign in. Null for a real installation. Anyone may call it.
   */
  demo: procedure.output(Employee.array().nullable()).query(() => {
    return env.DEMO_DATA ? Auth.demoPeople() : null;
  }),

  /**
   * The demo only: signs in as the picked employee without a link, ending
   * the current session if there is one. Anyone may call it.
   * @throws forbidden — not a demo.
   * @throws not_found — no such employee, or they cannot sign in (dismissed).
   */
  demoSignIn: procedure
    .input(z.object({ employeeId: z.number().int() }))
    .output(z.void())
    .mutation(async ({ input, ctx }) => {
      if (!env.DEMO_DATA) throw new AppError('forbidden');
      if (ctx.sessionToken) await Auth.logout(ctx.sessionToken);
      ctx.setSessionCookie(await Auth.demoSignIn(input.employeeId));
    }),

  /**
   * The signed-in employee, or null without a valid session; with whether
   * their email is outside the company's domains — then they may only
   * change it.
   */
  me: procedure.output(Me.nullable()).query(async ({ ctx }) => {
    const me = ctx.employeeId === null ? null : await Employees.get(ctx.employeeId);
    return me && { ...me, outsideDomains: ctx.bot === null && outsideDomains(me.email), domains: env.EMAIL_DOMAINS };
  }),
});
