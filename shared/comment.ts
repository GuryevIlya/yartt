import { z } from 'zod';
import { Day, Id } from './employee.ts';
import { Html, TaskHeader } from './task.ts';

// The feed of a task: comments and deadline moves, newest first.

export const FileRef = z.object({
  id: Id,
  name: z.string(),
  size: z.number().int(),
  mime: z.string(),
  /** Its content was deleted (decision 84): the same file uploaded again brings it back. */
  purgedAt: z.date().nullable(),
  /** Who uploaded it. */
  uploadedBy: Id.array(),
  /** I keep it in my files: it stays for me whoever else lets it go. */
  kept: z.boolean(),
});
export type FileRef = z.infer<typeof FileRef>;

/** An answer to a mention: a reply to the mentioning comment by the mentioned employee, after they were mentioned. Shown inside the mention. */
export const MentionReply = z.object({
  id: Id,
  at: z.date(),
  /** The beginning of the reply as plain text. */
  excerpt: z.string(),
});
export type MentionReply = z.infer<typeof MentionReply>;

/**
 * A mention is open until the mentioned closes it, after a reply or with
 * "No reply needed" (decision 95).
 */
export const Mention = z.object({
  employeeId: Id,
  /** When they were mentioned: later than the comment if its author added them afterwards. */
  createdAt: z.date(),
  /** NULL — open. */
  closedAt: z.date().nullable(),
  /** Oldest first; empty — not answered. A closed one without replies was closed without a reply. */
  replies: MentionReply.array(),
});
export type Mention = z.infer<typeof Mention>;

/** The reactions to a mention, newest first: its replies and its closing. */
export function reactions(m: Pick<Mention, 'closedAt' | 'replies'>): Date[] {
  return [...m.replies.map((r) => r.at), ...(m.closedAt ? [m.closedAt] : [])].sort((a, b) => b.getTime() - a.getTime());
}

/** The newest reaction of these mentions after `since` (none — any); undefined — nothing new. */
export function newestReaction(mentions: Pick<Mention, 'closedAt' | 'replies'>[], since: Date | null): Date | undefined {
  const all = mentions.flatMap(reactions).filter((at) => since === null || at > since);
  return all.sort((a, b) => b.getTime() - a.getTime())[0];
}

/**
 * The comment waits for its author's "No intervention needed" (decision
 * 98): it has mentions and was never reviewed, or a reaction came after.
 */
export function awaitsReview(c: { mentions: Pick<Mention, 'closedAt' | 'replies'>[]; reviewedAt: Date | null }): boolean {
  return c.mentions.length > 0 && (c.reviewedAt === null || newestReaction(c.mentions, c.reviewedAt) !== undefined);
}

/** One comment: a thread's first one, or a reply in it. */
export const CommentBase = z.object({
  kind: z.literal('comment'),
  id: Id,
  authorId: Id,
  at: z.date(),
  /** Sanitized HTML. */
  html: z.string(),
  replyTo: z.object({ id: Id, authorId: Id, excerpt: z.string() }).nullable(),
  files: FileRef.array(),
  mentions: Mention.array(),
  tasks: TaskHeader.array(),
  /** Written by someone else after the owner's last "No intervention needed"; only for the owner. */
  isNew: z.boolean(),
  /** Up to when its author has seen the reactions to its mentions (decision 98); NULL — never. */
  reviewedAt: z.date().nullable(),
});
export type CommentBase = z.infer<typeof CommentBase>;

/**
 * A thread: the first comment and every reply under it — replies to its
 * replies too — oldest first. Replies are read under what they answer, not
 * scattered over the feed.
 */
export const Comment = CommentBase.extend({ replies: CommentBase.array() });
export type Comment = z.infer<typeof Comment>;

/**
 * Someone replied in a thread: a line at the moment of the reply, so the
 * feed keeps its order of time while the reply itself lives in its thread.
 */
export const ReplyEvent = z.object({
  kind: z.literal('reply'),
  at: z.date(),
  /** The reply. */
  commentId: Id,
  authorId: Id,
  /** Whom it answers: the author of the comment replied to. */
  toAuthorId: Id,
  excerpt: z.string(),
  /** The whole thread, to unfold in place. */
  thread: Comment,
});
export type ReplyEvent = z.infer<typeof ReplyEvent>;

/** A deadline set, moved or cleared. */
export const DeadlineEvent = z.object({
  kind: z.literal('deadline'),
  at: z.date(),
  from: z.date().nullable(),
  to: z.date().nullable(),
});
export type DeadlineEvent = z.infer<typeof DeadlineEvent>;

