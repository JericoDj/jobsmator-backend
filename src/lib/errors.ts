import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { logger } from "./logger";

/** Stable error codes — the clients switch on these, the design guide owns the wording. */
export type ApiErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "resume_unreadable"
  | "engine_unavailable"
  | "too_many_runs"
  | "run_in_progress"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  resume_unreadable: 422,
  engine_unavailable: 503,
  too_many_runs: 429,
  run_in_progress: 409,
  internal: 500,
};

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
  get status() {
    return STATUS[this.code];
  }
}

export function errorHandler(err: Error, c: Context) {
  if (err instanceof ApiError) {
    return c.json({ error: err.code, message: err.message, details: err.details ?? undefined }, err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json({ error: "invalid_request", message: "Some fields are missing or invalid.", details: err.issues }, 400);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: "internal", message: err.message }, err.status);
  }
  logger.error({ err }, "unhandled error");
  return c.json({ error: "internal", message: "Something went wrong on our side." }, 500);
}
