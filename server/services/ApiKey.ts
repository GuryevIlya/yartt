import { z } from 'zod';
import { ApiKey, ApiRight, NewApiKey, type ApiKeyInput } from '#shared/apiKey.ts';
import { AppError } from '../errors.ts';
import { sql } from '../pg.ts';

/** A person's own keys, the ended ones gone from view. */
export async function list(employeeId: number): Promise<ApiKey[]> {
  return ApiKey.array().parse(await sql`
    SELECT id, name, rights, created_at, expires_at, last_used_at FROM api_key
     WHERE employee_id = ${employeeId} AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY id
  `);
}

export async function create(employeeId: number, input: ApiKeyInput): Promise<NewApiKey> {
  const [row] = NewApiKey.array().parse(await sql`
    SELECT id, key FROM create_api_key(${employeeId}, ${input.name}, ${[...new Set(input.rights)]}, ${input.days})
  `);
  return row!;
}

export async function revoke(employeeId: number, id: number): Promise<void> {
  const rows = await sql`
    UPDATE api_key SET revoked_at = NOW()
     WHERE id = ${id} AND employee_id = ${employeeId} AND revoked_at IS NULL RETURNING id
  `;
  if (rows.length === 0) throw new AppError('not_found');
}

const Authenticated = z.object({ employeeId: z.number(), rights: ApiRight.array() });

/** Who a key belongs to and what it may do; NULL — unknown or ended (authenticate_api_key()). */
export async function authenticate(key: string): Promise<z.infer<typeof Authenticated> | null> {
  const [row] = Authenticated.array().parse(await sql`SELECT employee_id, rights FROM authenticate_api_key(${key})`);
  return row ?? null;
}
