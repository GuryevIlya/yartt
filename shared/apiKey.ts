import { z } from 'zod';
import { Id } from './employee.ts';

/**
 * What a person's key may do (decision 111). Reading tasks is a right of its
 * own too: a key is for one job, and nothing is allowed unless ticked. Writing
 * shifts, time entries and scores is no right at all: they are not in the API.
 */
export const ApiRight = z.enum(['tasks.read', 'tasks.write', 'comments.write', 'participants.write', 'reports.read']);
export type ApiRight = z.infer<typeof ApiRight>;

export const ApiKeyInput = z.object({
  name: z.string().trim().min(1).max(100),
  rights: ApiRight.array().min(1),
  /** How long it lives: a forgotten key must end by itself. */
  days: z.union([z.literal(30), z.literal(90), z.literal(365)]),
});
export type ApiKeyInput = z.infer<typeof ApiKeyInput>;

export const ApiKey = z.object({
  id: Id,
  name: z.string(),
  rights: ApiRight.array(),
  createdAt: z.date(),
  expiresAt: z.date(),
  lastUsedAt: z.date().nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** Made: the key itself is shown once, never again. */
export const NewApiKey = z.object({ id: Id, key: z.string() });
export type NewApiKey = z.infer<typeof NewApiKey>;
