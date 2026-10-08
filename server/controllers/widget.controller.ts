import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { originAllowed, startChatSchema, visitorMessageSchema, widgetSchema } from "@shared/widget";
import type { ChatWidget } from "@shared/schema";
import { parse, parseBody } from "../lib/http";
import { publicBaseUrl } from "../lib/tokens";
import { AppError, conflict, notFound } from "../lib/errors";
import { assertChannelAccess, requireTenantId } from "../middlewares/tenant";
import { activityRepository } from "../repositories/activity.repository";
import { conversationForToken, publicConfig, startVisitorChat, visitorMessages, visitorSend, widgetSettings, widgetsRepository } from "../services/widget.service";

const MAX_WIDGETS = 10;

// --- Public (visitor) API: /api/widget/:id/… -------------------------------------------------

const cache = new Map<string, { w: ChatWidget | null; at: number }>();
async function cachedWidget(id: string): Promise<ChatWidget | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.w;
  const w = (await widgetsRepository.find(id)) ?? null;
  cache.set(id, { w, at: Date.now() });
  if (cache.size > 5000) cache.clear();
  return w;
}
export const forgetWidget = (id: string) => cache.delete(id);

/**
 * Loads the widget and applies CORS: only the widget's allowed websites may call it
 * (any site when the list is empty). No cookies are involved, so credentials stay off.
 */
export async function widgetCors(req: Request, res: Response, next: NextFunction) {
  try {
    const w = await cachedWidget(req.params.id);
    const origin = req.get("origin") ?? null;
    res.setHeader("Vary", "Origin");
    if (!w || !w.enabled) {
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return res.status(404).json({ success: false, message: "This chat widget isn't available.", code: "WIDGET_NOT_FOUND" });
    }
    // The platform itself (the editor's preview) is always allowed.
    const own = origin === new URL(publicBaseUrl()).origin || origin === `${req.protocol}://${req.get("host")}`;
    if (origin && !own && !originAllowed(origin, w.allowedOrigins ?? [])) {
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return res.status(403).json({ success: false, message: "This website isn't allowed to use the chat widget.", code: "ORIGIN_NOT_ALLOWED" });
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Widget-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    res.locals.widget = w;
    next();
  } catch (err) {
    next(err);
  }
}

const widgetOf = (res: Response) => res.locals.widget as ChatWidget;

function assertLiveChat(w: ChatWidget) {
  if (!widgetSettings(w).liveChat.enabled) throw new AppError(403, "Live chat is turned off for this widget.", "LIVE_CHAT_OFF");
}

export async function config(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ data: await publicConfig(widgetOf(res)) });
}

export async function startChat(req: Request, res: Response) {
  const w = widgetOf(res);
  assertLiveChat(w);
  const input = parseBody(startChatSchema, req);
  const s = widgetSettings(w).liveChat;
  if (s.requireDetails) {
    if (s.askName && !input.name?.trim()) throw new AppError(400, "Please enter your name.", "DETAILS_REQUIRED", { name: ["Required"] });
    if (s.askEmail && !input.email?.trim()) throw new AppError(400, "Please enter your email.", "DETAILS_REQUIRED", { email: ["Required"] });
    if (s.askPhone && !input.phone?.trim()) throw new AppError(400, "Please enter your phone number.", "DETAILS_REQUIRED", { phone: ["Required"] });
  }
  const result = await startVisitorChat(w, { name: s.askName ? input.name : undefined, email: s.askEmail ? input.email || undefined : undefined, phone: s.askPhone ? input.phone || undefined : undefined, message: input.message, page: input.page }, req.get("origin") ?? null);
  res.status(201).json({ data: { token: result.token, messages: result.messages } });
}

async function visitorConversation(req: Request, res: Response) {
  const w = widgetOf(res);
  assertLiveChat(w);
  const c = await conversationForToken(w, req.get("x-widget-token"));
  if (!c) throw new AppError(401, "This chat has ended. Start a new one.", "CHAT_NOT_FOUND");
  return { w, c };
}

export async function listMessages(req: Request, res: Response) {
  const { c } = await visitorConversation(req, res);
  const { after } = parse(z.object({ after: z.string().uuid().optional() }), req.query);
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: await visitorMessages(c, after), status: c.status });
}

export async function sendMessage(req: Request, res: Response) {
  const { w, c } = await visitorConversation(req, res);
  const { text } = parseBody(visitorMessageSchema, req);
  res.status(201).json({ data: await visitorSend(w, c, text) });
}

// --- Tenant management: /api/widgets ----------------------------------------------------------

async function own(req: Request): Promise<ChatWidget> {
  const w = await widgetsRepository.find(req.params.id);
  if (!w || w.userId !== requireTenantId(req.user)) throw notFound("Widget");
  return w;
}

export async function list(req: Request, res: Response) {
  res.json({ data: await widgetsRepository.list(requireTenantId(req.user)) });
}

export async function create(req: Request, res: Response) {
  const tenantId = requireTenantId(req.user);
  const input = parseBody(widgetSchema, req);
  await assertChannelAccess(req.user!, input.channelId);
  if ((await widgetsRepository.list(tenantId)).length >= MAX_WIDGETS) throw conflict(`You can have up to ${MAX_WIDGETS} widgets.`, "LIMIT_REACHED");
  const w = await widgetsRepository.create({ userId: tenantId, channelId: input.channelId, name: input.name, enabled: input.enabled, settings: input.settings as Record<string, unknown>, allowedOrigins: [...new Set(input.allowedOrigins)], createdBy: req.user!.id });
  await activityRepository.record(req, req.user!.id, "widget_created", { type: "widget", id: w.id });
  res.status(201).json({ data: w });
}

export async function update(req: Request, res: Response) {
  const w = await own(req);
  const input = parseBody(widgetSchema, req);
  await assertChannelAccess(req.user!, input.channelId);
  const updated = await widgetsRepository.update(w.id, { channelId: input.channelId, name: input.name, enabled: input.enabled, settings: input.settings as Record<string, unknown>, allowedOrigins: [...new Set(input.allowedOrigins)] });
  forgetWidget(w.id);
  res.json({ data: updated });
}

export async function remove(req: Request, res: Response) {
  const w = await own(req);
  await widgetsRepository.delete(w.id);
  forgetWidget(w.id);
  await activityRepository.record(req, req.user!.id, "widget_deleted", { type: "widget", id: w.id });
  res.json({ success: true });
}
