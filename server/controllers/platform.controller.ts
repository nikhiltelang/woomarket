import type { Request, Response } from "express";
import { accessLevelSchema, assignLevelSchema, languageSchema, policyPageSchema, sendNotificationSchema, translationsSchema } from "@shared/platform";
import { BASE_TRANSLATIONS } from "@shared/platform";
import { paginationQuery } from "@shared/validation";
import { paginated, parseBody, parseQuery } from "../lib/http";
import { badRequest, conflict, isDuplicateKeyError, notFound } from "../lib/errors";
import { activityRepository } from "../repositories/activity.repository";
import { usersRepository, toPublicUser } from "../repositories/users.repository";
import { languagesRepository, levelsRepository, notificationsRepository, policyRepository } from "../repositories/platform.repository";
import { systemConfig } from "../services/system-config.service";
import { sendNotification } from "../services/notification.service";

const dup = (what: string) => (err: unknown) => {
  if (isDuplicateKeyError(err)) throw conflict(`${what} already exists`);
  throw err;
};

// ---------------------------------------------------------------------------
// Policy pages
// ---------------------------------------------------------------------------

export const policies = {
  async listAdmin(_req: Request, res: Response) {
    res.json({ data: await policyRepository.list() });
  },
  async listPublic(_req: Request, res: Response) {
    res.json({ data: await policyRepository.listPublished() });
  },
  async bySlug(req: Request, res: Response) {
    const page = await policyRepository.findBySlug(req.params.slug);
    if (!page || (!page.isPublished && req.user?.role !== "superadmin")) throw notFound("Page");
    res.json({ data: page });
  },
  async create(req: Request, res: Response) {
    const input = parseBody(policyPageSchema, req);
    const page = await policyRepository.create(input).catch(dup("A page with this slug"));
    systemConfig.invalidate();
    await activityRepository.record(req, req.user!.id, "policy_page_created", { type: "policy_page", id: page.id });
    res.status(201).json({ data: page });
  },
  async update(req: Request, res: Response) {
    const page = await policyRepository.find(req.params.id);
    if (!page) throw notFound("Page");
    const input = parseBody(policyPageSchema, req);
    if (page.isSystem && input.slug !== page.slug) throw badRequest("Built-in pages keep their address; change the title instead");
    const updated = await policyRepository.update(page.id, input).catch(dup("A page with this slug"));
    systemConfig.invalidate();
    res.json({ data: updated });
  },
  async remove(req: Request, res: Response) {
    const page = await policyRepository.find(req.params.id);
    if (!page) throw notFound("Page");
    if (page.isSystem) throw badRequest("Built-in pages can be unpublished but not deleted");
    await policyRepository.delete(page.id);
    systemConfig.invalidate();
    res.json({ success: true });
  },
};

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export const languages = {
  async list(_req: Request, res: Response) {
    res.json({ data: await languagesRepository.list(), baseKeys: BASE_TRANSLATIONS });
  },
  async enabled(_req: Request, res: Response) {
    res.json({ data: await languagesRepository.listEnabled() });
  },
  async translations(req: Request, res: Response) {
    const lang = await languagesRepository.findByCode(req.params.code);
    if (!lang || !lang.isEnabled) throw notFound("Language");
    res.setHeader("Cache-Control", "no-cache");
    res.json({ code: lang.code, direction: lang.direction, translations: lang.translations ?? {} });
  },
  async create(req: Request, res: Response) {
    const input = parseBody(languageSchema, req);
    const lang = await languagesRepository.create({ ...input, icon: input.icon ?? null, translations: {} }).catch(dup("A language with this code"));
    systemConfig.invalidate();
    res.status(201).json({ data: lang });
  },
  async update(req: Request, res: Response) {
    const lang = await languagesRepository.find(req.params.id);
    if (!lang) throw notFound("Language");
    const input = parseBody(languageSchema, req);
    if (lang.isDefault && !input.isEnabled) throw badRequest("The default language can't be disabled");
    const updated = await languagesRepository.update(lang.id, { ...input, icon: input.icon ?? null }).catch(dup("A language with this code"));
    systemConfig.invalidate();
    res.json({ data: updated });
  },
  async saveTranslations(req: Request, res: Response) {
    const lang = await languagesRepository.find(req.params.id);
    if (!lang) throw notFound("Language");
    const { translations } = parseBody(translationsSchema, req);
    // Only known keys with non-empty values are kept; blanks fall back to English.
    const clean = Object.fromEntries(Object.entries(translations).filter(([k, v]) => k in BASE_TRANSLATIONS && v.trim()));
    res.json({ data: await languagesRepository.update(lang.id, { translations: clean }) });
  },
  async setDefault(req: Request, res: Response) {
    const lang = await languagesRepository.find(req.params.id);
    if (!lang) throw notFound("Language");
    await languagesRepository.setDefault(lang.id);
    systemConfig.invalidate();
    res.json({ success: true });
  },
  async remove(req: Request, res: Response) {
    const lang = await languagesRepository.find(req.params.id);
    if (!lang) throw notFound("Language");
    if (lang.isDefault) throw badRequest("Choose another default language before deleting this one");
    await languagesRepository.delete(lang.id);
    systemConfig.invalidate();
    res.json({ success: true });
  },
};

