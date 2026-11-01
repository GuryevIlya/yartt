import { z } from 'zod';
import { AddShiftInput, CloseShiftInput, OpenShift, ShiftKey, StartShiftInput, UpdateShiftInput } from '#shared/myDay.ts';
import * as Work from '../services/Work.ts';
import { authedProcedure, router } from '../trpc.ts';

// The signed-in employee's own timesheet. Shifts are theirs to add, correct
// and delete until scored; withdrawing the score frees one (decision 100).
export default router({
  /** The signed-in employee's open shift (when it started), or null: for the top line. */
  open: authedProcedure
    .output(OpenShift)
    .query(({ ctx }) => Work.open(ctx.employeeId)),

  /**
   * Opens a shift at the given moment (cut to the minute, not later than now).
   * @throws shift_overlap_open — a shift is already open.
   * @throws shift_overlap_with — a closed shift covers the moment (its times in params).
   * @throws shift_overlap — two starts at once.
   */
  start: authedProcedure
    .input(StartShiftInput)
    .output(z.void())
    .mutation(({ input, ctx }) => Work.start(ctx.employeeId, input.startedAt)),

  /**
   * Closes the open shift: its start (may be corrected), its end and what was done.
   * @throws not_found — no open shift.
   * @throws invalid_data — the end is not after the start.
   * @throws shift_overlap_with, shift_overlap_open — another shift is in the way (its times in params).
   * @throws shift_too_long — longer than 24 hours.
   */
  close: authedProcedure
    .input(CloseShiftInput)
    .output(z.void())
    .mutation(({ input, ctx }) => Work.close(ctx.employeeId, input)),

  /**
   * Adds a closed shift at once — a suggestion confirmed, a forgotten or a
   * second shift; it may run past midnight (decision 100).
   * @throws invalid_data — the end is not after the start.
   * @throws shift_overlap_with, shift_overlap_open — another shift is in the way (its times in params).
   * @throws shift_too_long — longer than 24 hours.
   */
  add: authedProcedure
    .input(AddShiftInput)
    .output(z.void())
    .mutation(({ input, ctx }) => Work.add(ctx.employeeId, input)),

  /**
   * Corrects a closed shift: its start, end and what was done.
   * @throws not_found — no closed shift starting then.
   * @throws invalid_data — the end is not after the start.
   * @throws shift_overlap_with, shift_overlap_open — another shift is in the way (its times in params).
   * @throws shift_too_long — longer than 24 hours.
   * @throws shift_shorter_than_entries — less than the time logged in it (in params).
   * @throws shift_scored
   */
  update: authedProcedure
    .input(UpdateShiftInput)
    .output(z.void())
    .mutation(({ input, ctx }) => Work.update(ctx.employeeId, input)),

  /**
   * Deletes a shift, open or closed, by its start.
   * @throws not_found
   * @throws shift_has_entries — time is logged in it.
   * @throws shift_scored
   */
  remove: authedProcedure
    .input(ShiftKey)
    .output(z.void())
    .mutation(({ input, ctx }) => Work.remove(ctx.employeeId, input.startedAt)),
});
