import { z } from 'zod';
import type { Current, CurrentTab, DayHistory, History, TodoItem, WaitingItem, WaitingMention } from '#shared/myDay.ts';
import { plainText } from '../html.ts';
import { sql } from '../pg.ts';
import { mentionReplies, replyKey } from './Comment.ts';
import { headers, hours, plans, whose } from './Task.ts';

export const PAGE_SIZE = 20;
/** Days with activity per page of History. */

const EXCERPT = 140;

const MentionRow = z.object({
  taskId: z.number(),
  commentId: z.number(),
  createdBy: z.number(),
  createdAt: z.date(),
  value: z.string(),
});
const CommentsRow = z.object({ taskId: z.number(), at: z.date(), n: z.number(), authorIds: z.number().array() });
const RequestRow = z.object({ taskId: z.number(), employeeId: z.number() });
const RemindRow = z.object({ taskId: z.number(), at: z.date(), text: z.string().nullable() });
const DeadlineRow = z.object({
  taskId: z.number(),
  at: z.date(),
  /** When it became a notice: the deadline itself once passed, a day before it (or when set, if later) before. */
  noticeAt: z.date(),
  overdue: z.boolean(),
  plans: z.object({ employeeId: z.number(), minutes: z.number(), about: z.string().nullable() }).array(),
});
const LinkRow = z.object({ taskId: z.number(), other: z.number(), waits: z.boolean(), by: z.number(), at: z.date() });
const DoneRow = z.object({ taskId: z.number(), value: z.number(), at: z.date() });
const HandedRow = z.object({ taskId: z.number(), at: z.date().nullable(), unreviewed: z.boolean() });
const PlanRow = z.object({ taskId: z.number(), at: z.date(), minutes: z.number(), about: z.string().nullable() });

/** Since when the owner of task `k` has not reviewed it: what came after is their review (decision 94). */
const since = () => sql`COALESCE(k.reviewed_at, k.handed_at, '-infinity')`;

/** Groups of one task in the order they are shown: what blocks the review first. */
const ORDER: TodoItem['kind'][] = ['request', 'review', 'mention', 'remind', 'plan_left'];

/**
 * What waits for my reaction (decision 94): tasks, each with its groups —
 * access requests to my tasks, the review of my tasks (what came since I
 * last looked: comments by others, dependencies added by others, tasks
 * mine waits for done, its deadline a day ahead or passed — or, handed to
 * me and not accepted yet, the handover alone), open mentions of me, my reminders that came due, and overdue
 * tasks with my time still planned on them. The tasks go by deadline, the
 * overdue and the nearest first, those without one or closed last; the same
 * deadline, the newer task first. All of it is computed from the data:
 * nothing is marked as sent. `viewerId` — a manager looking at it on the
 * employee's page: then the employee's reminders, theirs alone, are left
 * out, and so are mentions in tasks the manager does not see. `taskId` —
 * that task's only, for its page.
 */
