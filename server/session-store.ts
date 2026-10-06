import session from "express-session";
import { eq, lt, sql } from "drizzle-orm";
import { db } from "./db";
import { session as sessionTable } from "@shared/schema";
import { childLogger } from "./lib/logger";

const log = childLogger("session-store");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
type Cb = (err?: unknown, data?: any) => void;

/** express-session store persisting to the `session` table (sid, sess JSON, expire). */
export class MySqlSessionStore extends session.Store {
  private timer: NodeJS.Timeout;

  constructor(cleanupIntervalMs = 15 * 60 * 1000) {
    super();
    this.timer = setInterval(() => void this.prune(), cleanupIntervalMs);
    this.timer.unref();
  }

  private expiry(sess: session.SessionData): Date {
    const exp = sess.cookie?.expires;
    if (exp) return new Date(exp);
    return new Date(Date.now() + (sess.cookie?.maxAge ?? DEFAULT_TTL_MS));
  }

  get(sid: string, cb: Cb) {
    db.select()
      .from(sessionTable)
      .where(eq(sessionTable.sid, sid))
      .limit(1)
      .then(([row]) => {
        if (!row || row.expire.getTime() < Date.now()) return cb(null, null);
        cb(null, typeof row.sess === "string" ? JSON.parse(row.sess) : row.sess);
      })
      .catch(cb);
  }

  set(sid: string, sess: session.SessionData, cb?: Cb) {
    const expire = this.expiry(sess);
    db.insert(sessionTable)
      .values({ sid, sess, expire })
      .onDuplicateKeyUpdate({ set: { sess, expire } })
      .then(() => cb?.())
      .catch((err) => cb?.(err));
  }

  destroy(sid: string, cb?: Cb) {
    db.delete(sessionTable)
      .where(eq(sessionTable.sid, sid))
      .then(() => cb?.())
      .catch((err) => cb?.(err));
  }

  touch(sid: string, sess: session.SessionData, cb?: Cb) {
    db.update(sessionTable)
      .set({ expire: this.expiry(sess) })
      .where(eq(sessionTable.sid, sid))
      .then(() => cb?.())
      .catch((err) => cb?.(err));
  }

  async prune(): Promise<void> {
    try {
      await db.delete(sessionTable).where(lt(sessionTable.expire, sql`CURRENT_TIMESTAMP(3)`));
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Session cleanup failed");
    }
  }

  close() {
    clearInterval(this.timer);
  }
}
