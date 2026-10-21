import { stat } from "node:fs/promises";
import path from "node:path";
import { ZodError, type ZodType } from "zod";
import type { ApiErrorBody } from "../../shared/api";
import { AppError, badRequest } from "../errors";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

export function errorResponse(err: unknown, log: (m: string) => void): Response {
  if (err instanceof AppError) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message, details: err.details } };
    return json(body, err.status);
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    return json({ error: { code: "BAD_REQUEST", message: `Invalid request: ${issues.join("; ")}` } } satisfies ApiErrorBody, 400);
  }
  log(`[http] unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  return json({ error: { code: "INTERNAL", message } } satisfies ApiErrorBody, 500);
}

/** Parses and validates a JSON request body. */
export async function readBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json.");
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest("The request body is not valid JSON.");
  }
  return schema.parse(raw);
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Serves a file with single-range support (needed for video seeking). */
export async function serveFile(req: Request, file: string, cacheControl: string): Promise<Response> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new AppError(404, "NOT_FOUND", "File not found.");
  const size = info.size;
  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(file),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "Last-Modified": info.mtime.toUTCString(),
    ...SECURITY_HEADERS,
  };
  const range = req.headers.get("range");
  const body = Bun.file(file);
  if (!range) {
    headers["Content-Length"] = String(size);
    return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start: number;
  let end: number;
  if (!m || (m[1] === "" && m[2] === "")) return rangeNotSatisfiable(size, headers);
  if (m[1] === "") {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return rangeNotSatisfiable(size, headers);
  }
  headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  headers["Content-Length"] = String(end - start + 1);
  return new Response(req.method === "HEAD" ? null : body.slice(start, end + 1), { status: 206, headers });
}

function rangeNotSatisfiable(size: number, headers: Record<string, string>): Response {
  return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
}