export async function todo(me: number, viewerId: number = me, taskId?: number): Promise<TodoItem[]> {
  const only = (column: ReturnType<typeof since>) => (taskId === undefined ? sql`` : sql`AND ${column} = ${taskId}`);
  const requests = RequestRow.array().parse(await sql`
    SELECT o.task_id, o.value AS employee_id
      FROM observer o JOIN task k ON k.id = o.task_id
     WHERE k.owner_id = ${me} AND o.added_at IS NULL AND o.deleted_at IS NULL ${only(sql`k.id`)}
     ORDER BY o.id DESC
  `);
  // A mention in a task I no longer see cannot be answered: it is not shown.
  const mentions = MentionRow.array().parse(await sql`
    SELECT m.task_id, m.comment_id, c.created_by, c.created_at, c.value
      FROM mention m
      JOIN comment c ON c.task_id = m.task_id AND c.id = m.comment_id
     WHERE m.value = ${me} AND m.closed_at IS NULL AND can_see(m.task_id, ${me}) AND can_see(m.task_id, ${viewerId})
       ${only(sql`m.task_id`)}
     ORDER BY c.created_at DESC
  `);
  const answers = await mentionReplies(mentions.map((m) => ({ taskId: m.taskId, commentId: m.commentId, employeeId: me })));

  // The review of my tasks: each kind of notice since I last looked.
  const comments = CommentsRow.array().parse(await sql`
    SELECT k.id AS task_id, max(c.created_at) AS at, count(*)::int AS n,
           array_agg(c.created_by ORDER BY c.created_at) AS author_ids
      FROM task k JOIN comment c ON c.task_id = k.id
     WHERE k.owner_id = ${me} AND c.created_by <> ${me} AND c.created_at > ${since()} ${only(sql`k.id`)}
     GROUP BY k.id
  `);
  const links = LinkRow.array().parse(await sql`
    SELECT k.id AS task_id, d.value AS other, TRUE AS waits, d.added_by AS by, d.added_at AS at
      FROM task k JOIN dependency d ON d.task_id = k.id
     WHERE k.owner_id = ${me} AND d.added_by <> ${me} AND d.added_at > ${since()} ${only(sql`k.id`)}
    UNION ALL
    SELECT k.id, d.task_id, FALSE, d.added_by, d.added_at
      FROM task k JOIN dependency d ON d.value = k.id
     WHERE k.owner_id = ${me} AND d.added_by <> ${me} AND d.added_at > ${since()} ${only(sql`k.id`)}
     ORDER BY at
  `);
  // Done by someone else — closed by its owner: what I closed myself I know of.
  const done = DoneRow.array().parse(await sql`
    SELECT k.id AS task_id, d.value, d.done_at AS at
      FROM dependency d JOIN task k ON k.id = d.task_id JOIN task v ON v.id = d.value
     WHERE k.owner_id = ${me} AND d.done_at IS NOT NULL AND v.owner_id IS DISTINCT FROM ${me}
       AND d.done_at > ${since()} ${only(sql`k.id`)}
     ORDER BY d.done_at
  `);
  // A deadline reminds, it never closes (decision 93): a day ahead, until a
  // review after that, then overdue until the owner closes the task or moves it.
  const deadlines = DeadlineRow.array().parse(await sql`
    SELECT task_id, at, notice_at, overdue, plans FROM (
      SELECT f.task_id, f.value AS at, f.value <= NOW() AS overdue,
             CASE WHEN f.value <= NOW() THEN f.value ELSE GREATEST(f.value - INTERVAL '1 day', f.entered_at) END AS notice_at,
             ${since()} AS since,
             COALESCE((SELECT json_agg(json_build_object('employeeId', e."by", 'minutes', e.value, 'about', e.about) ORDER BY e.entered_at)
                         FROM estimate_minutes e WHERE e.task_id = k.id AND e.expired_at IS NULL), '[]') AS plans
        FROM task k JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
       WHERE k.owner_id = ${me} AND f.confirmed_at IS NULL ${only(sql`k.id`)}
         AND (f.value <= NOW() OR (f.value <= NOW() + INTERVAL '1 day' AND f.value - f.entered_at > INTERVAL '1 minute'))
    ) t
     WHERE overdue OR notice_at > since
  `);
  // Every task of mine with a notice, and whether it came to me and I have not accepted it.
  const reviewed = [...new Set([...comments, ...links, ...done, ...deadlines].map((r) => r.taskId))];
  const handed = HandedRow.array().parse(await sql`
    SELECT k.id AS task_id, k.handed_at AS at, k.reviewed_at IS NULL AS unreviewed
      FROM task k
     WHERE k.owner_id = ${me} ${only(sql`k.id`)}
       AND (k.id = ANY(${reviewed}) OR (k.reviewed_at IS NULL AND k.handed_at IS NOT NULL))
  `);

  // Leaving a task deletes its reminders: a due one is on a task I see.
  const reminds = viewerId !== me ? [] : RemindRow.array().parse(await sql`
    SELECT task_id, at, value AS text FROM remind WHERE employee_id = ${me} AND sent_at IS NOT NULL ${only(sql`task_id`)}
     ORDER BY at
  `);
  // Overdue, yet my time is still planned on it: its owner closes it only once it is cleared.
  const plansLeft = PlanRow.array().parse(await sql`
    SELECT e.task_id, f.value AS at, e.value AS minutes, e.about
      FROM estimate_minutes e JOIN finished_at f ON f.task_id = e.task_id AND f.expired_at IS NULL
     WHERE e."by" = ${me} AND e.expired_at IS NULL AND f.value <= NOW() AND f.confirmed_at IS NULL ${only(sql`e.task_id`)}
  `);

  const ids = [...new Set([
    ...[...requests, ...mentions, ...handed, ...reminds, ...plansLeft].map((r) => r.taskId),
    ...links.map((l) => l.other),
    ...done.map((d) => d.value),
  ])];
  const tasks = new Map((await headers(me, ids)).map((h) => [h.id, h]));

  const items: TodoItem[] = [
    ...requests.flatMap((r) => {
      const task = tasks.get(r.taskId);
      return task ? [{ kind: 'request' as const, task, employeeId: r.employeeId }] : [];
    }),
    ...handed.flatMap((h): TodoItem[] => {
      const task = tasks.get(h.taskId);
      if (!task) return [];
      // Handed to me and not accepted yet: the handover alone, accepted by one press.
      if (h.unreviewed && h.at) {
        return [{
          kind: 'review', task, at: h.at, comments: null, handedAt: h.at, links: [], done: [], deadline: null,
        }];
      }
      const c = comments.find((r) => r.taskId === h.taskId);
      const deadline = deadlines.find((r) => r.taskId === h.taskId);
      const review = {
        comments: c ? { count: c.n, authorIds: [...new Set(c.authorIds)], at: c.at } : null,
        handedAt: null,
        links: links.filter((l) => l.taskId === h.taskId).flatMap((l) => {
          const other = tasks.get(l.other);
          return other ? [{ task: other, waits: l.waits, by: l.by, at: l.at }] : [];
        }),
        done: done.filter((d) => d.taskId === h.taskId).flatMap((d) => {
          const other = tasks.get(d.value);
          return other ? [{ task: other, at: d.at }] : [];
        }),
        deadline: deadline ? { at: deadline.at, overdue: deadline.overdue, plans: deadline.plans } : null,
      };
      const moments = [
        review.comments?.at, deadline?.noticeAt,
        ...review.links.map((l) => l.at), ...review.done.map((d) => d.at),
      ].filter((d) => d instanceof Date);
      if (moments.length === 0) return [];
      const at = new Date(Math.max(...moments.map((d) => d.getTime())));
      return [{ kind: 'review', task, at, ...review }];
    }),
    ...mentions.flatMap((m) => {
      const task = tasks.get(m.taskId);
      return task
        ? [{
            kind: 'mention' as const, task, commentId: m.commentId, authorId: m.createdBy, at: m.createdAt,
            excerpt: plainText(m.value).slice(0, EXCERPT),
            replies: answers.get(replyKey(m.taskId, m.commentId, me)) ?? [],
          }]
        : [];
    }),
    ...reminds.flatMap((r) => {
      const task = tasks.get(r.taskId);
      return task ? [{ kind: 'remind' as const, task, at: r.at, text: r.text }] : [];
    }),
    ...plansLeft.flatMap((r) => {
      const task = tasks.get(r.taskId);
      return task ? [{ kind: 'plan_left' as const, task, at: r.at, minutes: r.minutes, about: r.about }] : [];
    }),
  ];
  // By deadline, the overdue and the nearest first; no deadline or closed last; then the newer task.
  const urgency = (t: TodoItem['task']) => (t.deadline === null || t.closed ? Infinity : t.deadline.getTime());
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => urgency(a.item.task) - urgency(b.item.task)
      || b.item.task.id - a.item.task.id
      || ORDER.indexOf(a.item.kind) - ORDER.indexOf(b.item.kind)
      || a.i - b.i)
    .map((x) => x.item);
}

