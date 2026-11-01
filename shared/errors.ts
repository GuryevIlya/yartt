import type { z } from 'zod';

// Stable error codes. The server returns a code, the client translates it
// (key errors.<code>). Business rule codes match HINT in db.sql.
export const ERROR_CODES = [
  // general
  'internal',
  'invalid_input',
  'invalid_data',
  'not_found',
  'forbidden',
  'unauthorized',

  // authentication
  'invalid_token',
  'too_many_requests',
  'sso_only',
  'sso_failed',
  'sso_other_browser',
  'dismissed',

  // employees
  'email_taken',
  'email_not_allowed',
  'email_outside_domains',
  'invalid_locale',
  'invalid_time_zone',
  'manager_self',

  // bots
  'bot_not_permitted',

  // tasks and tags
  'tag_set_taken',
  'unknown_tag',
  'no_access',
  'task_public',
  'plans_left',
  'tag_in_use',
  'immutable_row',

  // observers
  'owner_cannot_leave',
  'manager_cannot_leave',
  'not_observer',
  'already_observer',
  'no_pending_request',

  // dependencies and deadlines
  'dependency_cycle',

  // comments
  'unknown_attachment',
  'file_too_big',
  'file_quota',
  'file_purged',
  'attachment_in_use',
  'self_mention',
  'mention_not_participant',
  'mention_answered',

  // reminders
  'remind_in_past',

  // timesheet, time entries, scores
  'shift_overlap',
  'shift_overlap_with',
  'shift_overlap_open',
  'shift_too_long',
  'shift_scored',
  'shift_has_entries',
  'shift_shorter_than_entries',
  'shift_in_future',
  'shift_open',
  'spent_immutable',
  'spent_over_shift',
  'score_final',
  'not_manager',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Values substituted into the translated message, e.g. { taskId: 12 }. */
export type ErrorParams = Record<string, string | number | null>;

/** A zod validation issue without the server-side message and input. */
export type ErrorIssue = Omit<z.core.$ZodIssue, 'message' | 'input'>;

/** Shape of `error.data` that the server adds to every tRPC error. */
export type ErrorData = {
  appCode: ErrorCode;
  params?: ErrorParams;
  issues?: ErrorIssue[];
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
