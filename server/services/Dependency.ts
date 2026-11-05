import { z } from 'zod';
import type { SetDependencyInput } from '#shared/dependency.ts';
import { AppError } from '../errors.ts';
import { sql, type Sql } from '../pg.ts';

const Ends = z.object({
  waitingOwnerId: z.number().nullable(),
  valueOwnerId: z.number().nullable(),
  seesWaiting: z.boolean(),
  seesValue: z.boolean(),
  exists: z.boolean(),
});

/**
 * Links what waits for what (decision 94). Linking binds nobody: anyone who
 * sees both tasks links them, either way — the same rule from either
 * side — and the owners of both other than them are told — the owner of the task waited for (dependency_added, with
 * whether it has a latest deadline) and the owner of the waiting one
 * (waits_added). The latest deadline is the waiting task's owner's alone:
 * they set and change it. Cycles are refused (trigger); a latest deadline
 * forbids nothing — broken, it puts both tasks at risk.
 */
export async function set(actorId: number, input: SetDependencyInput): Promise<void> {
  await sql.begin((tx) => setIn(tx as unknown as Sql, actorId, input));
}

/** `set` inside the caller's transaction (a task created together with its dependency). */
export async function setIn(db: Sql, actorId: number, input: SetDependencyInput): Promise<void> {
  if (input.value === input.taskId) throw new AppError('dependency_cycle');
  const [ends] = Ends.array().parse(await db`
    SELECT k.owner_id AS waiting_owner_id, v.owner_id AS value_owner_id,
           can_see(k.id, ${actorId}) AS sees_waiting, can_see(v.id, ${actorId}) AS sees_value,
           EXISTS (SELECT 1 FROM dependency WHERE task_id = k.id AND value = v.id) AS exists
      FROM task k, task v
     WHERE k.id = ${input.taskId} AND v.id = ${input.value}
  `);
  if (!ends) throw new AppError('not_found');
  // A new link joins two tasks its author sees; the latest deadline of one there is its owner's either way.
  if (!ends.exists && !ends.seesWaiting) throw new AppError('no_access', { taskId: input.taskId });
  if (!ends.exists && !ends.seesValue) throw new AppError('no_access', { taskId: input.value });
  if (ends.waitingOwnerId !== actorId) {
    if (input.latestAt !== null) throw new AppError('forbidden');
    // Linked already: what is left to change is the owner's latest deadline.
    if (ends.exists) return;
  }
  await db`
    INSERT INTO dependency (task_id, value, latest_at, added_by)
    VALUES (${input.taskId}, ${input.value}, ${input.latestAt}, ${actorId})
    ON CONFLICT (task_id, value) DO UPDATE SET latest_at = EXCLUDED.latest_at
  `;
  await db`DELETE FROM dependency_removed WHERE task_id = ${input.taskId} AND value = ${input.value}`;
  if (ends.exists) return;
  if (ends.valueOwnerId !== null && ends.valueOwnerId !== actorId) {
    await db`SELECT notify(${ends.valueOwnerId}, ${input.value}, ${db.json({
      kind: 'dependency_added', by: actorId, dependentId: input.taskId, hard: input.latestAt !== null,
    })})`;
  }
  if (ends.waitingOwnerId !== null && ends.waitingOwnerId !== actorId && ends.waitingOwnerId !== ends.valueOwnerId) {
    await db`SELECT notify(${ends.waitingOwnerId}, ${input.taskId}, ${db.json({
      kind: 'waits_added', by: actorId, dependencyId: input.value,
    })})`;
  }
}

const Link = z.object({ ownerId: z.number().nullable(), addedBy: z.number().nullable() });

/** The owner of the waiting task, or whoever added the dependency, removes it. */
export async function remove(actorId: number, taskId: number, value: number): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as Sql;
    const [link] = Link.array().parse(await db`
      SELECT k.owner_id, d.added_by
        FROM dependency d JOIN task k ON k.id = d.task_id
       WHERE d.task_id = ${taskId} AND d.value = ${value}
         FOR UPDATE OF d
    `);
    if (!link) throw new AppError('not_found');
    if (actorId !== link.ownerId && actorId !== link.addedBy) throw new AppError('forbidden');
    // Kept for both tasks (decision 113): whoever started one for the other can still tell why.
    await db`
      INSERT INTO dependency_removed (task_id, value, added_at, removed_by)
      SELECT task_id, value, added_at, ${actorId} FROM dependency WHERE task_id = ${taskId} AND value = ${value}
      ON CONFLICT (task_id, value) DO UPDATE
        SET added_at = EXCLUDED.added_at, removed_at = NOW(), removed_by = EXCLUDED.removed_by
    `;
    await db`DELETE FROM dependency WHERE task_id = ${taskId} AND value = ${value}`;
    // Its work may not be needed any more.
    await db`
      SELECT notify(v.owner_id, v.id, ${db.json({ kind: 'waiter_closed', dependentId: taskId })})
        FROM task v LEFT JOIN finished_at f ON f.task_id = v.id AND f.expired_at IS NULL
       WHERE v.id = ${value} AND v.owner_id IS NOT NULL AND v.owner_id <> ${actorId} AND f.confirmed_at IS NULL
    `;
  });
}