const MyMentionRow = z.object({
  taskId: z.number(),
  commentId: z.number(),
  employeeId: z.number(),
  createdAt: z.date(),
  closedAt: z.date().nullable(),
  value: z.string(),
});

/**
 * What I wait for from others (decision 67): my access requests not
 * answered yet, then my comments with mentions I have not accepted
 * (decision 95) — open, or closed with or without a reply — the longest
 * waiting first, with their answers. A mention in a task I no longer see
 * is not shown.
 */
export async function waiting(me: number, viewerId: number = me): Promise<WaitingItem[]> {
  const requests = z.object({ taskId: z.number() }).array().parse(await sql`
    SELECT task_id FROM observer
     WHERE value = ${me} AND added_at IS NULL AND deleted_at IS NULL
     ORDER BY id
  `);
  const mentions = MyMentionRow.array().parse(await sql`
    SELECT m.task_id, m.comment_id, m.value AS employee_id, m.created_at, m.closed_at, c.value
      FROM mention m
      JOIN comment c ON c.task_id = m.task_id AND c.id = m.comment_id
     WHERE c.created_by = ${me} AND m.accepted_at IS NULL AND can_see(m.task_id, ${me}) AND can_see(m.task_id, ${viewerId})
     ORDER BY m.created_at, m.task_id, m.comment_id, m.value
  `);
  const answers = await mentionReplies(mentions.map((m) => ({ taskId: m.taskId, commentId: m.commentId, employeeId: m.employeeId })));
  const tasks = new Map((await headers(me, [...new Set([...requests, ...mentions].map((r) => r.taskId))])).map((h) => [h.id, h]));
  const comments = new Map<string, WaitingMention>();
  for (const m of mentions) {
    const task = tasks.get(m.taskId);
    if (!task) continue;
    const key = `${m.taskId}/${m.commentId}`;
    const item = comments.get(key) ?? {
      kind: 'mention' as const, task, commentId: m.commentId, at: m.createdAt,
      excerpt: plainText(m.value).slice(0, EXCERPT), people: [],
    };
    item.people.push({
      employeeId: m.employeeId, at: m.createdAt, closedAt: m.closedAt,
      replies: answers.get(replyKey(m.taskId, m.commentId, m.employeeId)) ?? [],
    });
    comments.set(key, item);
  }
  return [
    ...requests.flatMap((r) => {
      const task = tasks.get(r.taskId);
      return task ? [{ kind: 'request' as const, task }] : [];
    }),
    ...comments.values(),
  ];
}

