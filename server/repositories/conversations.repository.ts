import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import {
  conversationAssignments,
  conversationPins,
  conversations,
  messages,
  users,
  type Conversation,
  type Message,
} from "@shared/schema";
import { likePattern } from "../lib/http";

type NewMessage = typeof messages.$inferInsert;

export interface ConversationRow extends Conversation {
  assigneeName: string | null;
  pinned: boolean;
}

export const conversationsRepository = {
  async findById(id: string): Promise<Conversation | undefined> {
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    return row;
  },

  async findByChannelAndPhone(channelId: string, phone: string): Promise<Conversation | undefined> {
    const [row] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.channelId, channelId), eq(conversations.contactPhone, phone)))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row;
  },

  async list(
    channelId: string,
    userId: string,
    opts: { page: number; limit: number; search?: string; status?: string; assigned?: string; unread?: boolean },
  ): Promise<{ rows: ConversationRow[]; total: number }> {
    const conds: SQL[] = [eq(conversations.channelId, channelId)];
    if (opts.search) {
      const p = likePattern(opts.search);
      conds.push(or(like(conversations.contactName, p), like(conversations.contactPhone, p))!);
    }
    if (opts.status) conds.push(eq(conversations.status, opts.status));
    if (opts.assigned === "me") conds.push(eq(conversations.assignedTo, userId));
    if (opts.assigned === "unassigned") conds.push(isNull(conversations.assignedTo));
    if (opts.unread) conds.push(sql`${conversations.unreadCount} > 0`);
    const where = and(...conds);
    const pinnedExpr = sql<number>`(${conversationPins.id} IS NOT NULL)`;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ c: conversations, assigneeName: users.username, pinned: pinnedExpr })
        .from(conversations)
        .leftJoin(users, eq(users.id, conversations.assignedTo))
        .leftJoin(
          conversationPins,
          and(eq(conversationPins.conversationId, conversations.id), eq(conversationPins.userId, userId)),
        )
        .where(where)
        .orderBy(desc(pinnedExpr), sql`${conversations.lastMessageAt} IS NULL`, desc(conversations.lastMessageAt))
        .limit(opts.limit)
        .offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(conversations).where(where),
    ]);
    return {
      rows: rows.map((r) => ({ ...r.c, assigneeName: r.assigneeName, pinned: Boolean(Number(r.pinned)) })),
      total,
    };
  },

  async create(values: Omit<typeof conversations.$inferInsert, "id">): Promise<Conversation> {
    const id = randomUUID();
    await db.insert(conversations).values({ ...values, id });
    return (await this.findById(id))!;
  },

  async update(id: string, patch: Partial<typeof conversations.$inferInsert>): Promise<Conversation | undefined> {
    if (Object.keys(patch).length) await db.update(conversations).set(patch).where(eq(conversations.id, id));
    return this.findById(id);
  },

  async recordMessage(
    id: string,
    m: { text: string; at: Date; inbound: boolean },
  ): Promise<void> {
    await db
      .update(conversations)
      .set({
        lastMessageAt: m.at,
        lastMessageText: m.text.slice(0, 500),
        ...(m.inbound
          ? {
              lastIncomingMessageAt: m.at,
              unreadCount: sql`${conversations.unreadCount} + 1`,
              status: sql`IF(${conversations.status} IN ('resolved','closed'), 'open', ${conversations.status})`,
            }
          : {}),
      })
      .where(eq(conversations.id, id));
  },

  async markRead(id: string): Promise<void> {
    await db.update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, id));
  },

  async delete(id: string): Promise<void> {
    await db.delete(conversations).where(eq(conversations.id, id));
  },

  async unreadCountForChannels(channelIds: string[]): Promise<number> {
    if (!channelIds.length) return 0;
    const [{ n }] = await db
      .select({ n: sql<number>`COALESCE(SUM(${conversations.unreadCount}), 0)` })
      .from(conversations)
      .where(inArray(conversations.channelId, channelIds));
    return Number(n);
  },

  async countOpen(channelId: string): Promise<number> {
    const [{ n }] = await db
      .select({ n: count() })
      .from(conversations)
      .where(and(eq(conversations.channelId, channelId), eq(conversations.status, "open")));
    return n;
  },

  // --- Assignments & pins ---------------------------------------------------

  async recordAssignment(conversationId: string, userId: string, assignedBy: string): Promise<void> {
    await db
      .update(conversationAssignments)
      .set({ status: "transferred", resolvedAt: new Date() })
      .where(and(eq(conversationAssignments.conversationId, conversationId), eq(conversationAssignments.status, "active")));
    await db.insert(conversationAssignments).values({ id: randomUUID(), conversationId, userId, assignedBy });
  },

  async pin(userId: string, conversationId: string, channelId: string | null): Promise<void> {
    await db.insert(conversationPins).ignore().values({ id: randomUUID(), userId, conversationId, channelId });
  },

  async unpin(userId: string, conversationId: string): Promise<void> {
    await db
      .delete(conversationPins)
      .where(and(eq(conversationPins.userId, userId), eq(conversationPins.conversationId, conversationId)));
  },

  async listPins(userId: string, channelId?: string): Promise<string[]> {
    const where = channelId
      ? and(eq(conversationPins.userId, userId), eq(conversationPins.channelId, channelId))
      : eq(conversationPins.userId, userId);
    const rows = await db.select({ id: conversationPins.conversationId }).from(conversationPins).where(where);
    return rows.map((r) => r.id);
  },
};

export const messagesRepository = {
  async findById(id: string): Promise<Message | undefined> {
    const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    return row;
  },

  async findByWhatsappId(wamid: string): Promise<Message | undefined> {
    const [row] = await db.select().from(messages).where(eq(messages.whatsappMessageId, wamid)).limit(1);
    return row;
  },

  /** Newest-first page, returned in chronological order. `before` is a message id cursor. */
  async listForConversation(conversationId: string, limit: number, before?: string): Promise<Message[]> {
    const conds: SQL[] = [eq(messages.conversationId, conversationId)];
    if (before) {
      const cursor = await this.findById(before);
      if (cursor?.createdAt) conds.push(lt(messages.createdAt, cursor.createdAt));
    }
    const rows = await db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse();
  },

  async create(values: Omit<NewMessage, "id">): Promise<Message> {
    const id = randomUUID();
    await db.insert(messages).values({ ...values, id });
    return (await this.findById(id))!;
  },

  async update(id: string, patch: Partial<NewMessage>): Promise<void> {
    await db.update(messages).set(patch).where(eq(messages.id, id));
  },

  async statsSince(channelId: string, since: Date) {
    const rows = await db
      .select({
        day: sql<string>`DATE(${messages.createdAt})`,
        direction: messages.direction,
        n: count(),
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(conversations.channelId, channelId), gte(messages.createdAt, since)))
      .groupBy(sql`DATE(${messages.createdAt})`, messages.direction)
      .orderBy(asc(sql`DATE(${messages.createdAt})`));
    return rows.map((r) => ({ day: String(r.day).slice(0, 10), direction: r.direction ?? "outbound", count: r.n }));
  },

  async countSince(since: Date): Promise<number> {
    const [{ n }] = await db.select({ n: count() }).from(messages).where(gte(messages.createdAt, since));
    return n;
  },
};
