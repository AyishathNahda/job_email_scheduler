/**
 * One error shape for the whole API. Every failure the client sees is
 *
 *   { "error": { "code": "SNAKE_CASE_CODE", "message": "...", "details"?: ... } }
 *
 * Services throw an {@link AppError}; the Express error middleware (Phase 6)
 * serialises it with {@link toErrorBody} and its statusCode. Unknown/unexpected
 * errors are mapped to a generic 500 there so internal messages and stack
 * traces never leak to clients.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }

  // ── Constructors for the common cases ──────────────────────────────────────
  static validation(message: string, details?: unknown): AppError {
    return new AppError('VALIDATION_ERROR', 400, message, details);
  }
  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError('UNAUTHORIZED', 401, message);
  }
  static forbidden(message = 'Not allowed'): AppError {
    return new AppError('FORBIDDEN', 403, message);
  }
  static notFound(message = 'Resource not found'): AppError {
    return new AppError('NOT_FOUND', 404, message);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError('CONFLICT', 409, message, details);
  }
  static rateLimited(message = 'Rate limit exceeded', details?: unknown): AppError {
    return new AppError('RATE_LIMITED', 429, message, details);
  }
  static internal(message = 'Something went wrong'): AppError {
    return new AppError('INTERNAL_ERROR', 500, message);
  }
}

/** Serialise any thrown value into the standard body. Non-AppErrors become 500. */
export function toErrorBody(err: unknown): { statusCode: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, body: err.toBody() };
  }
  return {
    statusCode: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
  };
}
