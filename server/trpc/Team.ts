import { z } from 'zod';
import { History } from '#shared/myDay.ts';
import { EmployeeHistoryInput, Member, PeriodStats, ScoreInput, StatsInput, SummaryInput, UnscoreInput } from '#shared/team.ts';
import * as Team from '../services/Team.ts';
import { authedProcedure, router } from '../trpc.ts';

export default router({
  /**
   * The team summary for a range of days (up to a year): the whole subtree
   * of the signed-in employee's reports, direct ones first — workload and
   * weighted score, days waiting for a score, tasks closed by hand and
   * automatically, open tasks. Empty for someone without reports. `as` — a
   * report's team, for a manager above (decision 83).
   * @throws forbidden — `as` is not under the signed-in employee.
   */
  summary: authedProcedure
    .input(SummaryInput)
    .output(Member.array())
    .query(async ({ input, ctx }) => Team.summary(await Team.viewAs(ctx.employeeId, input.as), input.from, input.to)),

  /**
   * An employee's workload and weighted score for a range of their days
   * (from and to included, up to a year), and every day of it for a chart.
   * Seen by the employee and every manager above them.
   * @throws forbidden
   */
  stats: authedProcedure
    .input(StatsInput)
    .output(PeriodStats)
    .query(({ input, ctx }) => Team.employeeStats(ctx.employeeId, input.employeeId, input.from, input.to)),

  /**
   * An employee's days, as in their My day (decision 12), `size` per page.
   * Seen by the employee and every manager above them.
   * @throws forbidden
   */
  history: authedProcedure
    .input(EmployeeHistoryInput)
    .output(History)
    .query(({ input, ctx }) => Team.history(ctx.employeeId, input.employeeId, input.page, input.size)),

  /**
   * The direct manager scores closed shifts of a report — a day's at
   * once — 0–100, with an optional reason, or corrects their scores
   * (decision 100). Every version is mailed to the report with its time and
   * the previous value, one email per shift. A standing score freezes the
   * shift and its time entries; scoring a withdrawn one again checks it anew.
   * @throws not_found — a shift is not the report's.
   * @throws not_manager
   * @throws shift_open
   */
  score: authedProcedure
    .input(ScoreInput)
    .output(z.void())
    .mutation(({ input, ctx }) => Team.score(ctx.employeeId, input)),

  /**
   * The direct manager withdraws a shift's score, keeping its reason: the
   * report may correct the shift and its time entries, then it is scored
   * again. Mailed to the report like every version.
   * @throws not_found — not the report's shift.
   * @throws not_manager
   */
  unscore: authedProcedure
    .input(UnscoreInput)
    .output(z.void())
    .mutation(({ input, ctx }) => Team.unscore(ctx.employeeId, input.employeeId, input.shiftId)),
});
