import { z } from 'zod';
import {
  type CreateInput, type Dependency, Expert, type Related, type SearchInput, type SearchResult, Tag, type TaskDetails,
  type TaskHeader, type TaskPage, TaskPreview, type TitleTaken, type UpdateInput, Access, Priority,
} from '#shared/task.ts';
import { AppError } from '../errors.ts';
import { cleanHtml, taskRefs } from '../html.ts';
import { sql, type Sql } from '../pg.ts';
import { createIn as createComment } from './Comment.ts';
import * as Dependencies from './Dependency.ts';

export const PAGE_SIZE = 20;

const HeaderRow = z.object({
  id: z.number(),
  tagIds: z.number().array(),
  priority: Priority,
  deadline: z.date().nullable(),
  closed: z.boolean(),
  ownerId: z.number().nullable(),
  isPublic: z.boolean(),
  riskEmployeeId: z.number().nullable(),
  riskPlanned: z.number().nullable(),
  riskCapacity: z.number().nullable(),
  late: z.number().array(),
  delays: z.number().array(),
});
const Id = z.object({ id: z.number() });
const Count = z.object({ n: z.number() });
const Bool = z.object({ value: z.boolean() });

/**
 * Headers of the given tasks in the given order, tags in the viewer's own
 * order. Visible to every employee (decision 19).
 */
export async function headers(viewerId: number, ids: number[], db: Sql = sql): Promise<TaskHeader[]> {
  if (ids.length === 0) return [];
  const rows = HeaderRow.array().parse(await db`
    SELECT k.id, ordered_tags(${viewerId}, k.tag_ids) AS tag_ids, k.priority, k.owner_id,
           f.value AS deadline, f.confirmed_at IS NOT NULL AS closed, is_public(k.id) AS is_public,
           r.employee_id AS risk_employee_id, r.planned_minutes AS risk_planned, r.capacity_minutes AS risk_capacity,
           -- Broken latest deadlines around an open task: what it waits for is late, or it delays others.
           ARRAY(SELECT d.value FROM dependency_risk(k.id) d
                  WHERE d.task_id = k.id AND f.confirmed_at IS NULL) AS late,
           ARRAY(SELECT d.task_id FROM dependency_risk(k.id) d
                  WHERE d.value = k.id AND f.confirmed_at IS NULL) AS delays
      FROM task k
      LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
      LEFT JOIN LATERAL deadline_risk(k.id) r ON TRUE
     WHERE k.id = ANY(${ids})
  `);
  const tagIds = [...new Set(rows.flatMap((r) => r.tagIds))];
  const tags = new Map(
    Tag.array().parse(await db`
      SELECT t.id, t.name, u.color FROM tag t
        LEFT JOIN user_tag u ON u.tag_id = t.id AND u.employee_id = ${viewerId}
       WHERE t.id = ANY(${tagIds})
    `).map((t) => [t.id, t]),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const { tagIds: rowTags, riskEmployeeId, riskPlanned, riskCapacity, ...rest } = r;
    const risk = riskEmployeeId === null
      ? null
      : { employeeId: riskEmployeeId, plannedMinutes: riskPlanned ?? 0, capacityMinutes: riskCapacity ?? 0 };
    return [{ ...rest, risk, tags: rowTags.map((t) => tags.get(t)).filter((t) => t !== undefined) }];
  });
}

export async function canSee(taskId: number, employeeId: number, db: Sql = sql): Promise<boolean> {
  const [row] = Bool.array().parse(await db`SELECT can_see(${taskId}, ${employeeId}) AS value`);
  return row?.value ?? false;
}

/** Throws not_found for an unknown task and no_access unless the employee sees it. */
export async function assertCanSee(taskId: number, employeeId: number, db: Sql = sql): Promise<void> {
  const [row] = z.object({ exists: z.boolean(), sees: z.boolean() }).array().parse(await db`
    SELECT EXISTS (SELECT 1 FROM task WHERE id = ${taskId}) AS exists,
           can_see(${taskId}, ${employeeId}) AS sees
  `);
  if (!row?.exists) throw new AppError('not_found');
  if (!row.sees) throw new AppError('no_access', { taskId });
}

