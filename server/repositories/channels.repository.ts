import { randomUUID } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { channels, type Channel, type InsertChannel } from "@shared/schema";
import type { PublicChannel } from "@shared/api-types";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/crypto";

export function toPublicChannel(c: Channel): PublicChannel {
  let tokenPreview = "••••";
  try {
    tokenPreview = maskSecret(decryptSecret(c.accessToken));
  } catch {}
  return {
    id: c.id,
    name: c.name,
    phoneNumberId: c.phoneNumberId,
    phoneNumber: c.phoneNumber,
    whatsappBusinessAccountId: c.whatsappBusinessAccountId,
    isActive: c.isActive ?? true,
    healthStatus: c.healthStatus,
    healthDetails: c.healthDetails ?? {},
    lastHealthCheck: c.lastHealthCheck?.toISOString() ?? null,
    connectionMethod: c.connectionMethod ?? "embedded",
    createdBy: c.createdBy,
    createdAt: c.createdAt?.toISOString() ?? null,
    tokenPreview,
    isCoexistence: Boolean(c.isCoexistence),
    businessId: c.businessId ?? null,
    onboarding: c.onboarding ?? null,
    hasPin: Boolean(c.twoStepPin),
  };
}

export const channelAccessToken = (c: Channel): string => decryptSecret(c.accessToken);

export const channelsRepository = {
  async findById(id: string): Promise<Channel | undefined> {
    const [row] = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
    return row;
  },

  async findByPhoneNumberId(phoneNumberId: string): Promise<Channel | undefined> {
    const [row] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.phoneNumberId, phoneNumberId), eq(channels.isActive, true)))
      .limit(1);
    return row;
  },

  async listByTenant(tenantId: string): Promise<Channel[]> {
    return db.select().from(channels).where(eq(channels.createdBy, tenantId)).orderBy(desc(channels.createdAt));
  },

  async listAll(page: number, limit: number): Promise<{ rows: Channel[]; total: number }> {
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(channels)
        .orderBy(desc(channels.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(channels),
    ]);
    return { rows, total };
  },

  async listActive(): Promise<Channel[]> {
    return db.select().from(channels).where(eq(channels.isActive, true));
  },

  async countByTenant(tenantId: string): Promise<number> {
    const [{ n }] = await db.select({ n: count() }).from(channels).where(eq(channels.createdBy, tenantId));
    return n;
  },

  async countAll(): Promise<number> {
    const [{ n }] = await db.select({ n: count() }).from(channels);
    return n;
  },

  async create(values: Omit<InsertChannel, "id">): Promise<Channel> {
    const id = randomUUID();
    await db.insert(channels).values({ ...values, id, accessToken: encryptSecret(values.accessToken) });
    return (await this.findById(id))!;
  },

  async update(id: string, patch: Partial<InsertChannel>): Promise<Channel | undefined> {
    const values = { ...patch };
    if (values.accessToken) values.accessToken = encryptSecret(values.accessToken);
    if (Object.keys(values).length) await db.update(channels).set(values).where(eq(channels.id, id));
    return this.findById(id);
  },

  async recordHealth(id: string, status: string, details: Record<string, unknown>): Promise<void> {
    await db
      .update(channels)
      .set({ healthStatus: status, healthDetails: details, lastHealthCheck: sql`CURRENT_TIMESTAMP(3)` })
      .where(eq(channels.id, id));
  },

  async delete(id: string): Promise<void> {
    await db.delete(channels).where(eq(channels.id, id));
  },
};
