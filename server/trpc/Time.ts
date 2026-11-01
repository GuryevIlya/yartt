import { z } from 'zod';
import { Id } from '#shared/employee.ts';
import { Minutes, MyTime, PlanAbout, ShiftMinutes } from '#shared/observer.ts';
import * as Times from '../services/Time.ts';
import { authedProcedure, router } from '../trpc.ts';

export default router({
  /**
   * The signed-in employee's time on a task: logged in total and left.
   * @throws no_access
   */
  mine: authedProcedure
    .input(z.object({ taskId: Id }))
    .output(MyTime)
    .query(({ input, ctx }) => Times.myTime(ctx.employeeId, input.taskId)),

  /**
   * Sets the signed-in employee's own time on a task in one of their
   * shifts: the shift's whole time on it, replacing what was there — one
   * entry per task and shift; 0 removes it (decision 100).
   * @throws not_found — not a shift of theirs.
   * @throws no_access
   * @throws spent_over_shift — the shift's tasks together would have more than it lasts (logged and left in params).
   * @throws shift_scored
   */
  set: authedProcedure
    .input(z.object({ taskId: Id, shiftId: Id, minutes: ShiftMinutes }))
    .output(z.void())
    .mutation(({ input, ctx }) => Times.setShift(ctx.employeeId, input.taskId, input.shiftId, input.minutes)),

  /**
   * Sets how much more time the signed-in employee plans to spend on the
   * task (decision 17) and, if they say, what for (decision 88); null
   * minutes clears it.
   * @throws no_access
   */
  setLeft: authedProcedure
    .input(z.object({ taskId: Id, minutes: Minutes.nullable(), about: PlanAbout }))
    .output(z.void())
    .mutation(({ input, ctx }) => Times.setLeft(ctx.employeeId, input.taskId, input.minutes, input.about)),
});
