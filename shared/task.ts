import { z } from 'zod';
import { Id } from './employee.ts';

// Tasks: the header everyone sees, the page of someone who sees the task,
// search and the owner's changes. A schema and its type share a name.

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

/** Lower case only (db.sql, tag.name), inner spaces collapsed. */
export const TagName = z.string().trim().toLowerCase().overwrite((s) => s.replace(/\s+/g, ' ')).min(1).max(100);

/** #RRGGBB. */
export const TagColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A tag as the viewer sees it: with their own color (NULL — the default). */
export const Tag = z.object({ id: Id, name: z.string(), color: TagColor.nullable() });
export type Tag = z.infer<typeof Tag>;

/** Rich text from the editor; the server sanitizes it. */
export const Html = z.string().max(200_000);

/**
 * A task as everyone sees it (decision 19): tags in the viewer's own order,
 * priority, deadline and owner. Context, comments and people are not here.
 */
export const TaskHeader = z.object({
  id: Id,
  tags: Tag.array(),
  priority: Priority,
  /** NULL — no deadline. Passed while the task is open — overdue (decision 93). */
  deadline: z.date().nullable(),
  /** Its owner closed it (db.sql, close_task); only that closes a task. */
  closed: z.boolean(),
  /** NULL — an ownerless task (its owner was dismissed without a manager). */
  ownerId: Id.nullable(),
  isPublic: z.boolean(),
  /**
   * The deadline will not be met by plans (db.sql, deadline_risk): the person
   * whose time left exceeds most their working time until the deadline;
   * NULL — it fits, or nothing to measure.
   */
  risk: z.object({ employeeId: Id, plannedMinutes: z.number().int(), capacityMinutes: z.number().int() }).nullable(),
  /**
   * Open, it waits for these tasks, and their deadline is later than the
   * latest one it can live with, or not set (db.sql, dependency_risk).
   */
  late: Id.array(),
  /** Open, it delays these tasks: its deadline is later than the latest one they can live with, or not set. */
  delays: Id.array(),
});
export type TaskHeader = z.infer<typeof TaskHeader>;

/** A line in "Waits for" / "Waited on by". */
export const Dependency = TaskHeader.extend({
  /**
   * The latest deadline of the task waited for that the waiting task can
   * live with; NULL — no constraint. Later, or no deadline: both at risk.
   */
  latestAt: z.date().nullable(),
  /** Who linked them: they may remove it, as may the owner of the waiting task; NULL — not known (before 0.5). */
  addedBy: Id.nullable(),
});
export type Dependency = z.infer<typeof Dependency>;

/** What the viewer is to the task. */
export const Access = z.enum(['owner', 'observer', 'public', 'requested', 'none']);
export type Access = z.infer<typeof Access>;

/** The part of a task only someone who sees it gets. */
export const TaskDetails = z.object({
  /** Sanitized HTML. */
  context: z.string().nullable(),
  waitsFor: Dependency.array(),
  waitedOnBy: Dependency.array(),
});
export type TaskDetails = z.infer<typeof TaskDetails>;

export const TaskPage = TaskHeader.extend({
  access: Access,
  /** NULL when the viewer does not see the task. */
  details: TaskDetails.nullable(),
});
export type TaskPage = z.infer<typeof TaskPage>;

/**
 * A task at a glance, for the hint over it in any list: its context and
 * each person's time on it; the hint adds them up into the task's total (decision 68).
 * Empty when the viewer does not see the task: only its header is public.
 */
export const TaskPreview = z.object({
  visible: z.boolean(),
  /** Sanitized HTML; NULL — not described. */
  context: z.string().nullable(),
  /** Who logged time or plans to, the viewer first, then by time logged. */
  people: z.object({
    employeeId: Id,
    /** Logged to the task, all time. */
    spentMinutes: z.number().int(),
    /** Their current "time left"; NULL — none. */
    leftMinutes: z.number().int().nullable(),
  }).array(),
});
export type TaskPreview = z.infer<typeof TaskPreview>;

export const SearchInput = z.object({
  tagIds: Id.array().min(1).max(20),
  /**
   * 'mine' — open tasks I own or plan time on; 'team' — open ones my people
   * own or plan time on, down the chain; 'others' — the other open ones; 'closed' — the closed
   * ones (as in Current tasks); 'all' — any, to pick one.
   */
  tab: z.enum(['mine', 'team', 'others', 'closed', 'all']),
  page: z.number().int().min(1),
});
export type SearchInput = z.infer<typeof SearchInput>;

/** A title — its tags by name — to tell whether a task already has it. */
export const TitleInput = z.object({ tags: TagName.array().min(1).max(20) });
export type TitleInput = z.infer<typeof TitleInput>;

/** Someone who worked on tasks with these tags: how many such tasks they logged time on. */
export const Expert = z.object({ employeeId: Id, tasks: z.number().int() });
export type Expert = z.infer<typeof Expert>;

/** The task with exactly these tags; NULL — none: the title is free. */
export const TitleTaken = z.object({ id: Id }).nullable();
export type TitleTaken = z.infer<typeof TitleTaken>;

/** Everyone's time on a task together (decision 68): logged, and left in current plans. */
export const TaskHours = z.object({ taskId: Id, spentMinutes: z.number().int(), leftMinutes: z.number().int() });
export type TaskHours = z.infer<typeof TaskHours>;

export const SearchResult = z.object({
  items: TaskHeader.extend({ canSee: z.boolean() }).array(),
  /** Found tasks in each tab. */
  counts: z.object({ mine: z.number().int(), team: z.number().int(), others: z.number().int(), closed: z.number().int() }),
  /** Time left planned on the tasks found, as in Available tasks. */
  plans: z.object({ taskId: Id, minutes: z.number().int() }).array(),
  /** Everyone's time on each task found that the viewer sees, as in Available tasks. */
  hours: TaskHours.array(),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const CreateInput = z.object({
  /** Existing or new tag names; new ones are created. */
  tags: TagName.array().min(1).max(20),
  priority: Priority.optional(),
  /** NULL or left out — no deadline. */
  deadline: z.date().nullable().optional(),
  context: Html.nullable().optional(),
  /** The new task waits for this one (no latest deadline); the creator must see it. */
  waitsFor: Id.optional(),
  /** This task waits for the new one (no latest deadline); the creator must see it. */
  waitedOnBy: Id.optional(),
  /** Brought in at once, as a participant brings people in (add_observer); each is told. */
  participants: Id.array().max(100).optional(),
});
export type CreateInput = z.infer<typeof CreateInput>;

/** The owner's changes; fields left out stay. */
export const UpdateInput = z.object({
  id: Id,
  tags: TagName.array().min(1).max(20).optional(),
  priority: Priority.optional(),
  context: Html.nullable().optional(),
});
export type UpdateInput = z.infer<typeof UpdateInput>;

/** Hand a task over: the owner or the owner's direct manager picks the new owner. */
export const TransferInput = z.object({ id: Id, ownerId: Id });
export type TransferInput = z.infer<typeof TransferInput>;