async function assertOwner(taskId: number, employeeId: number, db: Sql = sql): Promise<void> {
  await db`SELECT check_owner(${taskId}, ${employeeId})`;
}

/**
 * Tasks carrying all the given tags — any task: tags are visible to
 * everyone. The tabs of Current tasks — my open ones, the other open ones,
 * the closed ones — in their orders; 'all' — open first, by deadline.
 */
/**
 * Whose open task `k` is in Available tasks (decision 85): 'mine' — I own it
 * or have time planned on it; 'team' — someone under me does; 'others'.
 * My people are found once per query, not once per task.
 */
export const whose = (viewerId: number) => sql`
  CASE WHEN k.owner_id = ${viewerId}
         OR EXISTS (SELECT 1 FROM estimate_minutes es WHERE es.task_id = k.id AND es.expired_at IS NULL AND es."by" = ${viewerId})
       THEN 'mine'
       WHEN k.owner_id = ANY(ARRAY(SELECT subordinates(${viewerId})))
         OR EXISTS (SELECT 1 FROM estimate_minutes es WHERE es.task_id = k.id AND es.expired_at IS NULL
                       AND es."by" = ANY(ARRAY(SELECT subordinates(${viewerId}))))
       THEN 'team'
       ELSE 'others' END`;

/**
 * The ids of the tasks the viewer sees, as a set: can_see() for a list of
 * tasks at once — those they actively observe and the public ones (no
 * active observer). Calling can_see() per task of a large list costs a
 * function call and two lookups each; tests/access.test.ts holds both to
 * the same answer.
 */
export const visibleTasks = (viewerId: number) => sql`
  SELECT task_id AS id FROM observer
   WHERE value = ${viewerId} AND added_at IS NOT NULL AND deleted_at IS NULL
  UNION
  SELECT k.id FROM task k
   WHERE NOT EXISTS (SELECT 1 FROM observer o
                      WHERE o.task_id = k.id AND o.added_at IS NOT NULL AND o.deleted_at IS NULL)`;

/**
 * Only the shifts around a range of days, before shift_day or spent_day
 * splits them into days: a day of any time zone lies within two days of its
 * date, and a shift is at most a day long. The days themselves are still
 * picked by `day`; this only spares splitting every shift ever made.
 */
export const shiftsWithin = (view: ReturnType<typeof sql>, from: string, to: string) =>
  sql`${view}.started_at >= ${from}::date - 2 AND ${view}.started_at < ${to}::date + 2`;

const Plan = z.object({ taskId: z.number(), minutes: z.number() });

/** Time left planned on the tasks: mine in 'mine', my people's together in 'team' (hours of a task add up, decision 68). */
export async function plans(viewerId: number, tab: string, ids: number[]): Promise<z.infer<typeof Plan>[]> {
  if (ids.length === 0 || (tab !== 'mine' && tab !== 'team')) return [];
  const by = tab === 'mine' ? sql`es."by" = ${viewerId}` : sql`es."by" IN (SELECT subordinates(${viewerId}))`;
  return Plan.array().parse(await sql`
    SELECT es.task_id, sum(es.value)::int AS minutes FROM estimate_minutes es
     WHERE es.task_id = ANY(${ids}) AND es.expired_at IS NULL AND ${by}
     GROUP BY es.task_id
  `);
}

const Hours = z.object({ taskId: z.number(), spentMinutes: z.number(), leftMinutes: z.number() });

/**
 * Everyone's time on the tasks the viewer sees — logged, and left in current
 * plans — added up: it measures the work (decision 68). Tasks without any are left out.
 */
export async function hours(viewerId: number, ids: number[]): Promise<z.infer<typeof Hours>[]> {
  if (ids.length === 0) return [];
  return Hours.array().parse(await sql`
    SELECT h.* FROM (
      SELECT k.id AS task_id,
             COALESCE((SELECT sum(s.value) FROM spent_minutes s WHERE s.task_id = k.id), 0)::int AS spent_minutes,
             COALESCE((SELECT sum(e.value) FROM estimate_minutes e WHERE e.task_id = k.id AND e.expired_at IS NULL), 0)::int AS left_minutes
        FROM task k
       WHERE k.id = ANY(${ids}) AND can_see(k.id, ${viewerId})
    ) h
     WHERE h.spent_minutes > 0 OR h.left_minutes > 0
  `);
}

