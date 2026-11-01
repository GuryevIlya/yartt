import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { MyFile } from '#shared/comment.ts';
import env from '../env.ts';
import { AppError } from '../errors.ts';
import { sql, type Sql } from '../pg.ts';
import * as Storage from '../storage.ts';
import { assertReadable } from './Task.ts';

const MB = 1024 * 1024;
const Id = z.object({ id: z.number() });
const File = z.object({ mime: z.string(), size: z.number(), value: z.instanceof(Buffer).nullable(), purgedAt: z.date().nullable(), inStorage: z.boolean() });
const Used = z.object({ bytes: z.coerce.number() });

/** The largest file, in bytes: the configuration's, the demo's 2 MB. */
export const maxBytes = () => (env.DEMO_DATA ? 2 : env.FILE_MAX_MB) * MB;

/** The bytes of the files the person holds: their quota taken. */
async function usedBytes(employeeId: number, db = sql): Promise<number> {
  const [row] = Used.array().parse(await db`
    SELECT COALESCE(sum(size), 0) AS bytes FROM attachment WHERE held_by @> ARRAY[${employeeId}::int]
  `);
  return row!.bytes;
}

/** Refuses a file that would not fit in the person's quota. */
async function assertFits(employeeId: number, size: number, db = sql): Promise<void> {
  const used = await usedBytes(employeeId, db);
  if (used + size > env.FILE_QUOTA_MB * MB) {
    throw new AppError('file_quota', { quotaMb: env.FILE_QUOTA_MB, usedMb: Math.round((used / MB) * 10) / 10 });
  }
}

/**
 * Stores a file and returns its id (decision 84): in PostgreSQL, or in the
 * object storage when one is configured (decision 104). The same bytes
 * uploaded again return the same row (deduplication by hash and size, and
 * the bytes when they are in PostgreSQL) — or bring back the content of a
 * deleted one with that hash and size, so every link to it works again.
 * The uploader holds it: it counts in their quota.
 * @throws file_too_big, file_quota
 */
export async function upload(employeeId: number, value: Buffer, mime: string): Promise<number> {
  if (value.length > maxBytes()) throw new AppError('file_too_big', { maxMb: maxBytes() / MB });
  const hash = createHash('sha256').update(value).digest();
  return sql.begin(async (tx) => {
    // One upload of a person at a time: the quota is checked against what is there.
    await tx`SELECT pg_advisory_xact_lock(hashtext('yartt.upload'), ${employeeId})`;
    const [existing] = z.object({ id: z.number(), held: z.boolean(), purged: z.boolean() }).array().parse(await tx`
      SELECT id, held_by @> ARRAY[${employeeId}::int] AS held, purged_at IS NOT NULL AS purged FROM attachment
       WHERE hash = ${hash} AND size = ${value.length} AND (value IS NULL OR value = ${value})
       ORDER BY purged_at IS NOT NULL, value IS NULL
       LIMIT 1
       FOR UPDATE
    `);
    // Held already: nothing new takes my space.
    if (!existing?.held) await assertFits(employeeId, value.length, tx as unknown as typeof sql);
    const stored = Storage.storageEnabled();
    if (existing) {
      // Its content was deleted: these bytes bring it back, where files go now.
      if (existing.purged) {
        if (stored) await Storage.put(existing.id, value, mime);
        await tx`
          UPDATE attachment SET value = ${stored ? null : value}, in_storage = ${stored}, purged_at = NULL
           WHERE id = ${existing.id}
        `;
      }
      await tx`
        UPDATE attachment
           SET used_at = NOW(),
               held_by = CASE WHEN held_by @> ARRAY[${employeeId}::int] THEN held_by ELSE held_by || ${employeeId}::int END,
               uploaded_by = CASE WHEN uploaded_by @> ARRAY[${employeeId}::int] THEN uploaded_by
                                  ELSE uploaded_by || ${employeeId}::int END
         WHERE id = ${existing.id}
      `;
      return existing.id;
    }
    const [row] = Id.array().parse(await tx`
      INSERT INTO attachment (hash, size, mime, value, in_storage, uploaded_by, held_by)
      VALUES (${hash}, ${value.length}, ${mime}, ${stored ? null : value}, ${stored}, ${[employeeId]}, ${[employeeId]})
      RETURNING id
    `);
    // Stored before the row is committed: a failure leaves neither.
    if (stored) await Storage.put(row!.id, value, mime);
    return row!.id;
  });
}

/**
 * The file, if the employee uploaded it or sees a task that refers to it:
 * its bytes from PostgreSQL, or a stream from the object storage.
 * @throws file_purged — its content was deleted; the same file uploaded again brings it back.
 */
export async function read(employeeId: number, id: number): Promise<{ mime: string; size: number; value: Buffer | Readable }> {
  await assertReadable([id], employeeId);
  const [file] = File.array().parse(await sql`SELECT mime, size, value, purged_at, in_storage FROM attachment WHERE id = ${id}`);
  if (file!.purgedAt) throw new AppError('file_purged');
  return { mime: file!.mime, size: file!.size, value: file!.value ?? await Storage.get(id) };
}

