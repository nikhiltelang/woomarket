import { and, count, desc, eq, like, or, sql } from "drizzle-orm";
import { db } from "../db";
import { likePattern } from "../lib/http";
import { couponRedemptions, coupons, type Coupon } from "@shared/schema";

type NewCoupon = Omit<typeof coupons.$inferInsert, "id" | "usedCount" | "createdAt" | "updatedAt">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const couponsRepository = {
  async list(opts: { page: number; limit: number; search?: string }) {
    const where = opts.search ? or(like(coupons.name, likePattern(opts.search)), like(coupons.code, likePattern(opts.search))) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      db.select().from(coupons).where(where).orderBy(desc(coupons.createdAt), desc(coupons.id)).limit(opts.limit).offset((opts.page - 1) * opts.limit),
      db.select({ total: count() }).from(coupons).where(where),
    ]);
    return { rows, total };
  },

  async find(id: number): Promise<Coupon | undefined> {
    return (await db.select().from(coupons).where(eq(coupons.id, id)).limit(1))[0];
  },

  async findByCode(code: string): Promise<Coupon | undefined> {
    return (await db.select().from(coupons).where(eq(coupons.code, code.toUpperCase())).limit(1))[0];
  },

  async create(v: NewCoupon): Promise<Coupon> {
    const [res] = await db.insert(coupons).values(v);
    return (await this.find(res.insertId))!;
  },

  async update(id: number, patch: Partial<NewCoupon>): Promise<Coupon | undefined> {
    await db.update(coupons).set(patch).where(eq(coupons.id, id));
    return this.find(id);
  },

  delete: (id: number) => db.delete(coupons).where(eq(coupons.id, id)),

  /**
   * Counts one use inside the caller's transaction. The conditions are re-checked in the
   * UPDATE itself, so concurrent redemptions can never exceed the usage limit.
   */
  async redeem(tx: Tx, couponId: number, userId: string, subscriptionId: string, discount: string): Promise<boolean> {
    const [res] = await tx
      .update(coupons)
      .set({ usedCount: sql`${coupons.usedCount} + 1` })
      .where(
        and(
          eq(coupons.id, couponId),
          eq(coupons.status, true),
          sql`(${coupons.usageLimit} = -1 OR ${coupons.usedCount} < ${coupons.usageLimit})`,
          sql`(${coupons.expiryType} = 'lifetime' OR ${coupons.expiresAt} > CURRENT_TIMESTAMP(3))`,
        ),
      );
    if (!res.affectedRows) return false;
    await tx.insert(couponRedemptions).values({ couponId, userId, subscriptionId, discount });
    return true;
  },
};
