import { z } from 'zod';
import type { Comment, CommentBase, CreateCommentInput, Feed, FeedFilter, FeedItem, MentionReply } from '#shared/comment.ts';
import { AppError } from '../errors.ts';
import { cleanHtml, plainText } from '../html.ts';
import { sql, type Sql } from '../pg.ts';
import { mentionable } from './Observer.ts';
import { assertCanSee, assertReadable, headers } from './Task.ts';

export const PAGE_SIZE = 20;
const EXCERPT = 140;

const FeedRow = z.object({
  kind: z.enum(['comment', 'reply', 'deadline', 'closed', 'mentioned_in', 'spent', 'plan', 'owner']),
  at: z.date(),
  commentId: z.number().nullable(),
  from: z.date().nullable(),
  to: z.date().nullable(),
  employeeId: z.number().nullable(),
  minutes: z.number().nullable(),
  day: z.string().nullable(),
  sourceTaskId: z.number().nullable(),
  about: z.string().nullable(),
  fromId: z.number().nullable(),
  byId: z.number().nullable(),
  entries: z.object({ day: z.string(), minutes: z.number() }).array().nullable(),
});
const CommentRow = z.object({
  id: z.number(),
  createdBy: z.number(),
  createdAt: z.date(),
  value: z.string(),
  attachmentIds: z.number().array(),
  attachmentNames: z.string().array(),
  replyToId: z.number().nullable(),
  replyAuthor: z.number().nullable(),
  replyValue: z.string().nullable(),
  isNew: z.boolean(),
});
const FileRow = z.object({ id: z.number(), size: z.number(), mime: z.string(), purgedAt: z.date().nullable(), uploadedBy: z.number().array(), kept: z.boolean() });
const MentionRow = z.object({
  commentId: z.number(),
  value: z.number(),
  createdAt: z.date(),
  closedAt: z.date().nullable(),
  acceptedAt: z.date().nullable(),
});
const ReplyRow = z.object({ taskId: z.number(), commentId: z.number(), employeeId: z.number(), id: z.number(), createdAt: z.date(), value: z.string() });
const TaskMentionRow = z.object({ commentId: z.number(), value: z.number() });
const Id = z.object({ id: z.number() });
const ThreadRow = z.object({ id: z.number(), rootId: z.number() });

/** Every comment of the task with the first comment of its thread: replies to replies hang under the same one. */
const tree = (taskId: number) => sql`
  WITH RECURSIVE t AS (
    SELECT id, id AS root_id FROM comment WHERE task_id = ${taskId} AND reply_to_id IS NULL
    UNION ALL
    SELECT c.id, t.root_id FROM comment c JOIN t ON c.task_id = ${taskId} AND c.reply_to_id = t.id
  )`;

/**
 * Every event of a task: threads (by their first comment) and replies in
 * them, deadline moves (a row of finished_at; a
 * clear is a row closed without a successor), its closing by the owner
 * (a confirmed row of finished_at), comments of other tasks that
 * attach this one, time logged, and time left set or cleared (a row of
 * estimate_minutes; a clear is a row closed without a successor).
 * 'mentions' keeps only the threads with an open mention.
 */