const MyFileRow = z.object({
  id: z.number(),
  held: z.boolean(),
  holders: z.number(),
  size: z.number(),
  mime: z.string(),
  addedAt: z.date(),
  usedAt: z.date(),
  purgedAt: z.date().nullable(),
  names: z.string().array(),
  taskIds: z.number().array(),
});

/**
 * The files someone holds, then the ones they uploaded and let go, the
 * newest first, with what they take of the quota (decision 84): the names
 * they go by in comments and the tasks they are in, how many hold them.
 */
export async function mine(employeeId: number): Promise<{ files: MyFile[]; usedBytes: number; quotaBytes: number }> {
  const files = MyFileRow.array().parse(await sql`
    SELECT a.id, a.held_by @> ARRAY[${employeeId}::int] AS held, cardinality(a.held_by) AS holders,
           a.size, a.mime, a.added_at, a.used_at, a.purged_at,
           COALESCE(ARRAY(SELECT DISTINCT c.attachment_names[array_position(c.attachment_ids, a.id)]
                            FROM comment c WHERE c.attachment_ids @> ARRAY[a.id]), '{}') AS names,
           COALESCE(ARRAY(SELECT DISTINCT c.task_id FROM comment c
                           WHERE c.attachment_ids @> ARRAY[a.id] OR c.image_ids @> ARRAY[a.id]
                          UNION SELECT k.id FROM task k WHERE k.context_image_ids @> ARRAY[a.id]), '{}') AS task_ids
      FROM attachment a
     WHERE a.uploaded_by @> ARRAY[${employeeId}::int] OR a.held_by @> ARRAY[${employeeId}::int]
     ORDER BY a.held_by @> ARRAY[${employeeId}::int] DESC, a.added_at DESC
     LIMIT 200
  `);
  return {
    files,
    usedBytes: await usedBytes(employeeId),
    quotaBytes: env.FILE_QUOTA_MB * MB,
  };
}

/**
 * Keeps a file the employee sees (in a task, or uploaded by them): it counts
 * in their quota and stays while they hold it, whoever else lets it go.
 * @throws unknown_attachment, file_purged, file_quota
 */
export async function keep(employeeId: number, id: number): Promise<void> {
  await sql.begin(async (tx) => {
    const db = tx as unknown as typeof sql;
    await assertReadable([id], employeeId, db);
    await tx`SELECT pg_advisory_xact_lock(hashtext('yartt.upload'), ${employeeId})`;
    const [row] = z.object({ size: z.number(), held: z.boolean() }).array().parse(await tx`
      SELECT size, held_by @> ARRAY[${employeeId}::int] AS held FROM attachment WHERE id = ${id} FOR UPDATE
    `);
    if (!row!.held) await assertFits(employeeId, row!.size, db);
    await tx`SELECT keep_attachment(${id}, ${employeeId})`;
  });
}

/** Lets a file go, to free the quota; the last one to let it go deletes its content, the links say so. */
export async function release(employeeId: number, id: number): Promise<void> {
  await sql`SELECT release_attachment(${id}, ${employeeId})`;
}

const Stored = z.object({ id: z.number(), value: z.instanceof(Buffer), mime: z.string() });
const Gone = z.object({ id: z.number(), inStorage: z.boolean() });

/**
 * The worker, with an object storage: moves files from PostgreSQL there,
 * one at a time so a large one never takes much memory, at most `limit`
 * per run; deletes the objects of purged files. Returns how many moved.
 */
export async function moveToStorage(db: Sql, limit = 20): Promise<number> {
  if (!Storage.storageEnabled()) return 0;
  const purged = Id.array().parse(await db`
    SELECT id FROM attachment WHERE in_storage AND purged_at IS NOT NULL LIMIT 100 FOR UPDATE SKIP LOCKED
  `);
  for (const { id } of purged) {
    await Storage.remove(id);
    await db`UPDATE attachment SET in_storage = FALSE WHERE id = ${id}`;
  }
  let moved = 0;
  for (; moved < limit; moved++) {
    const [file] = Stored.array().parse(await db`
      SELECT id, value, mime FROM attachment WHERE value IS NOT NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (!file) break;
    await Storage.put(file.id, file.value, file.mime);
    await db`UPDATE attachment SET value = NULL, in_storage = TRUE WHERE id = ${file.id}`;
  }
  return moved;
}

/**
 * The worker, once a day: deletes the files nothing refers to that have
 * not been used for a day (uploaded, the comment never sent), with their
 * objects. An object that cannot be deleted keeps its row for the next run.
 */
export async function cleanup(db: Sql): Promise<void> {
  const gone = Gone.array().parse(await db`
    DELETE FROM attachment a
     WHERE used_at < NOW() - INTERVAL '1 day'
       AND NOT attachment_in_use(a.id)
    RETURNING id, in_storage
  `);
  for (const file of gone) if (file.inStorage) await Storage.remove(file.id);
}
