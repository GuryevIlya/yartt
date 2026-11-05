import { z } from 'zod';
import { Id } from './employee.ts';

/** What a tag means, in someone's words (decision 112). */
export const TagDescription = z.object({ tagId: Id, authorId: Id, html: z.string(), updatedAt: z.date() });
export type TagDescription = z.infer<typeof TagDescription>;

export const SetTagDescriptionInput = z.object({ tagId: Id, html: z.string().max(100_000).nullable() });
export type SetTagDescriptionInput = z.infer<typeof SetTagDescriptionInput>;