function rawEvents(taskId: number, filter: FeedFilter) {
  const all = filter === 'all';
  const none = sql`NULL::timestamptz AS "from", NULL::timestamptz AS "to", NULL::int AS employee_id,
                   NULL::int AS minutes, NULL::text AS day, NULL::int AS source_task_id, NULL::text AS about,
                   NULL::int AS from_id, NULL::int AS by_id`;
  return sql`
    ${tree(taskId)}
    SELECT 'comment' AS kind, c.created_at AS at, c.id AS comment_id, ${none}
      FROM comment c
     WHERE c.task_id = ${taskId} AND c.reply_to_id IS NULL
       AND (${all}
            OR EXISTS (SELECT 1 FROM t JOIN mention m ON m.task_id = ${taskId} AND m.comment_id = t.id
                        WHERE t.root_id = c.id AND m.closed_at IS NULL))
    UNION ALL
    SELECT 'reply', c.created_at, c.id, ${none}
      FROM comment c
     WHERE c.task_id = ${taskId} AND c.reply_to_id IS NOT NULL AND ${all}
    UNION ALL
    SELECT 'deadline', f.entered_at, NULL, prev.value, f.value, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM finished_at f
      LEFT JOIN finished_at prev ON prev.task_id = f.task_id AND prev.expired_at = f.entered_at
     WHERE f.task_id = ${taskId} AND ${all}
    UNION ALL
    SELECT 'deadline', f.expired_at, NULL, f.value, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM finished_at f
     WHERE f.task_id = ${taskId} AND ${all} AND f.expired_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM finished_at n WHERE n.task_id = f.task_id AND n.entered_at = f.expired_at)
    UNION ALL
    SELECT 'closed', f.confirmed_at, NULL, NULL, f.value, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM finished_at f
     WHERE f.task_id = ${taskId} AND ${all} AND f.confirmed_at IS NOT NULL
    UNION ALL
    SELECT 'mentioned_in', c.created_at, NULL, NULL, NULL, NULL, NULL, NULL, tm.task_id, NULL, NULL, NULL
      FROM task_mention tm JOIN comment c ON c.task_id = tm.task_id AND c.id = tm.comment_id
     WHERE tm.value = ${taskId} AND ${all}
    UNION ALL
    SELECT 'spent', s.added_at, NULL, NULL, NULL, s."by", s.value, s.day::text, NULL, NULL, NULL, NULL
      FROM spent_minutes s
     WHERE s.task_id = ${taskId} AND ${all}
    UNION ALL
    SELECT 'plan', e.entered_at, NULL, NULL, NULL, e."by", e.value, NULL, NULL, e.about, NULL, NULL
      FROM estimate_minutes e
     WHERE e.task_id = ${taskId} AND ${all}
    UNION ALL
    SELECT 'plan', e.expired_at, NULL, NULL, NULL, e."by", NULL, NULL, NULL, NULL, NULL, NULL
      FROM estimate_minutes e
     WHERE e.task_id = ${taskId} AND ${all} AND e.expired_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM estimate_minutes n
                        WHERE n.task_id = e.task_id AND n."by" = e."by" AND n.entered_at = e.expired_at)
    UNION ALL
    SELECT 'owner', o.at, NULL, NULL, NULL, o.to_id, NULL, NULL, NULL, NULL, o.from_id, o."by"
      FROM owner_change o
     WHERE o.task_id = ${taskId} AND ${all}
  `;
}

/**
 * The events as the feed shows them: time entries of one person that follow
 * each other with nothing between them become one event (gaps and islands:
 * a run keeps the same difference between its row number in the whole feed
 * and among that person's entries).
 */
function events(taskId: number, filter: FeedFilter) {
  return sql`
    WITH e AS (${rawEvents(taskId, filter)}),
    o AS (
      SELECT e.*,
             row_number() OVER (ORDER BY at, kind, comment_id, employee_id, day)
             - row_number() OVER (PARTITION BY kind, employee_id ORDER BY at, kind, comment_id, employee_id, day) AS run
        FROM e
    )
    SELECT kind, at, comment_id, "from", "to", employee_id, minutes, day, source_task_id, about, from_id, by_id,
           NULL::jsonb AS entries
      FROM o WHERE kind <> 'spent'
    UNION ALL
    SELECT 'spent', max(at), NULL, NULL, NULL, employee_id, sum(minutes)::int, NULL, NULL, NULL, NULL, NULL,
           jsonb_agg(jsonb_build_object('day', day, 'minutes', minutes) ORDER BY day DESC, at DESC)
      FROM o WHERE kind = 'spent'
     GROUP BY employee_id, run
  `;
}

