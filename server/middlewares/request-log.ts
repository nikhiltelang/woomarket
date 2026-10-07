import type { NextFunction, Request, Response } from "express";
import { MAX_BODY_CHARS, redactHeaders, redactText, redactValue, truncate } from "../lib/redact";
import { enqueueRequestLog, requestLogSettings } from "../services/request-log.service";

// The log viewer itself is never logged, or every refresh would add rows.
const ALWAYS_EXCLUDED = ["/api/superadmin/request-logs"];
const CAPTURE_LIMIT = MAX_BODY_CHARS * 4; // raw bytes kept; long UTF-8 text still fits the char limit
const TEXTUAL = /json|text\/|xml|javascript|x-www-form-urlencoded/i;

const isLogged = (path: string) => path.startsWith("/api") || path.startsWith("/webhook");
const matches = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`) || path.startsWith(`${p}?`));

function requestBody(req: Request, path: string): string | null {
  const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : req.files ? Object.values(req.files).flat() : [];
  const body = req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : null;
  if (!body && !files.length) return null;
  const payload = files.length
    ? { fields: body ?? {}, files: files.map((f) => ({ field: f.fieldname, name: f.originalname, type: f.mimetype, size: f.size })) }
    : body;
  return truncate(JSON.stringify(redactValue(payload, path)));
}

function responseBody(buf: Buffer, total: number, contentType: string, path: string): string | null {
  if (!total) return null;
  if (!TEXTUAL.test(contentType)) return `[${contentType || "binary"} content, ${total} bytes — not stored]`;
  const complete = total <= buf.length;
  const text = buf.toString("utf8");
  if (complete && /json/i.test(contentType)) {
    try {
      return truncate(JSON.stringify(redactValue(JSON.parse(text), path)), total);
    } catch {
      // not valid JSON after all; fall through to text redaction
    }
  }
  return truncate(redactText(text, path), total) + (complete ? "" : `\n…[truncated; ${total} bytes in total]`);
}

/**
 * Records every API and webhook request with its response in `request_logs`
 * (Superadmin → Logs). Sensitive values are redacted before anything is stored.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const path = req.originalUrl.split("?")[0];
  if (!isLogged(path) || matches(path, ALWAYS_EXCLUDED)) return next();

  const requestedAt = new Date();
  const started = process.hrtime.bigint();
  const chunks: Buffer[] = [];
  let captured = 0;
  let total = 0;
  const collect = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === "function") return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    total += buf.length;
    if (captured < CAPTURE_LIMIT) {
      const part = buf.subarray(0, CAPTURE_LIMIT - captured);
      chunks.push(part);
      captured += part.length;
    }
  };
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    collect(chunk, rest[0]);
    return write(chunk, ...rest);
  }) as Response["write"];
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    collect(chunk, rest[0]);
    return end(chunk, ...rest);
  }) as Response["end"];

  let done = false;
  const record = (aborted: boolean) => {
    if (done) return;
    done = true;
    const respondedAt = new Date();
    const durationMs = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100;
    void requestLogSettings()
      .then((s) => {
        if (!s.enabled || matches(path, s.excludePaths)) return;
        const query = Object.keys(req.query ?? {}).length ? (redactValue(req.query, path) as Record<string, unknown>) : null;
        const user = req.user;
        enqueueRequestLog({
          requestId: req.requestId ?? "",
          method: req.method.slice(0, 10),
          path: path.slice(0, 500),
          query,
          statusCode: aborted && !res.headersSent ? 499 : res.statusCode,
          aborted,
          userId: user?.id ?? req.session?.userId ?? null,
          username: user?.username ?? null,
          role: user?.role ?? null,
          ip: (req.ip ?? "").slice(0, 64) || null,
          userAgent: req.get("user-agent")?.slice(0, 500) ?? null,
          requestHeaders: redactHeaders(req.headers),
          requestBody: s.captureBodies ? requestBody(req, path) : null,
          requestSize: Number(req.get("content-length")) || null,
          responseHeaders: redactHeaders(res.getHeaders()),
          responseBody: s.captureBodies ? responseBody(Buffer.concat(chunks), total, String(res.getHeader("content-type") ?? ""), path) : null,
          responseSize: total,
          requestedAt,
          respondedAt,
          durationMs,
        });
      })
      .catch(() => {}); // settings unavailable (database down): skip logging, never fail the request
  };
  res.on("finish", () => record(false));
  res.on("close", () => record(!res.writableFinished));
  next();
}
