import { and, eq, inArray, type SQL } from "drizzle-orm";
import { users } from "@shared/schema";
import type { z } from "zod";
import type { sendNotificationSchema } from "@shared/platform";
import { db } from "../db";
import { childLogger } from "../lib/logger";
import { notificationsRepository } from "../repositories/platform.repository";
import { realtime } from "./realtime";
import { systemConfig } from "./system-config.service";
import { sendSystemEmail, textToHtml } from "./email/system-mail";

const log = childLogger("notifications");

type Input = z.infer<typeof sendNotificationSchema>;

async function resolveRecipients(input: Pick<Input, "targetType" | "targetIds">) {
  const conds: SQL[] = [eq(users.status, "active")];
  if (input.targetType === "admins") conds.push(eq(users.role, "admin"));
  if (input.targetType === "team") conds.push(eq(users.role, "team"));
  if (input.targetType === "superadmins") conds.push(eq(users.role, "superadmin"));
  if (input.targetType === "users") conds.push(inArray(users.id, input.targetIds));
  return db.select({ id: users.id, email: users.email }).from(users).where(and(...conds));
}

/** Creates a notification and delivers it in-app (realtime) and/or by email. */
export async function sendNotification(input: Input, createdBy: string) {
  const recipients = await resolveRecipients(input);
  const n = await notificationsRepository.create({
    title: input.title,
    message: input.message,
    type: input.type,
    createdBy,
    targetType: input.targetType,
    targetIds: input.targetType === "users" ? input.targetIds : [],
    status: "draft",
  });

  if (input.viaInApp && recipients.length) {
    await notificationsRepository.deliver(n.id, recipients.map((r) => r.id));
    for (const r of recipients) {
      realtime.toUser(r.id, "notification:new", { type: input.type, title: input.title, body: input.message.slice(0, 200), notificationId: n.id });
    }
  }
  await notificationsRepository.markSent(n.id);

  let emailQueued = 0;
  const cfg = await systemConfig.get();
  if (input.viaEmail && cfg.emailNotification) {
    emailQueued = recipients.length;
    // Delivered in the background so the request returns immediately.
    void (async () => {
      let ok = 0;
      for (const r of recipients) {
        try {
          await sendSystemEmail(r.email, input.title, textToHtml(input.message));
          ok++;
        } catch (err) {
          log.warn({ to: r.email, err: (err as Error).message }, "Notification email failed");
        }
      }
      log.info({ notificationId: n.id, sent: ok, total: recipients.length }, "Notification emails delivered");
    })();
  }
  return { notification: await notificationsRepository.find(n.id), recipients: recipients.length, emailQueued, emailDisabled: input.viaEmail && !cfg.emailNotification };
}
