import { z } from 'zod';
import { As, Day, Id, TypedMoment } from './employee.ts';
import { MentionReply } from './comment.ts';
import { TaskHeader, TaskHours } from './task.ts';

// My day (docs/product/interface.md, 1): TODO, current tasks, history of my days.

/** An open mention of me: closed by "Done" after a reply, or by "No reply needed". */
export const TodoMention = z.object({
  kind: z.literal('mention'),
  task: TaskHeader,
  commentId: Id,
  authorId: Id,
  at: z.date(),
  /** The beginning of the comment as plain text. */
  excerpt: z.string(),
  /** My answers, oldest first; empty — none yet: then it is closed by "No reply needed". */
  replies: MentionReply.array(),
});
export type TodoMention = z.infer<typeof TodoMention>;

/** Time planned on a task, someone's own (estimate_minutes). */
export const PlanLeft = z.object({ employeeId: Id, minutes: z.number().int(), about: z.string().nullable() });
export type PlanLeft = z.infer<typeof PlanLeft>;

/** A dependency someone else added on my task, since my review. */
export const ReviewLink = z.object({
  /** The other task. */
  task: TaskHeader,
  /** true — my task waits for it; false — it waits for mine. */
  waits: z.boolean(),
  by: Id,
  at: z.date(),
});
export type ReviewLink = z.infer<typeof ReviewLink>;

/**
 * What in my task came since my review (decision 94): each notice is taken
 * away by moving reviewed_at past it — "No intervention needed", or
 * "Finish" when the task is overdue. Only what was shown is taken away:
 * the button sends `at`.
 */
export const TodoReview = z.object({
  kind: z.literal('review'),
  task: TaskHeader,
  /** The newest notice: reviewed_at goes up to it. */
  at: z.date(),
  /** Comments by others: how many, the authors in the order they first wrote, the newest one's moment; NULL — none. */
  comments: z.object({ count: z.number().int(), authorIds: Id.array(), at: z.date() }).nullable(),
  /**
   * The task came to me then and I have not accepted it: the review is
   * this alone, accepted by one press; NULL — not handed or accepted.
   */
  handedAt: z.date().nullable(),
  links: ReviewLink.array(),
  /** Tasks mine waits for that their owners closed. */
  done: z.object({ task: TaskHeader, at: z.date() }).array(),
  /** Tasks that waited for mine and closed first. */
  waiterClosed: z.object({ task: TaskHeader, at: z.date() }).array(),
  /**
   * The deadline within a day — a notice — or passed: overdue, it stays
   * until I close the task or move the deadline (decision 93); closed only
   * once nobody has time planned on it. NULL — neither.
   */
  deadline: z.object({ at: z.date(), overdue: z.boolean(), plans: PlanLeft.array() }).nullable(),
});
export type TodoReview = z.infer<typeof TodoReview>;

/** An access request to my task. */
export const TodoRequest = z.object({
  kind: z.literal('request'),
  task: TaskHeader,
  employeeId: Id,
});
export type TodoRequest = z.infer<typeof TodoRequest>;

/** My reminder that came due: it waits until I remove it or put it off. */
export const TodoRemind = z.object({
  kind: z.literal('remind'),
  task: TaskHeader,
  at: z.date(),
  /** What I wanted to be reminded of; NULL — just the task. */
  text: z.string().nullable(),
});
export type TodoRemind = z.infer<typeof TodoRemind>;

/** An overdue task with my time still planned on it: cleared, its owner can close it. */
export const TodoPlanLeft = z.object({
  kind: z.literal('plan_left'),
  task: TaskHeader,
  /** The deadline it missed. */
  at: z.date(),
  minutes: z.number().int(),
  /** What I said it is for; NULL — not said. */
  about: z.string().nullable(),
});
export type TodoPlanLeft = z.infer<typeof TodoPlanLeft>;

/** `as` — a report's (decision 83); `taskId` — one task's, for its page. */
export const TodoInput = z.object({ as: As, taskId: Id.optional() });
export type TodoInput = z.infer<typeof TodoInput>;

export const TodoItem = z.discriminatedUnion('kind', [TodoMention, TodoReview, TodoRequest, TodoRemind, TodoPlanLeft]);
export type TodoItem = z.infer<typeof TodoItem>;

/** My access request to someone's task, not answered yet. */
export const WaitingRequest = z.object({
  kind: z.literal('request'),
  task: TaskHeader,
});
export type WaitingRequest = z.infer<typeof WaitingRequest>;

/** Someone I mentioned, not accepted yet: open, or closed with or without a reply. */
export const WaitingPerson = z.object({
  employeeId: Id,
  /** When I mentioned them. */
  at: z.date(),
  /** NULL — open. */
  closedAt: z.date().nullable(),
  /** Their answers, oldest first; empty — none yet. */
  replies: MentionReply.array(),
});
export type WaitingPerson = z.infer<typeof WaitingPerson>;

/**
 * My comment with mentions I have not reviewed (decision 98): never
 * reviewed — everyone mentioned; reviewed — those who reacted since.
 * "No intervention needed" takes it away until the next reaction.
 */
export const WaitingMention = z.object({
  kind: z.literal('mention'),
  task: TaskHeader,
  commentId: Id,
  /** The earliest mention: the longest waiting first. */
  at: z.date(),
  /** The beginning of my comment as plain text. */
  excerpt: z.string(),
  /** Up to when I have seen the reactions; NULL — never. */
  reviewedAt: z.date().nullable(),
  people: WaitingPerson.array(),
  /** Mentioned and not shown, with no reaction at all: they have not answered yet. */
  quiet: z.number().int(),
});
export type WaitingMention = z.infer<typeof WaitingMention>;