export async function search(viewerId: number, input: SearchInput): Promise<SearchResult> {
  const where = sql`k.tag_ids @> ${input.tagIds}::int[]`;
  // Closed is what its owner closed (decision 93); an overdue task is still open, first by its deadline.
  const closed = sql`(f.confirmed_at IS NOT NULL)`;
  const [counts] = z.object({ mine: z.number(), team: z.number(), others: z.number(), closed: z.number() }).array().parse(await sql`
    SELECT count(*) FILTER (WHERE NOT closed AND whose = 'mine')::int AS mine,
           count(*) FILTER (WHERE NOT closed AND whose = 'team')::int AS team,
           count(*) FILTER (WHERE NOT closed AND whose = 'others')::int AS others,
           count(*) FILTER (WHERE closed)::int AS closed
      FROM (SELECT ${closed} AS closed, ${whose(viewerId)} AS whose
              FROM task k
              LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
             WHERE ${where}) t
  `);
  const tab = input.tab === 'all' ? sql`TRUE`
    : input.tab === 'closed' ? closed
    : sql`NOT ${closed} AND ${whose(viewerId)} = ${input.tab}`;
  const order = input.tab === 'closed' ? sql`f.confirmed_at DESC, k.priority DESC, k.id DESC`
    : sql`${closed}, f.value NULLS LAST, k.priority DESC, k.id DESC`;
  const ids = Id.array().parse(await sql`
    SELECT k.id
      FROM task k
      LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
     WHERE ${where} AND ${tab}
     ORDER BY ${order}
     LIMIT ${PAGE_SIZE} OFFSET ${(input.page - 1) * PAGE_SIZE}
  `).map((r) => r.id);
  const seen = new Set(
    Id.array().parse(await sql`SELECT id FROM task WHERE id = ANY(${ids}) AND can_see(id, ${viewerId})`).map((r) => r.id),
  );
  const items = (await headers(viewerId, ids)).map((h) => ({ ...h, canSee: seen.has(h.id) }));
  return { items, counts: counts!, plans: await plans(viewerId, input.tab, ids), hours: await hours(viewerId, ids) };
}

/**
 * The task whose title is exactly these tags, if any — a title is unique
 * (uq_task_tag_ids); a name no tag has yet means nobody has the title.
 * Tags are visible to everyone, so the number of that task is too.
 */
export async function byTags(names: string[]): Promise<TitleTaken> {
  const unique = [...new Set(names)];
  const [row] = Id.array().parse(await sql`
    WITH t AS (SELECT id FROM tag WHERE name = ANY(${unique}))
    SELECT k.id FROM task k
     WHERE (SELECT count(*) FROM t) = ${unique.length}
       AND k.tag_ids = (SELECT array_agg(id ORDER BY id) FROM t)
  `);
  return row ?? null;
}

const SIMILAR = 5;

/**
 * Tasks sharing tags with a title being typed, other than the one with
 * exactly this title: the most tags in common first, then the open ones,
 * then the newest — so a new task is written next to what already exists.
 * Headers are everyone's to see (decision 19).
 */
export async function similar(viewerId: number, names: string[]): Promise<TaskHeader[]> {
  const ids = Id.array().parse(await sql`
    WITH t AS (SELECT id FROM tag WHERE name = ANY(${[...new Set(names)]}))
    SELECT k.id FROM task k
      LEFT JOIN finished_at f ON f.task_id = k.id AND f.expired_at IS NULL
     WHERE k.tag_ids && (SELECT array_agg(id) FROM t)
       AND k.tag_ids <> (SELECT array_agg(id ORDER BY id) FROM t)
     ORDER BY (SELECT count(*) FROM unnest(k.tag_ids) x WHERE x IN (SELECT id FROM t)) DESC,
              f.confirmed_at IS NULL DESC, k.id DESC
     LIMIT ${SIMILAR}
  `).map((r) => r.id);
  return headers(viewerId, ids);
}

const EXPERTS = 5;