/** The feed of a task, newest first, with the counts for both filters. */
export async function list(viewerId: number, taskId: number, filter: FeedFilter, page: number): Promise<Feed> {
  await assertCanSee(taskId, viewerId);

  const rows = FeedRow.array().parse(await sql`
    SELECT * FROM (${events(taskId, filter)}) e
     ORDER BY at DESC, comment_id DESC NULLS LAST, kind
     LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
  `);
  const Count = z.object({ n: z.number() });
  const [total] = Count.array().parse(await sql`SELECT count(*)::int AS n FROM (${events(taskId, filter)}) e`);
  const [all] = Count.array().parse(await sql`SELECT count(*)::int AS n FROM (${events(taskId, 'all')}) e`);
  const [mentions] = Count.array().parse(await sql`
    SELECT count(DISTINCT comment_id)::int AS n FROM mention WHERE task_id = ${taskId} AND closed_at IS NULL
  `);

  const comments = await threads(viewerId, taskId, rows.flatMap((r) => (r.commentId === null ? [] : [r.commentId])));
  const sources = new Map((await headers(viewerId, [...new Set(rows.flatMap((r) => r.sourceTaskId ?? []))])).map((h) => [h.id, h]));
  const items: FeedItem[] = rows.flatMap((r): FeedItem[] => {
    switch (r.kind) {
      case 'comment': {
        const comment = comments.threads.get(r.commentId!);
        return comment ? [comment] : [];
      }
      case 'reply': {
        const thread = comments.threads.get(comments.rootOf.get(r.commentId!) ?? -1);
        const reply = thread?.replies.find((c) => c.id === r.commentId);
        if (!thread || !reply) return [];
        const to = reply.replyTo?.authorId ?? thread.authorId;
        return [{
          kind: 'reply', at: r.at, commentId: reply.id, authorId: reply.authorId, toAuthorId: to,
          excerpt: plainText(reply.html).slice(0, EXCERPT), thread,
        }];
      }
      case 'deadline':
        return [{ kind: 'deadline', at: r.at, from: r.from, to: r.to }];
      case 'closed':
        return [{ kind: 'closed', at: r.at, deadline: r.to! }];
      case 'mentioned_in': {
        const task = sources.get(r.sourceTaskId!);
        return task ? [{ kind: 'mentioned_in', at: r.at, task }] : [];
      }
      case 'spent':
        return [{ kind: 'spent', at: r.at, employeeId: r.employeeId!, minutes: r.minutes!, entries: r.entries ?? [] }];
      case 'plan':
        return [{ kind: 'plan', at: r.at, employeeId: r.employeeId!, minutes: r.minutes, about: r.about }];
      case 'owner':
        return [{ kind: 'owner', at: r.at, fromId: r.fromId, toId: r.employeeId, byId: r.byId }];
    }
  });
  return { items, total: total?.n ?? 0, openMentions: mentions?.n ?? 0, all: all?.n ?? 0 };
}

/**
 * The comments by others in my task since my review, oldest first: the
 * table the review opens (decision 94). The owner only.
 */
export async function unreviewed(viewerId: number, taskId: number): Promise<CommentBase[]> {
  const ids = z.object({ id: z.number() }).array().parse(await sql`
    SELECT c.id FROM comment c JOIN task k ON k.id = c.task_id
     WHERE c.task_id = ${taskId} AND k.owner_id = ${viewerId} AND c.created_by <> ${viewerId}
       AND c.created_at > COALESCE(k.reviewed_at, k.handed_at, '-infinity')
     ORDER BY c.created_at, c.id
  `).map((r) => r.id);
  if (ids.length === 0) await sql`SELECT check_owner(${taskId}, ${viewerId})`;
  const loaded = await load(viewerId, taskId, ids);
  return ids.flatMap((id) => loaded.get(id) ?? []);
}

/**
 * The threads these comments are in, keyed by their first comment, and the
 * first comment of each of them: replies come under it, oldest first.
 */
async function threads(viewerId: number, taskId: number, ids: number[]) {
  const members = ThreadRow.array().parse(await sql`
    ${tree(taskId)}
    SELECT id, root_id FROM t WHERE root_id IN (SELECT root_id FROM t WHERE id = ANY(${ids}))
  `);
  const loaded = await load(viewerId, taskId, members.map((m) => m.id));
  const rootOf = new Map(members.map((m) => [m.id, m.rootId]));
  const result = new Map<number, Comment>();
  for (const m of [...members].sort((a, b) => a.id - b.id)) {
    const comment = loaded.get(m.id);
    if (!comment) continue;
    if (m.id === m.rootId) result.set(m.id, { ...comment, replies: result.get(m.id)?.replies ?? [] });
  }
  for (const m of [...members].sort((a, b) => a.id - b.id)) {
    const comment = loaded.get(m.id);
    if (comment && m.id !== m.rootId) result.get(m.rootId)?.replies.push(comment);
  }
  return { threads: result, rootOf };
}

