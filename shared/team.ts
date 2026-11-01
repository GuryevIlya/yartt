import { z } from 'zod';
import { As, Day, Id } from './employee.ts';
import { HistoryInput } from './myDay.ts';

// Team: a manager's reports, an employee's page (their days and scores) and
// the metrics of a period (docs/product/interface.md, 4 and 4a).

/** Quick periods: the last N days, today included. Any other range is picked by dates. */
export const PERIODS = [7, 30, 90] as const;
/** The longest range the metrics are computed for, in days. */
export const MAX_RANGE_DAYS = 366;

/**
 * Workload and quality side by side, never mixed (decision 6): the
 * timesheet hours, the time logged to tasks, and the score weighted by
 * the minutes of the scored shifts; a shift past midnight counts in each
 * day by its share (decision 100).
 */
export const Stats = z.object({
  /** Minutes of closed shifts within the period. */
  workMinutes: z.number().int(),
  /** Days with a closed shift. */
  workDays: z.number().int(),
  /** Time logged to tasks. */
  spentMinutes: z.number().int(),
  /** Days with a scored shift. */
  scoredDays: z.number().int(),
  /** SUM(score × minutes) / SUM(minutes) over the scored shifts within the period; NULL — nothing scored. */
  weightedScore: z.number().nullable(),
});
export type Stats = z.infer<typeof Stats>;

/** One day of a person: timesheet, time logged to tasks, the score. */
export const DayStats = z.object({
  day: Day,
  workMinutes: z.number().int(),
  spentMinutes: z.number().int(),
  /** NULL — not scored. */
  score: z.number().int().nullable(),
  /** Planned work at the end of the day (now for today): the sum of their estimates of open tasks. */
  backlogMinutes: z.number().int(),
});
export type DayStats = z.infer<typeof DayStats>;

/** A day of a person in My team: also the delays of that day, for the charts (medians, as in Member). */
export const MemberDay = DayStats.extend({
  /** The day's shifts: from a shift's end to its record. */
  recordDelayMinutes: z.number().nullable(),
  /** Mentions of the day: working minutes to the first reaction. */
  replyMinutes: z.number().nullable(),
  /** As a manager: the reports' scores of this day, from its end to the score. */
  scoreWaitMinutes: z.number().nullable(),
});
export type MemberDay = z.infer<typeof MemberDay>;

/** One person of the team summary for a range; someone dismissed before it is not there. */
export const Member = z.object({
  employeeId: Id,
  /** A direct report (the signed-in employee is their manager). */
  direct: z.boolean(),
  /** The signed-in employee themselves, on top: their own report. */
  self: z.boolean(),
  stats: Stats,
  /** Past days with a closed shift not scored — what the direct manager may score (decision 100). */
  unscoredDays: z.number().int(),
  /** Their tasks closed in the range by their deadline (decision 93: only the owner closes a task). */
  finished: z.number().int(),
  /** Their tasks closed in the range after their deadline had passed: overdue first. */
  late: z.number().int(),
  /** Their open tasks now, overdue ones included. */
  openTasks: z.number().int(),
  /** Of them, at risk (db.sql, at_risk): a plan does not fit before the deadline, or a latest deadline around it is broken. */
  atRisk: z.number().int(),
  /**
   * How late the timesheet is written: the median of minutes between a
   * shift's end and when it was last recorded; NULL — no closed shifts.
   */
  recordDelayMinutes: z.number().nullable(),
  /**
   * The median of their working minutes (shifts only) from a mention to
   * their first reaction — a reply or the closing, whichever came first
   * (decision 95); NULL — none reacted to, or no timesheet.
   */
  replyMinutes: z.number().nullable(),
  /** As a manager: the median of minutes from the end of a report's day to their score of it; NULL — scored none. */
  scoreWaitMinutes: z.number().nullable(),
  /** Planned work now: the sum of their estimates of time left on open tasks. */
  backlogMinutes: z.number().int(),
  /** How the backlog changed over the range (now minus its start): planned work growing or melting. */
  backlogGrowthMinutes: z.number().int(),
  /** Mentions of them in the range with no reaction yet: neither a reply nor the closing. */
  unanswered: z.number().int(),
  /**
   * When they were last active — opened a screen or used a session —
   * whatever the range; NULL — never. Someone gone without being dismissed
   * shows here: the stale come first in My team.
   */
  lastSeenAt: z.date().nullable(),
  /** Every day of the range, oldest first: for the charts of the details. */
  days: MemberDay.array(),
});
export type Member = z.infer<typeof Member>;

const RangeShape = { from: Day, to: Day };
const rangeOk = (r: { from: string; to: string }) =>
  r.from <= r.to && (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 < MAX_RANGE_DAYS;

/** The team summary: the whole subtree for a range of days. */
export const SummaryInput = z.object({ ...RangeShape, as: As }).refine(rangeOk, { path: ['to'] });
export type SummaryInput = z.infer<typeof SummaryInput>;

export const EmployeeInput = z.object({ employeeId: Id });

/** From and to, both included, in the employee's own days. */
export const StatsInput = EmployeeInput.extend(RangeShape).refine(rangeOk, { path: ['to'] });
export type StatsInput = z.infer<typeof StatsInput>;

/** One day of the chart. */

export const PeriodStats = z.object({
  stats: Stats,
  /** Every day of the range, oldest first. */
  days: DayStats.array(),
});
export type PeriodStats = z.infer<typeof PeriodStats>;

export const EmployeeHistoryInput = HistoryInput.extend(EmployeeInput.shape);
export type EmployeeHistoryInput = z.infer<typeof EmployeeHistoryInput>;

/** The same score for one or more shifts of a report, a day's at once (decision 100). */
export const ScoreInput = z.object({
  employeeId: Id,
  shiftIds: Id.array().min(1).max(50),
  value: z.number().int().min(0).max(100),
  reason: z.string().trim().max(2000).nullable(),
});
export type ScoreInput = z.infer<typeof ScoreInput>;

/** A score withdrawn: the shift and its time entries can be corrected; the reason stays. */
export const UnscoreInput = z.object({ employeeId: Id, shiftId: Id });
export type UnscoreInput = z.infer<typeof UnscoreInput>;
