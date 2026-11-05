import { z } from 'zod';
import { Id } from '#shared/employee.ts';
import { Webhook, WebhookInput } from '#shared/webhook.ts';
import * as Webhooks from '../services/Webhook.ts';
import { authedProcedure, router } from '../trpc.ts';

// For people only: a bot has one webhook, in its settings.
export default router({
  /** The signed-in person's webhooks, with their secrets and how the last attempt went. */
  list: authedProcedure
    .output(Webhook.array())
    .query(({ ctx }) => Webhooks.list(ctx.employeeId)),

  /**
   * Adds a webhook and says, for each group of events, how much it gets.
   * @throws webhook_url_not_allowed — the administrator does not allow this address.
   * @throws webhook_limit — too many already.
   */
  create: authedProcedure
    .input(WebhookInput)
    .output(Webhook)
    .mutation(({ input, ctx }) => Webhooks.create(ctx.employeeId, input)),

  /**
   * Changes one's own webhook.
   * @throws webhook_url_not_allowed — the administrator does not allow this address.
   * @throws not_found — no such webhook of theirs.
   */
  update: authedProcedure
    .input(WebhookInput.extend({ id: Id }))
    .output(Webhook)
    .mutation(({ input: { id, ...input }, ctx }) => Webhooks.update(ctx.employeeId, id, input)),

  /**
   * Removes one's own webhook.
   * @throws not_found — no such webhook of theirs.
   */
  remove: authedProcedure
    .input(z.object({ id: Id }))
    .output(z.void())
    .mutation(({ input, ctx }) => Webhooks.remove(ctx.employeeId, input.id)),

  /**
   * Sends a test to one's own webhook; the result says how it went.
   * @throws not_found — no such webhook of theirs.
   */
  test: authedProcedure
    .input(z.object({ id: Id }))
    .output(Webhook)
    .mutation(({ input, ctx }) => Webhooks.test(ctx.employeeId, input.id)),
});
