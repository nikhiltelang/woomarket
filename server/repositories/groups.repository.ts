import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { groups, type Group } from "@shared/schema";

export const groupsRepository = {
  async findById(id: string): Promise<Group | undefined> {
    const [row] = await db.select().from(groups).where(eq(groups.id, id)).limit(1);
    return row;
  },

  /** Groups owned by the tenant; optionally restricted to one channel (plus channel-less groups). */
  async listByTenant(tenantId: string, channelId?: string): Promise<Group[]> {
    const where = channelId
      ? and(eq(groups.createdBy, tenantId), or(eq(groups.channelId, channelId), isNull(groups.channelId)))
      : eq(groups.createdBy, tenantId);
    return db.select().from(groups).where(where).orderBy(desc(groups.createdAt));
  },

  async create(values: { name: string; description?: string | null; channelId?: string | null; createdBy: string }) {
    const id = randomUUID();
    await db.insert(groups).values({ ...values, id });
    return (await this.findById(id))!;
  },

  async update(id: string, patch: { name?: string; description?: string | null }) {
    if (Object.keys(patch).length) await db.update(groups).set(patch).where(eq(groups.id, id));
    return this.findById(id);
  },

  async delete(id: string): Promise<void> {
    await db.delete(groups).where(eq(groups.id, id));
  },
};
