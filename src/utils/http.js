// Shared request/response helpers used by every controller.

export class AppError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (message, details) => new AppError(400, message, details);
export const notFound = (message = 'Record not found.') => new AppError(404, message);
export const conflict = (message) => new AppError(409, message);
export const forbidden = (message = 'You do not have access to this resource.') => new AppError(403, message);

export function getRequestMeta(req) {
  return {
    ipAddress: req.ip || null,
    userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 500) : null,
  };
}

export function currentUserId(req) {
  return req.user?.user_id ?? req.user?.id ?? null;
}

export function cleanString(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function optionalString(value, max = 1000) {
  const cleaned = cleanString(value, max);
  return cleaned || null;
}

export function parseId(value, label = 'ID') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`A valid ${label} is required.`);
  return id;
}

export function parsePagination(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function paginationMeta(page, limit, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

// Maps PostgreSQL errors to safe messages; anything unknown becomes a generic 500.
export function toHttpError(error) {
  if (error instanceof AppError) return error;
  if (error?.code === '23505') return new AppError(409, 'A record with the same unique information already exists.');
  if (error?.code === '23503') return new AppError(409, 'This record is linked to other records and cannot be changed that way.');
  if (error?.code === '23514' || error?.code === '22P02' || error?.code === '22003' || error?.code === '22007' || error?.code === '22008') {
    return new AppError(400, 'Some of the submitted values are invalid.');
  }
  if (error?.code === 'LIMIT_FILE_SIZE') return new AppError(400, 'The uploaded file is too large.');
  if (error?.code === 'LIMIT_UNEXPECTED_FILE') return new AppError(400, 'This file type is not supported.');
  if (error?.type === 'entity.too.large') return new AppError(413, 'The request is too large.');
  if (error?.type === 'entity.parse.failed') return new AppError(400, 'The request body is not valid JSON.');
  return new AppError(500, 'Something went wrong. Please try again.');
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const httpError = toHttpError(err);
  if (httpError.status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, err);
  }
  return res.status(httpError.status).json({
    success: false,
    message: httpError.message,
    ...(httpError.details ? { errors: httpError.details } : {}),
  });
}
