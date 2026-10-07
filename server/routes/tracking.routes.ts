import { Router, type Request, type Response } from "express";
import { asyncHandler as h } from "../lib/http";
import { publicBaseUrl } from "../lib/tokens";
import { decodeClickToken, findLink, recordClick, resolveShortCode } from "../services/tracking.service";

/** Public click-tracking redirects: /l/<signed token> (email) and /s/<short code> (SMS). */
export const trackingRoutes = Router();

const notFound = (res: Response) =>
  res
    .status(404)
    .type("html")
    .send(`<!doctype html><meta charset="utf-8"><title>Link not found</title><p style="font:16px system-ui;margin:3rem auto;max-width:28rem;text-align:center">This link isn't valid anymore. <a href="${publicBaseUrl()}">Go to the homepage</a>.</p>`);

const meta = (req: Request) => ({ method: req.method, ip: req.ip, userAgent: req.get("user-agent") });
const go = (res: Response, url: string) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
  res.redirect(302, url);
};

trackingRoutes.get(
  "/l/:token",
  h(async (req, res) => {
    const t = decodeClickToken(req.params.token);
    const link = t ? await findLink(t.linkId) : undefined;
    if (!t || !link) return notFound(res);
    go(res, await recordClick(link, t.recipientId, meta(req)));
  }),
);

trackingRoutes.get(
  "/s/:code([A-Za-z0-9]{4,12})",
  h(async (req, res) => {
    const s = await resolveShortCode(req.params.code);
    if (!s) return notFound(res);
    go(res, await recordClick(s.link, s.recipientId, meta(req)));
  }),
);
