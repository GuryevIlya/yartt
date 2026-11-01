import postgres from 'postgres';
import { z } from 'zod';
import { isErrorCode, type ErrorCode, type ErrorParams } from '#shared/errors.ts';

/** Business error with a stable code; the client translates it. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams;

  constructor(code: ErrorCode, params: ErrorParams = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

const CONSTRAINT_CODES: Record<string, ErrorCode> = {
  uq_employee_email: 'email_taken',
  employee_locale_check: 'invalid_locale',
  chk_employee_time_zone: 'invalid_time_zone',
  chk_employee_manager_not_self: 'manager_self',
  uq_task_tag_ids: 'tag_set_taken',
  chk_task_tag_ids_set: 'invalid_data',
  chk_tag_name: 'invalid_data',
  uq_observer_open: 'already_observer',
  excl_work_overlap: 'shift_overlap',
  chk_work_length: 'shift_too_long',
  // Two shifts starting at the same minute, written at once: the trigger saw neither.
  work_pkey: 'shift_overlap',
  chk_dependency_not_self: 'dependency_cycle',
};

const DetailSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

function detailParams(detail: string | undefined): ErrorParams {
  if (!detail) return {};
  try {
    const parsed = DetailSchema.safeParse(JSON.parse(detail));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

// Postgres error -> client code. Rules in triggers carry the code in HINT and
// parameters as JSON in DETAIL; constraint violations map by constraint name.
export function fromPostgres(error: unknown): AppError | null {
  if (!(error instanceof postgres.PostgresError)) return null;

  if (isErrorCode(error.hint)) return new AppError(error.hint, detailParams(error.detail));

  const byConstraint = error.constraint_name && CONSTRAINT_CODES[error.constraint_name];
  if (byConstraint) return new AppError(byConstraint);

  // An unknown time zone fails while the CHECK is evaluated, without a constraint name.
  if (error.code === '22023' && error.message.includes('time zone')) {
    return new AppError('invalid_time_zone');
  }

  switch (error.code) {
    case '23503': // foreign_key_violation
      return new AppError('not_found');
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '22023': // invalid_parameter_value
    case '23502': // not_null_violation
    case '23514': // check_violation
      return new AppError('invalid_data');
    default:
      return null;
  }
}
