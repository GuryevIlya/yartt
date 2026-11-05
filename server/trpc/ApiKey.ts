import { z } from 'zod';
import { ApiKey, ApiKeyInput, NewApiKey } from '#shared/apiKey.ts';
import { Id } from '#shared/employee.ts';
import * as ApiKeys from '../services/ApiKey.ts';
import { authedProcedure, router } from '../trpc.ts';

// Only from the interface: a key is never made or ended with a key.
export default router({
  /** The signed-in person's working keys, without the keys themselves. */
  list: authedProcedure
    .output(ApiKey.array())
    .query(({ ctx }) => ApiKeys.list(ctx.employeeId)),

  /** Makes a key with these rights and this life, shown once. For people only. */
  create: authedProcedure
    .input(ApiKeyInput)
    .output(NewApiKey)
    .mutation(({ input, ctx }) => ApiKeys.create(ctx.employeeId, input)),

  /**
   * Ends one's own key at once.
   * @throws not_found — no such key of theirs.
   */
  revoke: authedProcedure
    .input(z.object({ id: Id }))
    .output(z.void())
    .mutation(({ input, ctx }) => ApiKeys.revoke(ctx.employeeId, input.id)),
});
