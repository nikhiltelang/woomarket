import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError, isDuplicateKeyError } from "../lib/errors";
import { logger } from "../lib/logger";

export function notFoundApi(req: Request, res: Response) {
  res.status(404).json({ success: false, message: `No route for ${req.method} ${req.path}`, code: "NOT_FOUND" });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ success: false, message: err.message, code: err.code, details: err.details });
    return;
  }
  if (err instanceof multer.MulterError) {
    res.status(400).json({ success: false, message: `Upload failed: ${err.message}`, code: err.code });
    return;
  }
  if (isDuplicateKeyError(err)) {
    res.status(409).json({ success: false, message: "A record with these details already exists", code: "DUPLICATE" });
    return;
  }
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) {
    // body-parser and similar client errors
    res.status(status).json({ success: false, message: (err as Error).message, code: "BAD_REQUEST" });
    return;
  }
  logger.error({ err, requestId: req.requestId, path: req.path, method: req.method }, "Unhandled error");
  res.status(500).json({
    success: false,
    message: "Internal server error",
    code: "INTERNAL",
    requestId: req.requestId,
  });
}