async function load(viewerId: number, taskId: number, ids: number[]): Promise<Map<number, CommentBase>> {
  if (ids.length === 0) return new Map();
  const rows = CommentRow.array().parse(await sql`
    SELECT c.id, c.created_by, c.created_at, c.value, c.attachment_ids, c.attachment_names, c.reply_to_id,
           r.created_by AS reply_author, r.value AS reply_value,
           (k.owner_id = ${viewerId} AND c.created_by <> k.owner_id
            AND c.created_at > COALESCE(k.reviewed_at, k.handed_at, '-infinity')) IS TRUE AS is_new
      FROM comment c
      JOIN task k ON k.id = c.task_id
      LEFT JOIN comment r ON r.task_id = c.task_id AND r.id = c.reply_to_id
     WHERE c.task_id = ${taskId} AND c.id = ANY(${ids})
  `);
  const fileIds = [...new Set(rows.flatMap((r) => r.attachmentIds))];
  const files = new Map(
    FileRow.array().parse(await sql`SELECT id, size, mime, purged_at, uploaded_by, held_by @> ARRAY[${viewerId}::int] AS kept FROM attachment WHERE id = ANY(${fileIds})`).map((f) => [f.id, f]),
  );
  const mentions = MentionRow.array().parse(await sql`
    SELECT m.comment_id, m.value, m.created_at, m.closed_at, m.accepted_at
      FROM mention m
     WHERE m.task_id = ${taskId} AND m.comment_id = ANY(${ids}) ORDER BY m.value
  `);
  const answers = await mentionReplies(mentions.map((m) => ({ taskId, commentId: m.commentId, employeeId: m.value })));
  const taskMentions = TaskMentionRow.array().parse(await sql`
    SELECT comment_id, value FROM task_mention WHERE task_id = ${taskId} AND comment_id = ANY(${ids})
  `);
  const tasks = new Map((await headers(viewerId, [...new Set(taskMentions.map((m) => m.value))])).map((h) => [h.id, h]));

  return new Map(rows.map((r) => [r.id, {
    kind: 'comment',
    id: r.id,
    authorId: r.createdBy,
    at: r.createdAt,
    html: r.value,
    replyTo: r.replyToId === null
      ? null
      : { id: r.replyToId, authorId: r.replyAuthor!, excerpt: plainText(r.replyValue ?? '').slice(0, EXCERPT) },
    files: r.attachmentIds.flatMap((id, i) => {
      const f = files.get(id);
      return f ? [{ id, name: r.attachmentNames[i] ?? '', size: f.size, mime: f.mime, purgedAt: f.purgedAt, uploadedBy: f.uploadedBy, kept: f.kept }] : [];
    }),
    mentions: mentions.filter((m) => m.commentId === r.id).map((m) => ({
      employeeId: m.value,
      createdAt: m.createdAt,
      closedAt: m.closedAt,
      acceptedAt: m.acceptedAt,
      replies: answers.get(replyKey(taskId, m.commentId, m.value)) ?? [],
    })),
    tasks: taskMentions.filter((m) => m.commentId === r.id).flatMap((m) => tasks.get(m.value) ?? []),
    isNew: r.isNew,
  } satisfies CommentBase]));
}

/**
 * Leaves a comment. Notifies the owner, the mentioned employees and the
 * owners of attached tasks — never the author. "All participants" mentions
 * every person in the task but the author and the exceptions (decision 95);
 * someone away is copied to their manager unless the manager is mentioned
 * here too.
 */
export async function create(authorId: number, input: CreateCommentInput): Promise<number> {
  const clean = cleanHtml(input.html);
  if (clean.html === null) throw new AppError('invalid_data');

  return sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    await assertCanSee(input.taskId, authorId, db);
    await assertReadable([...input.files.map((f) => f.id), ...clean.imageIds], authorId, db);

    const [row] = Id.array().parse(await db`
      INSERT INTO comment (task_id, created_by, value, attachment_ids, attachment_names, image_ids, reply_to_id)
      VALUES (${input.taskId}, ${authorId}, ${clean.html},
              ${input.files.map((f) => f.id)}, ${input.files.map((f) => f.name)},
              ${clean.imageIds}, ${input.replyToId})
      RETURNING id
    `);
    const commentId = row!.id;

    const everyone = input.everyone ? (await mentionable(authorId, input.taskId, db)).people : [];
    const mentionIds = [...new Set([...input.mentionIds, ...everyone.filter((id) => id !== authorId && !input.exceptIds.includes(id))])];
    for (const employeeId of mentionIds) {
      await db`INSERT INTO mention (task_id, comment_id, value) VALUES (${input.taskId}, ${commentId}, ${employeeId})`;
    }
    for (const employeeId of mentionIds) {
      await db`SELECT notify(${employeeId}, ${input.taskId}, ${db.json({ kind: 'mention', by: authorId, commentId })}, ${mentionIds}::int[])`;
    }

    for (const taskId of new Set(input.taskIds)) {
      await db`INSERT INTO task_mention (task_id, comment_id, value) VALUES (${input.taskId}, ${commentId}, ${taskId})`;
      await db`
        SELECT notify(owner_id, id, ${db.json({ kind: 'task_mention', by: authorId, commentId })})
          FROM task WHERE id = ${taskId} AND owner_id IS NOT NULL AND owner_id <> ${authorId}
      `;
    }

    await db`
      SELECT notify(owner_id, id, ${db.json({ kind: 'comment', by: authorId, commentId })})
        FROM task WHERE id = ${input.taskId} AND owner_id IS NOT NULL AND owner_id <> ${authorId}
    `;
    return commentId;
  });
}

