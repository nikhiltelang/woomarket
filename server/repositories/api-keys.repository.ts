import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { apiIdempotencyKeys, apiKeys, apiUsedSignatures, type ApiKey } from "@shared/schema";

type NewApiKey = Omit<typeof apiKeys.$inferInsert, "id" | "createdAt">;

export const apiKeysRepository = {
  async create(values: NewApiKey & { id: string }): Promise<ApiKey> {
    await db.insert(apiKeys).values(values);
    return (await this.find(values.id))!;
  },
  async find(id: string): Promise<ApiKey | undefined> {
    return (await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1))[0];
  },
  async findByAccessKeyId(accessKeyId: string): Promise<ApiKey | undefined> {
    return (await db.select().from(apiKeys).where(eq(apiKeys.accessKeyId, accessKeyId)).limit(1))[0];
  },
  listByTenant(userId: string) {
    return db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt));
  },
  async revoke(id: string) {
    await db.update(apiKeys).set({ status: "revoked", revokedAt: new Date() }).where(eq(apiKeys.id, id));
  },
  delete: (id: string) => db.delete(apiKeys).where(eq(apiKeys.id, id)),
  async touch(id: string, ip: string | null) {
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(), lastUsedIp: ip, requestCount: sql`${apiKeys.requestCount} + 1` })
      .where(eq(apiKeys.id, id));
  },

  /** Records a signature; false when it was already used (a replay). */
  async claimSignature(signature: string, expiresAt: Date): Promise<boolean> {
    const [res] = await db.insert(apiUsedSignatures).ignore().values({ signature, expiresAt });
    return res.affectedRows === 1;
  },

  async findIdempotent(apiKeyId: string, key: string) {
    return (await db.select().from(apiIdempotencyKeys).where(and(eq(apiIdempotencyKeys.apiKeyId, apiKeyId), eq(apiIdempotencyKeys.idempotencyKey, key))).limit(1))[0];
  },
  async completeIdempotent(id: number, statusCode: number, response: unknown) {
    await db.update(apiIdempotencyKeys).set({ statusCode, response }).where(eq(apiIdempotencyKeys.id, id));
  },
  releaseIdempotent: (id: number) => db.delete(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.id, id)),
  /** Reserves a key (statusCode 0 = in progress); false if it already exists. */
  async saveIdempotent(v: { apiKeyId: string; idempotencyKey: string; requestHash: string; statusCode: number; response: unknown }): Promise<boolean> {
    const [res] = await db.insert(apiIdempotencyKeys).ignore().values(v);
    return res.affectedRows === 1;
  },

  async prune(now = new Date()) {
    const [a] = await db.delete(apiUsedSignatures).where(lt(apiUsedSignatures.expiresAt, now));
    const [b] = await db.delete(apiIdempotencyKeys).where(lt(apiIdempotencyKeys.createdAt, new Date(now.getTime() - 24 * 3600_000)));
    // Reservations left "in progress" by a crashed request.
    const [c] = await db.delete(apiIdempotencyKeys).where(and(eq(apiIdempotencyKeys.statusCode, 0), lt(apiIdempotencyKeys.createdAt, new Date(now.getTime() - 10 * 60_000))));
    return a.affectedRows + b.affectedRows + c.affectedRows;
  },
};
