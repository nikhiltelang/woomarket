import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { badRequest } from "./errors";

/** Wraps an async handler so rejections reach the error middleware (Express 4). */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fieldErrors = result.error.flatten().fieldErrors;
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw badRequest(`Validation failed — ${where}${first?.message ?? "invalid input"}`, fieldErrors);
  }
  return result.data;
}

export const parseBody = <S extends ZodTypeAny>(schema: S, req: Request) => parse(schema, req.body ?? {});
export const parseQuery = <S extends ZodTypeAny>(schema: S, req: Request) => parse(schema, req.query);

export function paginated<T>(data: T[], total: number, page: number, limit: number) {
  return { data, total, page, limit };
}

/** Escapes LIKE wildcards in user-supplied search text. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
