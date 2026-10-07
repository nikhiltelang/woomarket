import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { channels, contacts, type Contact } from "@shared/schema";
import { likePattern } from "../lib/http";

type NewContact = typeof contacts.$inferInsert;

export const contactsRepository = {
  async findById(id: string): Promise<Contact | undefined> {
    const [row] = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
    return row;
  },

  async findByPhone(channelId: string, phone: string): Promise<Contact | undefined> {
    const [row] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.channelId, channelId), eq(contacts.phone, phone)))
      .limit(1);
    return row;
  },

  async findManyByIds(channelId: string, ids: string[]): Promise<Contact[]> {
    if (!ids.length) return [];
    return db
      .select()
      .from(contacts)
      .where(and(eq(contacts.channelId, channelId), inArray(contacts.id, ids)));
  },

  async list(
    channelId: string,
    opts: { page: number; limit: number; search?: string; groupId?: string; status?: string },
  ): Promise<{ rows: Contact[]; total: number }> {
    const conds: SQL[] = [eq(contacts.channelId, channelId)];
    if (opts.search) {
      const p = likePattern(opts.search);
      conds.push(or(like(contacts.name, p), like(contacts.phone, p), like(contacts.email, p))!);
    }
    if (opts.groupId) conds.push(sql`JSON_CONTAINS(${contacts.groups}, JSON_QUOTE(${opts.groupId}))`);
    if (opts.status) conds.push(eq(contacts.status, opts.status));
    const where = and(...conds);
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.createdAt))
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(contacts).where(where),
    ]);
    return { rows, total };
  },

  /** Active contacts for a campaign audience. */
  async listAudience(channelId: string, audience: { groupIds?: string[]; contactIds?: string[]; where?: SQL }): Promise<Contact[]> {
    const conds: SQL[] = [eq(contacts.channelId, channelId), eq(contacts.status, "active")];
    if (audience.where) conds.push(audience.where);
    if (audience.contactIds?.length) conds.push(inArray(contacts.id, audience.contactIds));
    if (audience.groupIds?.length) {
      conds.push(or(...audience.groupIds.map((g) => sql`JSON_CONTAINS(${contacts.groups}, JSON_QUOTE(${g}))`))!);
    }
    return db
      .select()
      .from(contacts)
      .where(and(...conds));
  },

  async create(values: Omit<NewContact, "id">): Promise<Contact> {
    const id = randomUUID();
    await db.insert(contacts).values({ ...values, id });
    return (await this.findById(id))!;
  },

  /** Inserts many contacts; duplicates (same channel + phone) are skipped. Returns inserted count. */
  async insertManyIgnoreDuplicates(rows: Omit<NewContact, "id">[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, id: randomUUID() }));
      const [res] = await db.insert(contacts).ignore().values(chunk);
      inserted += res.affectedRows;
    }
    return inserted;
  },

  async fieldsByIds(ids: string[]): Promise<Map<string, Record<string, string>>> {
    const map = new Map<string, Record<string, string>>();
    if (!ids.length) return map;
    const rows = await db.select({ id: contacts.id, metadata: contacts.metadata }).from(contacts).where(inArray(contacts.id, [...new Set(ids)]));
    for (const r of rows) map.set(r.id, r.metadata ?? {});
    return map;
  },

  async existingPhones(channelId: string, phones: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < phones.length; i += 1000) {
      const rows = await db.select({ phone: contacts.phone }).from(contacts).where(and(eq(contacts.channelId, channelId), inArray(contacts.phone, phones.slice(i, i + 1000))));
      for (const r of rows) found.add(r.phone);
    }
    return found;
  },

  /** Merges custom fields into existing contacts by phone; returns how many were changed. */
  async mergeFields(channelId: string, rows: { phone: string; metadata: Record<string, string> }[]): Promise<number> {
    let changed = 0;
    for (const r of rows) {
      const [res] = await db
        .update(contacts)
        .set({ metadata: sql`JSON_MERGE_PATCH(COALESCE(${contacts.metadata}, JSON_OBJECT()), CAST(${JSON.stringify(r.metadata)} AS JSON))` })
        .where(and(eq(contacts.channelId, channelId), eq(contacts.phone, r.phone)));
      changed += res.affectedRows;
    }
    return changed;
  },

  /** Custom field names in use across the tenant (or one number), most common first. */
  async fieldKeys(tenantId: string, channelId: string | null): Promise<{ key: string; contacts: number }[]> {
    const [rows] = await db.execute(sql`
      SELECT jt.k AS \`key\`, COUNT(*) AS n
        FROM ${contacts} c
        JOIN ${channels} ch ON ch.id = c.channel_id,
             JSON_TABLE(JSON_KEYS(COALESCE(c.metadata, JSON_OBJECT())), '$[*]' COLUMNS (k VARCHAR(64) PATH '$')) jt
       WHERE ch.created_by = ${tenantId} ${channelId ? sql`AND c.channel_id = ${channelId}` : sql``}
       GROUP BY jt.k
       ORDER BY n DESC, jt.k
       LIMIT 200`);
    return (rows as unknown as { key: string; n: number }[]).map((r) => ({ key: r.key, contacts: Number(r.n) }));
  },

  async update(id: string, patch: Partial<NewContact>): Promise<Contact | undefined> {
    if (Object.keys(patch).length) await db.update(contacts).set(patch).where(eq(contacts.id, id));
    return this.findById(id);
  },

  async delete(id: string): Promise<void> {
    await db.delete(contacts).where(eq(contacts.id, id));
  },

  async deleteMany(channelId: string, ids: string[]): Promise<number> {
    const [res] = await db.delete(contacts).where(and(eq(contacts.channelId, channelId), inArray(contacts.id, ids)));
    return res.affectedRows;
  },

  async countByChannel(channelId: string): Promise<number> {
    const [{ n }] = await db.select({ n: count() }).from(contacts).where(eq(contacts.channelId, channelId));
    return n;
  },

  async countByTenant(tenantId: string): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(contacts)
      .innerJoin(channels, eq(channels.id, contacts.channelId))
      .where(eq(channels.createdBy, tenantId));
    return n;
  },

  async countByGroup(groupIds: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    await Promise.all(
      groupIds.map(async (g) => {
        const [{ n }] = await db
          .select({ n: count() })
          .from(contacts)
          .where(sql`JSON_CONTAINS(${contacts.groups}, JSON_QUOTE(${g}))`);
        result[g] = n;
      }),
    );
    return result;
  },

  async setGroups(updates: { id: string; groups: string[] }[]): Promise<void> {
    await db.transaction(async (tx) => {
      for (const u of updates) await tx.update(contacts).set({ groups: u.groups }).where(eq(contacts.id, u.id));
    });
  },

  async removeGroupEverywhere(groupId: string): Promise<void> {
    await db
      .update(contacts)
      .set({
        groups: sql`JSON_REMOVE(${contacts.groups}, JSON_UNQUOTE(JSON_SEARCH(${contacts.groups}, 'one', ${groupId})))`,
      })
      .where(sql`JSON_CONTAINS(${contacts.groups}, JSON_QUOTE(${groupId}))`);
  },
};