/**
 * Who knows the subject: those who logged time in the past year on tasks
 * sharing tags with these, the most shared tags over the most tasks first.
 * Only tasks the viewer sees count, so nobody's private work shows through;
 * the viewer, the dismissed and bots are left out.
 */
export async function experts(viewerId: number, names: string[]): Promise<Expert[]> {
  return Expert.array().parse(await sql`
    WITH t AS (SELECT id FROM tag WHERE name = ANY(${[...new Set(names)]})),
    w AS (
      SELECT s."by" AS employee_id, k.id AS task_id,
             (SELECT count(*) FROM unnest(k.tag_ids) x WHERE x IN (SELECT id FROM t)) AS shared
        FROM spent_minutes s JOIN task k ON k.id = s.task_id JOIN work sw ON sw.id = s.shift_id
       WHERE k.tag_ids && (SELECT array_agg(id) FROM t)
         AND sw.started_at >= NOW() - INTERVAL '365 days'
       GROUP BY s."by", k.id
    )
    SELECT w.employee_id, count(*)::int AS tasks
      FROM w JOIN employee e ON e.id = w.employee_id
     WHERE e.dismissed_at IS NULL AND e.id <> ${viewerId} AND can_see(w.task_id, ${viewerId})
     GROUP BY w.employee_id
     ORDER BY sum(w.shared) DESC, count(*) DESC, w.employee_id
     LIMIT ${EXPERTS}
  `);
}

/** Ids of the tags with these names; missing ones are created. */
async function tagIds(names: string[], db: Sql): Promise<number[]> {
  const unique = [...new Set(names.map((n) => n.trim()))];
  await db`INSERT INTO tag (name) SELECT unnest(${unique}::text[]) ON CONFLICT (name) DO NOTHING`;
  return Id.array().parse(await db`SELECT id FROM tag WHERE name = ANY(${unique})`).map((r) => r.id);
}

/**
 * A new private task owned by its creator; tags are created as needed.
 * Priority, deadline, context and one dependency without a latest deadline
 * come in the same transaction, under the same rules as changing them later.
 */
export async function create(ownerId: number, input: CreateInput): Promise<number> {
  return sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const ids = await tagIds(input.tags, db);
    const clean = input.context ? cleanHtml(input.context) : { html: null, imageIds: [] };
    await assertReadable(clean.imageIds, ownerId, db);
    const [row] = Id.array().parse(await db`
      INSERT INTO task (owner_id, tag_ids, priority, context, context_image_ids)
      VALUES (${ownerId}, ${ids}, ${input.priority ?? 'NORMAL'}, ${clean.html}, ${clean.imageIds})
      RETURNING id
    `);
    const id = row!.id;
    await saveContextMentions(db, id, clean.html, ownerId);
    if (input.deadline) await db`SELECT set_finished_at(${id}, ${input.deadline})`;
    if (input.waitsFor) await Dependencies.setIn(db, ownerId, { taskId: id, value: input.waitsFor, latestAt: null });
    if (input.waitedOnBy) await Dependencies.setIn(db, ownerId, { taskId: input.waitedOnBy, value: id, latestAt: null });
    for (const employeeId of new Set(input.participants ?? [])) {
      if (employeeId !== ownerId) await db`SELECT add_observer(${id}, ${employeeId}, ${ownerId})`;
    }
    // What is needed from them: the first comment, in their Waiting for me (decision 108).
    const asked = [...new Set(input.participants ?? [])].filter((employeeId) => employeeId !== ownerId);
    if (input.request && asked.length > 0) {
      await createComment(db, ownerId, {
        taskId: id, html: input.request, replyToId: null, files: [], mentionIds: asked, everyone: false, exceptIds: [], taskIds: [],
      });
    }
    return id;
  });
}

/** The owner changes tags, priority or context; fields left out stay. */
export async function update(actorId: number, input: UpdateInput): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    await assertOwner(input.id, actorId, db);
    if (input.tags) {
      const ids = await tagIds(input.tags, db);
      await db`UPDATE task SET tag_ids = ${ids} WHERE id = ${input.id}`;
    }
    if (input.priority) {
      await db`UPDATE task SET priority = ${input.priority} WHERE id = ${input.id}`;
    }
    if (input.context !== undefined) {
      const clean = input.context === null ? { html: null, imageIds: [] } : cleanHtml(input.context);
      await assertReadable(clean.imageIds, actorId, db);
      await db`
        UPDATE task SET context = ${clean.html}, context_image_ids = ${clean.imageIds}
         WHERE id = ${input.id}
      `;
      await saveContextMentions(db, input.id, clean.html, actorId);
    }
  });
}

