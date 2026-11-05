import { z } from 'zod';
import { Day, Id } from './employee.ts';

// Payloads of notification.payload (JSONB), by kind. Written by the database
// functions and the application, parsed on the way out.
// `for` is set on a copy sent to the manager of an absent recipient.

const Copy = { for: Id.optional() };

export const NotificationPayload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invite'), by: Id, ...Copy }),
  // Added without an invite — the first employee, or by the installation's administrator.
  z.object({ kind: z.literal('welcome'), ...Copy }),
  z.object({ kind: z.literal('comment'), by: Id, commentId: Id, ...Copy }),
  z.object({ kind: z.literal('mention'), by: Id, commentId: Id, ...Copy }),
  z.object({ kind: z.literal('task_mention'), by: Id, commentId: Id, ...Copy }),
  z.object({ kind: z.literal('remind'), text: z.string().nullable(), ...Copy }),
  z.object({ kind: z.literal('access_request'), employeeId: Id, ...Copy }),
  z.object({ kind: z.literal('access_opened'), by: Id, ...Copy }),
  z.object({ kind: z.literal('access_closed'), by: Id, ...Copy }),
  /** The deadline of a task mine waits for changed; `late` — it is now later than mine can live with, or gone. */
  z.object({ kind: z.literal('finished_at_change'), dependencyId: Id, late: z.boolean().optional(), ...Copy }),
  /** Someone made my task wait for `dependencyId` (decision 94). */
  z.object({ kind: z.literal('waits_added'), by: Id, dependencyId: Id, ...Copy }),
  /** Someone's task now waits for mine; `hard` — it has a latest deadline for mine (the name is kept for webhooks). */
  z.object({ kind: z.literal('dependency_added'), by: Id, dependentId: Id, hard: z.boolean(), ...Copy }),
  /** My task closes by its deadline within a day; `deadline` — when, ISO. */
  /** My task closed by its deadline, set in advance: it waits in Waiting for me for my confirmation. */
  /** A task mine waits for closed by its deadline. */
  z.object({ kind: z.literal('dependency_done'), dependencyId: Id, ...Copy }),
  /** A task that waited for mine closed first, or the link was removed: my work may not be needed any more. */
  z.object({ kind: z.literal('waiter_closed'), dependentId: Id, ...Copy }),
  z.object({ kind: z.literal('owner_change'), from: Id, ...Copy }),
  z.object({ kind: z.literal('owner_handed'), by: Id, employeeId: Id, ...Copy }),
  // Every version of a score is mailed: the employee's mail is its history.
  z.object({
    kind: z.literal('score'),
    by: Id,
    /** The day the shift began. */
    day: Day,
    /** The shift scored (decision 100), ISO and minutes; absent before 0.6, when a day was scored. */
    startedAt: z.string().optional(),
    minutes: z.number().int().optional(),
    /** NULL — the score was withdrawn: the shift can be corrected. */
    value: z.number().int().nullable(),
    reason: z.string().nullable(),
    /** When this version was given, ISO. */
    at: z.string(),
    /** The value it replaced; NULL — the first score of the day (a withdrawn one has value NULL). */
    previous: z.object({ value: z.number().int().nullable(), reason: z.string().nullable() }).nullable(),
    ...Copy,
  }),
  z.object({ kind: z.literal('new_report'), employeeId: Id, ...Copy }),
  // Monday morning for a manager: what waits for them in their team.
  z.object({
    kind: z.literal('weekly_digest'),
    /** Tasks of the subtree overdue now: the deadline passed, the owner did not close them (decision 93); absent before 0.5. */
    overdue: z.number().int().default(0),
    /** Tasks of the subtree at risk now. */
    atRisk: z.number().int(),
    /** Direct reports the identity provider no longer lets in, not dismissed yet; absent before 0.2. */
    blocked: z.number().int().default(0),
    ...Copy,
  }),
  // Once a year of a bot's key's age, to its manager: the key keeps working.
  z.object({ kind: z.literal('bot_key_old'), employeeId: Id, /** When the key was issued, ISO. */ issuedAt: z.string(), ...Copy }),
]);
export type NotificationPayload = z.infer<typeof NotificationPayload>;
export type NotificationKind = NotificationPayload['kind'];