/** The comment, if it is the author's: only they add, delete and accept its mentions. */
async function assertAuthor(authorId: number, taskId: number, commentId: number, db: Sql = sql): Promise<void> {
  await assertCanSee(taskId, authorId, db);
  const rows = z.object({ createdBy: z.number() }).array().parse(await db`
    SELECT created_by FROM comment WHERE task_id = ${taskId} AND id = ${commentId}
  `);
  if (rows.length === 0) throw new AppError('not_found');
  if (rows[0]!.createdBy !== authorId) throw new AppError('forbidden');
}

/** The author mentions someone in a comment already left: counted from now, notified as usual. */
export async function addMention(authorId: number, taskId: number, commentId: number, employeeId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    await assertAuthor(authorId, taskId, commentId, db);
    await db`INSERT INTO mention (task_id, comment_id, value) VALUES (${taskId}, ${commentId}, ${employeeId})`;
    await db`SELECT notify(${employeeId}, ${taskId}, ${db.json({ kind: 'mention', by: authorId, commentId })})`;
  });
}

/** The author takes a mention back, until its first reaction (trigger). */
export async function removeMention(authorId: number, taskId: number, commentId: number, employeeId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    await assertAuthor(authorId, taskId, commentId, db);
    const rows = await db`
      DELETE FROM mention WHERE task_id = ${taskId} AND comment_id = ${commentId} AND value = ${employeeId} RETURNING value
    `;
    if (rows.length === 0) throw new AppError('not_found');
  });
}

/** "Accepted": the author accepts every mention of the comment with a reaction (db.sql, accept_mentions). */
export async function acceptMentions(authorId: number, taskId: number, commentId: number): Promise<void> {
  await assertCanSee(taskId, authorId);
  await sql`SELECT accept_mentions(${taskId}, ${commentId}, ${authorId})`;
}

/** "Done" or "No reply needed": the mentioned employee closes their own mention, a reply or not (decision 95). */
export async function closeMention(employeeId: number, taskId: number, commentId: number): Promise<void> {
  const rows = await sql`
    UPDATE mention SET closed_at = NOW()
     WHERE task_id = ${taskId} AND comment_id = ${commentId} AND value = ${employeeId} AND closed_at IS NULL
    RETURNING value
  `;
  if (rows.length === 0) throw new AppError('not_found');
}

export const replyKey = (taskId: number, commentId: number, employeeId: number) => `${taskId}/${commentId}/${employeeId}`;

/**
 * The answers of each mention, oldest first: the replies to the mentioning
 * comment by the person mentioned, since they were mentioned. Keyed by replyKey().
 */
export async function mentionReplies(keys: { taskId: number; commentId: number; employeeId: number }[]): Promise<Map<string, MentionReply[]>> {
  if (keys.length === 0) return new Map();
  const rows = ReplyRow.array().parse(await sql`
    SELECT m.task_id, m.comment_id, m.employee_id, r.id, r.created_at, r.value
      FROM unnest(${keys.map((k) => k.taskId)}::int[], ${keys.map((k) => k.commentId)}::int[], ${keys.map((k) => k.employeeId)}::int[])
           AS m(task_id, comment_id, employee_id)
      JOIN mention mm ON mm.task_id = m.task_id AND mm.comment_id = m.comment_id AND mm.value = m.employee_id
      JOIN comment r ON r.task_id = m.task_id AND r.reply_to_id = m.comment_id AND r.created_by = m.employee_id
                    AND r.created_at >= mm.created_at
     ORDER BY r.id
  `);
  const result = new Map<string, MentionReply[]>();
  for (const r of rows) {
    const key = replyKey(r.taskId, r.commentId, r.employeeId);
    result.set(key, [...(result.get(key) ?? []), { id: r.id, at: r.createdAt, excerpt: plainText(r.value).slice(0, EXCERPT) }]);
  }
  return result;
}