/** The tasks the context mentions now: those its owner sees. Nobody is told: a context is edited many times. */
async function saveContextMentions(db: Sql, taskId: number, html: string | null, ownerId: number): Promise<void> {
  await db`DELETE FROM context_mention WHERE task_id = ${taskId}`;
  await db`
    INSERT INTO context_mention (task_id, value)
    SELECT ${taskId}, id FROM task
     WHERE id = ANY(${html === null ? [] : taskRefs(html)}) AND id <> ${taskId} AND can_see(id, ${ownerId})
  `;
}

/**
 * Attachments can be put into a comment or a context only by someone who
 * may read them, so an id cannot be used to pull another task's file out.
 */
export async function assertReadable(ids: number[], employeeId: number, db: Sql = sql): Promise<void> {
  if (ids.length === 0) return;
  const readable = Id.array().parse(await db`
    SELECT a.id FROM attachment a
     WHERE a.id = ANY(${ids})
       AND (a.uploaded_by @> ARRAY[${employeeId}::int]
            OR EXISTS (SELECT 1 FROM comment c
                        WHERE (c.attachment_ids @> ARRAY[a.id] OR c.image_ids @> ARRAY[a.id])
                          AND can_see(c.task_id, ${employeeId}))
            OR EXISTS (SELECT 1 FROM task k
                        WHERE k.context_image_ids @> ARRAY[a.id] AND can_see(k.id, ${employeeId})))
  `);
  if (readable.length !== new Set(ids).size) throw new AppError('unknown_attachment');
}

/** Sets or moves the deadline; NULL clears it. Owner only. Never closes the task: it opens a closed one. */
export async function setDeadline(actorId: number, taskId: number, deadline: Date | null): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    await assertOwner(taskId, actorId, db);
    if (deadline === null) await db`SELECT clear_finished_at(${taskId})`;
    else await db`SELECT set_finished_at(${taskId}, ${deadline})`;
  });
}

/**
 * The owner closes the task — the only way it closes (decision 93);
 * close_task() checks the owner. `reviewedUntil` — closed from the review,
 * it takes its notices away too, up to that moment (decision 94).
 */
export async function close(actorId: number, taskId: number, reviewedUntil?: Date): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    await db`SELECT close_task(${taskId}, ${actorId})`;
    if (reviewedUntil) await db`SELECT mark_reviewed(${taskId}, ${actorId}, ${reviewedUntil})`;
  });
}

const OwnerRow = z.object({ ownerId: z.number().nullable(), managerId: z.number().nullable() });

/** Who changes the owner in this transaction: the trigger keeps it in owner_change (decision 96). */
export async function setActor(db: Sql, actorId: number): Promise<void> {
  await db`SELECT set_config('yartt.actor', ${String(actorId)}, TRUE)`;
}

/**
 * Hands the task over. Allowed to the owner and to the owner's direct
 * manager. The new owner is told; when the manager acts, the previous owner
 * is told too. The previous owner stays an observer, reviewed_at resets, handed_at is set, the
 * change is kept in owner_change and a private task gets the new owner as an observer (triggers).
 */