/** What I wait for from others (decision 67): the counterpart of TODO. */
export const WaitingItem = z.discriminatedUnion('kind', [WaitingRequest, WaitingMention]);
export type WaitingItem = z.infer<typeof WaitingItem>;

/**
 * 'mine' — open tasks I own or plan time on; 'team' — open tasks my people
 * own or plan time on, down the chain; 'others' — every other open task I
 * see; 'closed' — the closed ones I see (decision 85).
 */
export const CurrentTab = z.enum(['mine', 'team', 'others', 'closed']);
export type CurrentTab = z.infer<typeof CurrentTab>;

export const CurrentInput = z.object({
  tab: CurrentTab,
  page: z.number().int().min(1),
  as: As,
});
export type CurrentInput = z.infer<typeof CurrentInput>;

export const Current = z.object({
  items: TaskHeader.array(),
  /** Tasks in each tab, for the tab labels. */
  counts: z.object({ mine: z.number().int(), team: z.number().int(), others: z.number().int(), closed: z.number().int() }),
  /** Time left planned on the tasks shown: mine in 'mine', my people's together in 'team'. */
  plans: z.object({ taskId: Id, minutes: z.number().int() }).array(),
  /** Everyone's time on each task seen — logged and left in plans; none — not there. */
  hours: TaskHours.array(),
});
export type Current = z.infer<typeof Current>;

/** A score of a shift (decision 100). */
export const ShiftScore = z.object({
  /** NULL — withdrawn (its reason stays): the shift is open to corrections again. */
  value: z.number().int().nullable(),
  reason: z.string().nullable(),
});
export type ShiftScore = z.infer<typeof ShiftScore>;

/** A shift of the timesheet. It may run past midnight: then it is in both days (decision 100). */
export const Shift = z.object({
  id: Id,
  startedAt: z.date(),
  /** NULL — the shift is open. */
  spentMinutes: z.number().int().nullable(),
  about: z.string().nullable(),
  /** NULL — never scored. */
  score: ShiftScore.nullable(),
});
export type Shift = z.infer<typeof Shift>;

/** Time logged to a task in a shift (spent_minutes): its whole value, in each day of the shift. */
export const Entry = z.object({
  id: Id,
  shiftId: Id,
  taskId: Id,
  minutes: z.number().int(),
  /** When its value was last set. */
  updatedAt: z.date(),
});
export type Entry = z.infer<typeof Entry>;

/** Opening a task, or My day when taskId is NULL. */
export const Visit = z.object({
  taskId: Id.nullable(),
  at: z.date(),
});
export type Visit = z.infer<typeof Visit>;

/** Something done, not only looked at: a comment written, time logged. */
export const Action = z.object({
  kind: z.enum(['comment', 'time']),
  taskId: Id,
  at: z.date(),
});
export type Action = z.infer<typeof Action>;

export const DayHistory = z.object({
  day: Day,
  shifts: Shift.array(),
  entries: Entry.array(),
  /** Oldest first. */
  visits: Visit.array(),
  /** Oldest first: what was done, for the day's ribbon next to the visits. */
  actions: Action.array(),
  /** The first and last thing I did that day: visits, comments, time logged. */
  firstActivity: z.date().nullable(),
  lastActivity: z.date().nullable(),
  /** Minutes of the closed shifts within the day, and of the time logged in them: a shift past midnight by its share. */
  workedMinutes: z.number().int(),
  loggedMinutes: z.number().int(),
});
export type DayHistory = z.infer<typeof DayHistory>;

export const HistoryInput = z.object({
  /** 1 — starting from today. */
  page: z.number().int().min(1),
  /** Days with activity per page: 2 in My day (today and the last day before), more on the employee page. */
  size: z.number().int().min(1).max(31).default(7),
});
export type HistoryInput = z.infer<typeof HistoryInput>;

export const History = z.object({
  /** Today in my time zone. */
  today: Day,
  /** Newest first; days without any activity are skipped (except today). */
  days: DayHistory.array(),
  /** Headers of the tasks the days refer to. */
  tasks: TaskHeader.array(),
  /** When the open shift started, maybe on another page: no shift can begin after it. */
  openShiftFrom: z.date().nullable(),
  /** Days with activity in all (today included), for the pages. */
  total: z.number().int(),
});
export type History = z.infer<typeof History>;

export const About = z.string().trim().max(2000).nullable();

/** My open shift, or none. */
export const OpenShift = z.object({ startedAt: z.date() }).nullable();
export type OpenShift = z.infer<typeof OpenShift>;

export const StartShiftInput = z.object({ startedAt: TypedMoment });
export type StartShiftInput = z.infer<typeof StartShiftInput>;

/** Closing the open shift; its start may be corrected at the same time. */
export const CloseShiftInput = z.object({ startedAt: TypedMoment, endedAt: TypedMoment, about: About });
export type CloseShiftInput = z.infer<typeof CloseShiftInput>;

/** A closed shift added at once, e.g. a suggestion for a past day confirmed. */
export const AddShiftInput = CloseShiftInput;
export type AddShiftInput = z.infer<typeof AddShiftInput>;

/** A closed shift corrected: found by its start, given a new start, end and what was done. */
export const UpdateShiftInput = z.object({ startedAt: z.date(), newStartedAt: TypedMoment, endedAt: TypedMoment, about: About });
export type UpdateShiftInput = z.infer<typeof UpdateShiftInput>;

/** A shift, open or closed, by its start. */
export const ShiftKey = z.object({ startedAt: z.date() });
export type ShiftKey = z.infer<typeof ShiftKey>;
