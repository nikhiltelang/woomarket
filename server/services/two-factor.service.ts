/**
 * Two-factor authentication: setup, verification with replay protection, and recovery codes.
 */
import crypto from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { userTwoFactor, users, type User, type UserTwoFactor } from "@shared/schema";
import { db } from "../db";
import { decryptStoredSecret, encryptStoredSecret } from "../lib/crypto";
import { conflict, unprocessable } from "../lib/errors";
import { generateSecret, otpauthUrl, verifyTotp } from "../lib/totp";
import { systemConfig } from "./system-config.service";

export const RECOVERY_CODE_COUNT = 10;
const hash = (code: string) => crypto.createHash("sha256").update(code.toLowerCase().replace(/[\s-]/g, "")).digest("hex");

/** e.g. "k7m2p-9xq4r": unambiguous letters and digits. */
function recoveryCode(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const pick = () => Array.from(crypto.randomBytes(5), (b) => chars[b % chars.length]).join("");
  return `${pick()}-${pick()}`;
}

const sqlStepGuard = (userId: string, step: number) => and(eq(userTwoFactor.userId, userId), or(isNull(userTwoFactor.lastUsedStep), lt(userTwoFactor.lastUsedStep, step)));
const sqlCodesGuard = (userId: string, used: string) => and(eq(userTwoFactor.userId, userId), sql`JSON_CONTAINS(${userTwoFactor.recoveryCodes}, JSON_QUOTE(${used}))`);

export const twoFactorRepository = {
  async get(userId: string): Promise<UserTwoFactor | undefined> {
    const [row] = await db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, userId)).limit(1);
    return row;
  },
  async upsert(userId: string, patch: Partial<typeof userTwoFactor.$inferInsert>) {
    await db
      .insert(userTwoFactor)
      .values({ userId, ...patch })
      .onDuplicateKeyUpdate({ set: patch });
  },
  async remove(userId: string) {
    await db.delete(userTwoFactor).where(eq(userTwoFactor.userId, userId));
    await db.update(users).set({ twoFactorEnabledAt: null }).where(eq(users.id, userId));
  },
  async setEnabled(userId: string, at: Date | null) {
    await db.update(users).set({ twoFactorEnabledAt: at }).where(eq(users.id, userId));
  },
  /** Records a used step, unless another request already used it (atomic). */
  async claimStep(userId: string, step: number): Promise<boolean> {
    const [res] = await db
      .update(userTwoFactor)
      .set({ lastUsedStep: step })
      .where(sqlStepGuard(userId, step));
    return res.affectedRows === 1;
  },
  /** Removes one recovery code, unless it was already used (atomic). */
  async consumeRecoveryCode(userId: string, codes: string[], used: string): Promise<boolean> {
    const remaining = codes.filter((c) => c !== used);
    const [res] = await db
      .update(userTwoFactor)
      .set({ recoveryCodes: remaining })
      .where(sqlCodesGuard(userId, used));
    return res.affectedRows === 1;
  },
};

export async function issuerName(): Promise<string> {
  return (await systemConfig.get()).siteTitle || "WooMarket360";
}

/** Starts (or restarts) setup: a new secret that becomes active once a code is confirmed. */
export async function beginSetup(user: Pick<User, "id" | "email" | "twoFactorEnabledAt">) {
  if (user.twoFactorEnabledAt) throw conflict("Two-factor authentication is already on. Turn it off first to switch apps.");
  const secret = generateSecret();
  await twoFactorRepository.upsert(user.id, { pendingSecret: encryptStoredSecret(secret) });
  return { secret, otpauthUrl: otpauthUrl(secret, user.email, await issuerName()) };
}

function newRecoveryCodes() {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
  return { plain, hashes: plain.map(hash) };
}

/** Confirms setup with the first code; returns the recovery codes (shown once). */
export async function confirmSetup(userId: string, code: string): Promise<string[]> {
  const row = await twoFactorRepository.get(userId);
  if (!row?.pendingSecret) throw conflict("Start setup again: no pending authenticator was found.");
  const secret = decryptStoredSecret(row.pendingSecret);
  const step = verifyTotp(secret, code);
  if (step === null) throw unprocessable("That code didn't match. Check the time on your phone and try the newest code.", "INVALID_CODE");
  const codes = newRecoveryCodes();
  await twoFactorRepository.upsert(userId, { secret: encryptStoredSecret(secret), pendingSecret: null, recoveryCodes: codes.hashes, lastUsedStep: step });
  await twoFactorRepository.setEnabled(userId, new Date());
  return codes.plain;
}

export type CodeCheck = { ok: true; via: "totp" | "recovery"; recoveryLeft: number } | { ok: false };

/** Checks an authenticator code or a recovery code; each can be used only once. */
export async function checkCode(userId: string, code: string): Promise<CodeCheck> {
  const row = await twoFactorRepository.get(userId);
  if (!row?.secret) return { ok: false };
  const codes = row.recoveryCodes ?? [];
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const step = verifyTotp(decryptStoredSecret(row.secret), digits, { notAfterStep: row.lastUsedStep });
    if (step === null || !(await twoFactorRepository.claimStep(userId, step))) return { ok: false };
    return { ok: true, via: "totp", recoveryLeft: codes.length };
  }
  const h = hash(code);
  if (!codes.includes(h) || !(await twoFactorRepository.consumeRecoveryCode(userId, codes, h))) return { ok: false };
  return { ok: true, via: "recovery", recoveryLeft: codes.length - 1 };
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await twoFactorRepository.upsert(userId, { recoveryCodes: codes.hashes });
  return codes.plain;
}

export async function status(userId: string) {
  const row = await twoFactorRepository.get(userId);
  return { recoveryCodesLeft: row?.secret ? (row.recoveryCodes ?? []).length : 0 };
}
