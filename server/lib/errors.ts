export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, message, "BAD_REQUEST", details);
export const unauthorized = (message = "Authentication required") => new AppError(401, message, "UNAUTHORIZED");
export const forbidden = (message = "You do not have permission to perform this action", code = "FORBIDDEN") =>
  new AppError(403, message, code);
export const notFound = (what = "Resource") => new AppError(404, `${what} not found`, "NOT_FOUND");
export const conflict = (message: string, code = "CONFLICT") => new AppError(409, message, code);
export const unprocessable = (message: string, code = "UNPROCESSABLE") => new AppError(422, message, code);

/** MySQL duplicate-key error (ER_DUP_ENTRY). */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; cause?: { code?: string } } | null;
  return e?.code === "ER_DUP_ENTRY" || e?.errno === 1062 || e?.cause?.code === "ER_DUP_ENTRY";
}
