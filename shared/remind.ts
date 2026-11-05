import { z } from 'zod';
import { Id, TypedMoment } from './employee.ts';

// Personal reminders on a task (db.sql, remind): whom — always oneself.

export const Remind = z.object({
  at: z.date(),
  /** What exactly to remind about; NULL — just the task. */
  text: z.string().nullable(),
  /** Due already: it waits in "Waiting for me" until removed or moved. */
  due: z.boolean(),
});
export type Remind = z.infer<typeof Remind>;

export const AddRemindInput = z.object({
  taskId: Id,
  at: TypedMoment,
  text: z.string().trim().max(500).nullable(),
});
export type AddRemindInput = z.infer<typeof AddRemindInput>;

/** A reminder put off: due again at `to`. */
export const MoveRemindInput = z.object({ taskId: Id, at: z.date(), to: TypedMoment });
export type MoveRemindInput = z.infer<typeof MoveRemindInput>;