/**
 * Tasks I see — public ones included (decision 14): the open ones (not
 * closed by their owner, overdue included — decision 93) I own or plan time on, those my people own or plan
 * time on (down the chain — decision 85), or
 * all the other open ones, by deadline, nearest first, the same moment and
 * no deadline by priority; or the closed ones, the most recently closed
 * first (decision 57).
 */
export async function current(me: number, tab: CurrentTab, page: number): Promise<Current> {
  const seen = sql`
    SELECT k.id, k.owner_id, k.priority, f.value AS deadline, f.confirmed_at AS closed_at, f.confirmed_at IS NOT NULL AS closed,
           ${whose(me)} AS whose
      FROM task k
      LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
     WHERE can_see(k.id, ${me})
  `;
  const ids = z.object({ id: z.number() }).array().parse(await sql`
    SELECT id FROM (${seen}) t
     WHERE ${tab === 'closed' ? sql`closed` : sql`NOT closed AND whose = ${tab}`}
     ORDER BY ${tab === 'closed' ? sql`closed_at DESC, priority DESC, id DESC` : sql`deadline NULLS LAST, priority DESC, id DESC`}
     LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
  `).map((r) => r.id);
  const [counts] = z.object({ mine: z.number(), team: z.number(), others: z.number(), closed: z.number() }).array().parse(await sql`
    SELECT count(*) FILTER (WHERE NOT closed AND whose = 'mine')::int AS mine,
           count(*) FILTER (WHERE NOT closed AND whose = 'team')::int AS team,
           count(*) FILTER (WHERE NOT closed AND whose = 'others')::int AS others,
           count(*) FILTER (WHERE closed)::int AS closed
      FROM (${seen}) t
  `);
  return { items: await headers(me, ids), counts: counts!, plans: await plans(me, tab, ids), hours: await hours(me, ids) };
}

const DayRow = z.object({ day: z.string() });
const TodayRow = z.object({ today: z.string() });
const ShiftRow = z.object({
  day: z.string(),
  startedAt: z.date(),
  spentMinutes: z.number().nullable(),
  about: z.string().nullable(),
});
const EntryRow = z.object({ day: z.string(), id: z.number(), taskId: z.number(), minutes: z.number(), updatedAt: z.date() });
const VisitRow = z.object({ day: z.string(), taskId: z.number().nullable(), at: z.date() });
const ActivityRow = z.object({ day: z.string(), first: z.date(), last: z.date() });
const ActionRow = z.object({ day: z.string(), kind: z.enum(['comment', 'time']), taskId: z.number(), at: z.date() });
const ScoreRow = z.object({ day: z.string(), value: z.number().nullable(), reason: z.string().nullable() });

/**
 * My days, newest first, `size` days with any activity per page: shifts,
 * time logged to tasks, visits, what was done and the score. Today is
 * always there — it is where a shift is started. Days are in my time zone.
 */