export async function transfer(actorId: number, taskId: number, newOwnerId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const [row] = OwnerRow.array().parse(await db`
      SELECT k.owner_id, e.manager_id
        FROM task k LEFT JOIN employee e ON e.id = k.owner_id
       WHERE k.id = ${taskId}
         FOR UPDATE OF k
    `);
    if (!row) throw new AppError('not_found');
    if (row.ownerId === null || (actorId !== row.ownerId && actorId !== row.managerId)) throw new AppError('forbidden');
    if (newOwnerId === row.ownerId) return;
    const [target] = Bool.array().parse(await db`
      SELECT EXISTS (SELECT 1 FROM employee WHERE id = ${newOwnerId} AND dismissed_at IS NULL) AS value
    `);
    if (!target?.value) throw new AppError('not_found');

    await setActor(db, actorId);
    await db`UPDATE task SET owner_id = ${newOwnerId} WHERE id = ${taskId}`;
    if (newOwnerId !== actorId) {
      await db`SELECT notify(${newOwnerId}, ${taskId}, ${db.json({ kind: 'owner_change', from: row.ownerId })})`;
    }
    if (actorId !== row.ownerId) {
      await db`SELECT notify(${row.ownerId}, ${taskId}, ${db.json({ kind: 'owner_handed', by: actorId, employeeId: newOwnerId })})`;
    }
  });
}

/** Takes an ownerless task: anyone who sees it (decision 11). */
export async function take(actorId: number, taskId: number): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const [row] = OwnerRow.array().parse(await db`
      SELECT owner_id, NULL::int AS manager_id FROM task WHERE id = ${taskId} FOR UPDATE
    `);
    if (!row) throw new AppError('not_found');
    if (row.ownerId !== null) throw new AppError('forbidden');
    await assertCanSee(taskId, actorId, db);
    await setActor(db, actorId);
    await db`UPDATE task SET owner_id = ${actorId} WHERE id = ${taskId}`;
  });
}

/** "No intervention needed" up to `until`, the newest notice shown (decision 94); none — now. */
export async function markReviewed(actorId: number, taskId: number, until?: Date): Promise<void> {
  await sql`SELECT mark_reviewed(${taskId}, ${actorId}, ${until ?? null})`;
}

export async function makePublic(actorId: number, taskId: number): Promise<void> {
  await sql`SELECT make_public(${taskId}, ${actorId})`;
}

/** Returns those who commented and lost access, to offer bringing them back. */
export async function makePrivate(actorId: number, taskId: number): Promise<number[]> {
  const [row] = z.object({ ids: z.number().array() }).array().parse(await sql`
    SELECT make_private(${taskId}, ${actorId}) AS ids
  `);
  return row?.ids ?? [];
}

const DependencyRow = z.object({ id: z.number(), latestAt: z.date().nullable(), addedBy: z.number().nullable() });

async function dependencies(viewerId: number, rows: z.infer<typeof DependencyRow>[]): Promise<Dependency[]> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (await headers(viewerId, rows.map((r) => r.id))).map((h) => ({
    ...h, latestAt: byId.get(h.id)?.latestAt ?? null, addedBy: byId.get(h.id)?.addedBy ?? null,
  }));
}

const LinkRow = z.object({
  taskId: z.number(),
  value: z.number(),
  latestAt: z.date().nullable(),
  addedBy: z.number().nullable(),
  waitingClosed: z.boolean(),
  valueClosed: z.boolean(),
});
const MentionRow = z.object({ other: z.number(), commentId: z.number().nullable(), out: z.boolean() });

const AccessRow = z.object({
  ownerId: z.number().nullable(),
  observes: z.boolean(),
  isPublic: z.boolean(),
  requested: z.boolean(),
});