/** The owner closed the task (decision 93); `at` later than `deadline` — after it had passed. */
export const ClosedEvent = z.object({
  kind: z.literal('closed'),
  at: z.date(),
  deadline: z.date(),
});
export type ClosedEvent = z.infer<typeof ClosedEvent>;

/** A comment of another task attached this one. */
export const MentionedInEvent = z.object({
  kind: z.literal('mentioned_in'),
  at: z.date(),
  /** The header only: the other task may be one the viewer does not see. */
  task: TaskHeader,
});
export type MentionedInEvent = z.infer<typeof MentionedInEvent>;

/**
 * Someone logged time to the task (spent_minutes). Entries of one person in
 * a row — nothing else between them in the feed — come as one event.
 */
export const SpentEvent = z.object({
  kind: z.literal('spent'),
  /** The latest entry. */
  at: z.date(),
  employeeId: Id,
  /** The sum. */
  minutes: z.number().int(),
  /** Each entry, the latest day first: one for a single entry. */
  entries: z.object({ day: Day, minutes: z.number().int() }).array().min(1),
});
export type SpentEvent = z.infer<typeof SpentEvent>;

/** Someone set or cleared their time left (estimate_minutes). */
export const PlanEvent = z.object({
  kind: z.literal('plan'),
  at: z.date(),
  employeeId: Id,
  /** NULL — cleared. */
  minutes: z.number().int().nullable(),
  /** What the plan is for, in their words; NULL — not said. */
  about: z.string().nullable(),
});
export type PlanEvent = z.infer<typeof PlanEvent>;

/** The owner changed (owner_change, decision 96). */
export const OwnerEvent = z.object({
  kind: z.literal('owner'),
  at: z.date(),
  /** NULL — the task had no owner, or, with byId NULL, it is not known. */
  fromId: Id.nullable(),
  /** NULL — the task was left without one. */
  toId: Id.nullable(),
  /** Who changed it; NULL — not known (before 0.6). */
  byId: Id.nullable(),
});
export type OwnerEvent = z.infer<typeof OwnerEvent>;

export const FeedItem = z.discriminatedUnion('kind', [Comment, ReplyEvent, DeadlineEvent, ClosedEvent, MentionedInEvent, SpentEvent, PlanEvent, OwnerEvent]);
export type FeedItem = z.infer<typeof FeedItem>;

/**
 * 'mentions' — only threads with open mentions; 'all' — every thread and
 * event: replies, deadline moves, mentions in other tasks, time logged and
 * planned, owner changes.
 */
export const FeedFilter = z.enum(['mentions', 'all']);
export type FeedFilter = z.infer<typeof FeedFilter>;

export const Feed = z.object({
  items: FeedItem.array(),
  /** Items under the current filter. */
  total: z.number().int(),
  openMentions: z.number().int(),
  /** Comments and events together. */
  all: z.number().int(),
});
export type Feed = z.infer<typeof Feed>;

export const CreateCommentInput = z.object({
  taskId: Id,
  html: Html.min(1),
  replyToId: Id.nullable(),
  files: z.object({ id: Id, name: z.string().trim().min(1).max(255) }).array().max(50),
  mentionIds: Id.array().max(50),
  /** "All participants": a mention of every person in the task (Observer.mentionable, `people`) but the author and `exceptIds`. */
  everyone: z.boolean().default(false),
  exceptIds: Id.array().max(1000).default([]),
  taskIds: Id.array().max(50),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInput>;

/** A file I uploaded, in My files (decision 84). */
export const MyFile = z.object({
  id: Id,
  /** I keep it: it counts in my quota. False — I uploaded it and let it go. */
  held: z.boolean(),
  /** How many keep it: let go by the last one, its content is deleted. */
  holders: z.number().int(),
  size: z.number().int(),
  mime: z.string(),
  addedAt: z.date(),
  /** Uploaded again or attached last: a big file keeps its content a while after it. */
  usedAt: z.date(),
  /** NULL — the content is here and counts in my quota. */
  purgedAt: z.date().nullable(),
  /** The names it goes by in comments; empty — not attached anywhere yet. */
  names: z.string().array(),
  /** The tasks it is in. */
  taskIds: Id.array(),
});
export type MyFile = z.infer<typeof MyFile>;

export const MyFiles = z.object({
  files: MyFile.array(),
  usedBytes: z.number(),
  quotaBytes: z.number(),
});
export type MyFiles = z.infer<typeof MyFiles>;
