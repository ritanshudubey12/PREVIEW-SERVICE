export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PREVIEW_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    /** Internal-only reason used for audit logs; never sent to the client. */
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthenticated = (reason: string) =>
  new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.', reason);
export const forbidden = (reason: string) =>
  new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.', reason);
export const notFound = () => new AppError(404, 'NOT_FOUND', 'The requested resource was not found.');
export const previewUnavailable = () =>
  new AppError(410, 'PREVIEW_UNAVAILABLE', 'This preview is no longer available.');
export const validationError = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