// ---------------------------------------------------------------------------
// Access levels
// ---------------------------------------------------------------------------

export const levels = {
  async list(_req: Request, res: Response) {
    const [rows, counts] = await Promise.all([levelsRepository.list(), levelsRepository.userCounts()]);
    res.json({ data: rows.map((l) => ({ ...l, userCount: counts[l.levelNumber] ?? 0 })) });
  },
  async create(req: Request, res: Response) {
    const input = parseBody(accessLevelSchema, req);
    const level = await levelsRepository.create(input).catch(dup("A level with this number"));
    await activityRepository.record(req, req.user!.id, "level_created", { type: "access_level", id: level.id });
    res.status(201).json({ data: level });
  },
  async update(req: Request, res: Response) {
    const level = await levelsRepository.find(req.params.id);
    if (!level) throw notFound("Level");
    const input = parseBody(accessLevelSchema, req);
    const updated = await levelsRepository.update(level.id, input).catch(dup("A level with this number"));
    if (input.levelNumber !== level.levelNumber) await levelsRepository.reassign(level.levelNumber, input.levelNumber);
    await activityRepository.record(req, req.user!.id, "level_updated", { type: "access_level", id: level.id });
    res.json({ data: updated });
  },
  async remove(req: Request, res: Response) {
    const level = await levelsRepository.find(req.params.id);
    if (!level) throw notFound("Level");
    const users = (await levelsRepository.userCounts())[level.levelNumber] ?? 0;
    if (users > 0) throw conflict(`${users} user(s) are on this level. Move them to another level first.`, "LEVEL_IN_USE");
    await levelsRepository.delete(level.id);
    res.json({ success: true });
  },
  /** PUT /api/admin/users/:id/level — assign (or clear with null). */
  async assign(req: Request, res: Response) {
    const user = await usersRepository.findById(req.params.id);
    if (!user) throw notFound("User");
    if (user.role !== "admin") throw badRequest("Levels apply to tenant admins (their team shares the tenant's level)");
    const { level } = parseBody(assignLevelSchema, req);
    if (level !== null && !(await levelsRepository.findByNumber(level))) throw notFound("Level");
    const updated = await usersRepository.update(user.id, { accessLevel: level });
    await activityRepository.record(req, req.user!.id, "level_assigned", { type: "user", id: user.id }, { level });
    res.json({ data: toPublicUser(updated!) });
  },
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationsCtl = {
  async send(req: Request, res: Response) {
    const input = parseBody(sendNotificationSchema, req);
    const result = await sendNotification(input, req.user!.username);
    await activityRepository.record(req, req.user!.id, "notification_sent", { type: "notification", id: String(result.notification?.id) }, { recipients: result.recipients });
    res.status(201).json(result);
  },
  async listAdmin(req: Request, res: Response) {
    const q = parseQuery(paginationQuery, req);
    const { rows, total } = await notificationsRepository.list(q.page, q.limit);
    res.json(paginated(rows, total, q.page, q.limit));
  },
  async remove(req: Request, res: Response) {
    await notificationsRepository.delete(Number(req.params.id));
    res.json({ success: true });
  },
  async mine(req: Request, res: Response) {
    const q = parseQuery(paginationQuery, req);
    const { rows, total } = await notificationsRepository.listForUser(req.user!.id, q.page, q.limit);
    res.json(paginated(rows, total, q.page, q.limit));
  },
  async unread(req: Request, res: Response) {
    res.json({ count: req.user ? await notificationsRepository.unreadCount(req.user.id) : 0 });
  },
  async read(req: Request, res: Response) {
    if (!(await notificationsRepository.markRead(req.user!.id, Number(req.params.id)))) throw notFound("Notification");
    res.json({ success: true });
  },
  async readAll(req: Request, res: Response) {
    await notificationsRepository.markAllRead(req.user!.id);
    res.json({ success: true });
  },
};
