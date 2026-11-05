import { z } from 'zod';
import { Id, typedMoment } from './employee.ts';

// The dependency graph: a task waits for another (db.sql, dependency).

export const SetDependencyInput = z.object({
  /** The task that waits; its owner sets the dependency. */
  taskId: Id,
  /** The task it waits for. */
  value: Id,
  /**
   * The latest deadline of `value` that this task can live with; NULL — no
   * constraint. Nothing is forbidden by it: a later deadline, or none,
   * puts both tasks at risk. An ISO string is read as a date, for bots.
   */
  latestAt: z.union([z.date(), z.iso.datetime({ offset: true }).transform((s) => new Date(s))]).refine(typedMoment).nullable(),
});
export type SetDependencyInput = z.infer<typeof SetDependencyInput>;