/** The task page: the header for everyone, the rest for whoever sees the task. */
export async function get(viewerId: number, taskId: number): Promise<TaskPage> {
  const [header] = await headers(viewerId, [taskId]);
  if (!header) throw new AppError('not_found');

  const [a] = AccessRow.array().parse(await sql`
    SELECT k.owner_id,
           is_observer(k.id, ${viewerId}) AS observes,
           is_public(k.id) AS is_public,
           EXISTS (SELECT 1 FROM observer o
                    WHERE o.task_id = k.id AND o.value = ${viewerId}
                      AND o.added_at IS NULL AND o.deleted_at IS NULL) AS requested
      FROM task k WHERE k.id = ${taskId}
  `);
  const access: Access =
    a!.ownerId === viewerId ? 'owner'
    : a!.observes ? 'observer'
    : a!.isPublic ? 'public'
    : a!.requested ? 'requested'
    : 'none';
  if (access === 'requested' || access === 'none') return { ...header, access, details: null };

  const [task] = z.object({ context: z.string().nullable() }).array().parse(await sql`
    SELECT context FROM task WHERE id = ${taskId}
  `);
  const links = LinkRow.array().parse(await sql`
    SELECT d.task_id, d.value, d.latest_at, d.added_by,
           wf.confirmed_at IS NOT NULL AS waiting_closed, vf.confirmed_at IS NOT NULL AS value_closed
      FROM dependency d
      LEFT JOIN finished_at wf ON wf.task_id = d.task_id AND wf.expired_at IS NULL
      LEFT JOIN finished_at vf ON vf.task_id = d.value AND vf.expired_at IS NULL
     WHERE d.task_id = ${taskId} OR d.value = ${taskId}
  `);
  const row = (l: z.infer<typeof LinkRow>, id: number) => ({ id, latestAt: l.latestAt, addedBy: l.addedBy });
  const waiting = links.filter((l) => l.taskId === taskId);
  const waitedOn = links.filter((l) => l.value === taskId);
  // Waiting goes on while both are open; a closed waiting task is shown by nobody but itself (decision 107).
  const waitsFor = waiting.filter((l) => !l.waitingClosed && !l.valueClosed).map((l) => row(l, l.value));
  const waitedOnBy = waitedOn.filter((l) => !l.waitingClosed && !l.valueClosed).map((l) => row(l, l.taskId));

  const related = new Map<number, Pick<Related, 'waited' | 'mentions'>>();
  const entry = (id: number) => {
    const found = related.get(id);
    if (found) return found;
    const made: Pick<Related, 'waited' | 'mentions'> = { waited: null, mentions: [] };
    related.set(id, made);
    return made;
  };
  for (const l of waiting) if (l.waitingClosed || l.valueClosed) entry(l.value).waited = 'waits';
  for (const l of waitedOn) if (l.valueClosed && !l.waitingClosed) entry(l.taskId).waited = 'waited_by';
  const mentions = MentionRow.array().parse(await sql`
    SELECT value AS other, comment_id, TRUE AS out FROM task_mention WHERE task_id = ${taskId}
    UNION ALL
    SELECT value, NULL, TRUE FROM context_mention WHERE task_id = ${taskId}
    UNION ALL
    SELECT task_id, comment_id, FALSE FROM task_mention WHERE value = ${taskId} AND can_see(task_id, ${viewerId})
    UNION ALL
    SELECT task_id, NULL, FALSE FROM context_mention WHERE value = ${taskId} AND can_see(task_id, ${viewerId})
  `);
  for (const m of mentions) {
    entry(m.other).mentions.push({ out: m.out, taskId: m.out ? taskId : m.other, commentId: m.commentId });
  }

  const details: TaskDetails = {
    context: task!.context,
    waitsFor: await dependencies(viewerId, waitsFor),
    waitedOnBy: await dependencies(viewerId, waitedOnBy),
    related: (await headers(viewerId, [...related.keys()])).map((h) => ({ ...h, ...related.get(h.id)! })),
  };
  return { ...header, access, details };
}

/** The hint over a task in a list: its context and each person's time on it, for someone who sees it. */
export async function preview(viewerId: number, taskId: number): Promise<TaskPreview> {
  if (!(await canSee(taskId, viewerId))) return { visible: false, context: null, people: [] };
  const [task] = z.object({ context: z.string().nullable() }).array().parse(await sql`
    SELECT context FROM task WHERE id = ${taskId}
  `);
  const people = TaskPreview.shape.people.parse(await sql`
    SELECT p.employee_id,
           COALESCE((SELECT sum(s.value) FROM spent_minutes s WHERE s.task_id = ${taskId} AND s."by" = p.employee_id), 0)::int AS spent_minutes,
           (SELECT e.value FROM estimate_minutes e
             WHERE e.task_id = ${taskId} AND e."by" = p.employee_id AND e.expired_at IS NULL) AS left_minutes
      FROM (SELECT "by" AS employee_id FROM spent_minutes WHERE task_id = ${taskId}
            UNION SELECT "by" FROM estimate_minutes WHERE task_id = ${taskId} AND expired_at IS NULL) p
     ORDER BY p.employee_id = ${viewerId} DESC, spent_minutes DESC, p.employee_id
  `);
  return { visible: true, context: task?.context ?? null, people };
}
