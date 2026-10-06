import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { templates, type Template } from "@shared/schema";

type NewTemplate = typeof templates.$inferInsert;

export const templatesRepository = {
  async findById(id: string): Promise<Template | undefined> {
    const [row] = await db.select().from(templates).where(eq(templates.id, id)).limit(1);
    return row;
  },

  async findByWhatsappId(channelId: string, whatsappTemplateId: string): Promise<Template | undefined> {
    const [row] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.channelId, channelId), eq(templates.whatsappTemplateId, whatsappTemplateId)))
      .limit(1);
    return row;
  },

  async findByWhatsappIdAnyChannel(whatsappTemplateId: string): Promise<Template[]> {
    return db.select().from(templates).where(eq(templates.whatsappTemplateId, whatsappTemplateId));
  },

  async listByChannel(channelId: string, status?: string): Promise<Template[]> {
    const where = status
      ? and(eq(templates.channelId, channelId), eq(templates.status, status))
      : eq(templates.channelId, channelId);
    return db.select().from(templates).where(where).orderBy(desc(templates.createdAt));
  },

  async create(values: Omit<NewTemplate, "id">): Promise<Template> {
    const id = randomUUID();
    await db.insert(templates).values({ ...values, id });
    return (await this.findById(id))!;
  },

  async update(id: string, patch: Partial<NewTemplate>): Promise<Template | undefined> {
    if (Object.keys(patch).length) await db.update(templates).set(patch).where(eq(templates.id, id));
    return this.findById(id);
  },

  async incrementUsage(id: string, by = 1): Promise<void> {
    await db
      .update(templates)
      .set({ usageCount: sql`${templates.usageCount} + ${by}` })
      .where(eq(templates.id, id));
  },

  async delete(id: string): Promise<void> {
    await db.delete(templates).where(eq(templates.id, id));
  },
};

/** Number of distinct {{n}} placeholders in a template body. */
export function countTemplateVariables(body: string): number {
  const nums = new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])));
  return nums.size;
}

/** Renders {{n}} placeholders with params (1-based). */
export function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] ?? `{{${n}}}`);
}