export async function history(me: number, page: number, size: number): Promise<History> {
  const [row] = TodayRow.array().parse(await sql`SELECT local_today(${me})::text AS today`);
  const today = row!.today;
  const tz = sql`(SELECT time_zone FROM employee WHERE id = ${me})`;

  const all = sql`
    SELECT ${today}::date AS day
    UNION SELECT (started_at AT TIME ZONE ${tz})::date FROM work WHERE employee_id = ${me}
    UNION SELECT day FROM spent_minutes WHERE "by" = ${me}
    UNION SELECT (at AT TIME ZONE ${tz})::date FROM visit WHERE employee_id = ${me}
    UNION SELECT (created_at AT TIME ZONE ${tz})::date FROM comment WHERE created_by = ${me}
  `;
  const days = DayRow.array().parse(await sql`
    SELECT day::text FROM (${all}) d
     ORDER BY day DESC
     LIMIT ${size} OFFSET ${(page - 1) * size}
  `).map((r) => r.day);
  const [count] = z.object({ n: z.number(), open: z.date().nullable() }).array().parse(await sql`
    SELECT count(*)::int AS n,
           (SELECT started_at FROM work WHERE employee_id = ${me} AND spent_minutes IS NULL) AS open
      FROM (${all}) d
  `);

  const shifts = ShiftRow.array().parse(await sql`
    SELECT (started_at AT TIME ZONE ${tz})::date::text AS day, started_at, spent_minutes, about
      FROM work
     WHERE employee_id = ${me} AND (started_at AT TIME ZONE ${tz})::date = ANY(${days}::date[])
     ORDER BY started_at
  `);
  const entries = EntryRow.array().parse(await sql`
    SELECT day::text, id, task_id, value AS minutes, updated_at
      FROM spent_minutes
     WHERE "by" = ${me} AND day = ANY(${days}::date[])
     ORDER BY id
  `);
  const visits = VisitRow.array().parse(await sql`
    SELECT (at AT TIME ZONE ${tz})::date::text AS day, task_id, at
      FROM visit
     WHERE employee_id = ${me} AND (at AT TIME ZONE ${tz})::date = ANY(${days}::date[])
     ORDER BY at
  `);
  const activity = ActivityRow.array().parse(await sql`
    SELECT day::text, min(at) AS first, max(at) AS last FROM (
      SELECT (at AT TIME ZONE ${tz})::date AS day, at FROM visit WHERE employee_id = ${me}
      UNION ALL
      SELECT (created_at AT TIME ZONE ${tz})::date, created_at FROM comment WHERE created_by = ${me}
      UNION ALL
      SELECT (added_at AT TIME ZONE ${tz})::date, added_at FROM spent_minutes WHERE "by" = ${me}
    ) a
     WHERE day = ANY(${days}::date[])
     GROUP BY day
  `);
  const actions = ActionRow.array().parse(await sql`
    SELECT day::text, kind, task_id, at FROM (
      SELECT (created_at AT TIME ZONE ${tz})::date AS day, 'comment' AS kind, task_id, created_at AS at
        FROM comment WHERE created_by = ${me}
      UNION ALL
      SELECT (added_at AT TIME ZONE ${tz})::date, 'time', task_id, added_at
        FROM spent_minutes WHERE "by" = ${me}
    ) a
     WHERE day = ANY(${days}::date[])
     ORDER BY at
  `);
  const scores = ScoreRow.array().parse(await sql`
    SELECT day::text, value, reason FROM score WHERE employee_id = ${me} AND day = ANY(${days}::date[])
  `);

  const result: DayHistory[] = days.map((day) => {
    const a = activity.find((r) => r.day === day);
    const s = scores.find((r) => r.day === day);
    return {
      day,
      shifts: shifts.filter((r) => r.day === day).map(({ day: _, ...shift }) => shift),
      entries: entries.filter((r) => r.day === day).map(({ day: _, ...entry }) => entry),
      visits: visits.filter((r) => r.day === day).map(({ day: _, ...visit }) => visit),
      actions: actions.filter((r) => r.day === day).map(({ day: _, ...action }) => action),
      firstActivity: a?.first ?? null,
      lastActivity: a?.last ?? null,
      score: s ? { value: s.value, reason: s.reason } : null,
    };
  });

  const taskIds = [...new Set([
    ...entries.map((e) => e.taskId),
    ...visits.flatMap((v) => (v.taskId === null ? [] : [v.taskId])),
    ...actions.map((a) => a.taskId),
  ])];
  return { today, days: result, tasks: await headers(me, taskIds), openShiftFrom: count?.open ?? null, total: count?.n ?? 1 };
}
