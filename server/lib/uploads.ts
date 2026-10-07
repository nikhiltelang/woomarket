import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { badRequest } from "./errors";

export const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

const SIGNATURES: { ext: string; test: (b: Buffer) => boolean }[] = [
  { ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", test: (b) => b.subarray(0, 4).toString("ascii") === "GIF8" },
  { ext: "webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
  { ext: "ico", test: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
];

/** In-memory multer for small images; the type is decided by file content, never the name. */
export const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 4 } });

/**
 * Stores an uploaded image under uploads/<folder>/ with a random name and returns its public URL.
 * SVG is rejected on purpose: it can carry scripts.
 */
export async function saveImage(file: Express.Multer.File, folder: string): Promise<string> {
  const kind = SIGNATURES.find((s) => s.test(file.buffer));
  if (!kind) throw badRequest(`${file.fieldname}: upload a PNG, JPG, GIF, WebP or ICO image`);
  const dir = path.join(UPLOADS_DIR, folder);
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomBytes(12).toString("hex")}.${kind.ext}`;
  await fs.writeFile(path.join(dir, name), file.buffer);
  return `/uploads/${folder}/${name}`;
}

/** Best-effort removal of a previously stored upload (only inside UPLOADS_DIR). */
export async function removeUpload(url: string | null | undefined): Promise<void> {
  if (!url?.startsWith("/uploads/")) return;
  const full = path.resolve(UPLOADS_DIR, url.slice("/uploads/".length));
  if (!full.startsWith(UPLOADS_DIR + path.sep)) return;
  await fs.rm(full, { force: true }).catch(() => {});
}
