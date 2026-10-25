import type { ErrorCode } from "@workspace/core";
import type { ZodType } from "zod";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_input: 400,
  gone: 410,
  too_large: 413,
  unsupported: 415,
  rate_limited: 429,
  internal: 500,
};

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  get status(): number {
    return STATUS[this.code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}

export const notFound = (what = "Page") => new AppError("not_found", `${what} not found`);
export const forbidden = (message = "You do not have access to do that") => new AppError("forbidden", message);
export const conflict = (message: string, current?: unknown) => new AppError("conflict", message, current ? { current } : undefined);

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      "invalid_input",
      "Invalid input",
      result.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}
