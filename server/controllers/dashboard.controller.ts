import type { Request, Response } from "express";
import os from "node:os";
import { z } from "zod";
import { parseQuery } from "../lib/http";
import { parseUserAgent, statsRepository } from "../repositories/stats.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import { campaignsRepository } from "../repositories/campaigns.repository";
import { templatesRepository } from "../repositories/templates.repository";
import { usersRepository } from "../repositories/users.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { pool } from "../db";
import { realtime } from "../services/realtime";
import { runStore } from "../app-update/run-store";
import { getRoot, readVersion } from "../app-update/controller";

/** Tenant dashboard for one channel. */
export async function channelStats(req: Request, res: Response) {
  const channel = req.channel!;
  const since = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  since.setUTCHours(0, 0, 0, 0);
  const [contacts, open, unread, templates, recentCampaigns, series] = await Promise.all([
    contactsRepository.countByChannel(channel.id),
    conversationsRepository.countOpen(channel.id),
    conversationsRepository.unreadCountForChannels([channel.id]),
    templatesRepository.listByChannel(channel.id),
    campaignsRepository.list(channel.id, { page: 1, limit: 5 }),
    messagesRepository.statsSince(channel.id, since),
  ]);

  const days: { day: string; inbound: number; outbound: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    days.push({
      day: d,
      inbound: series.filter((s) => s.day === d && s.direction === "inbound").reduce((a, s) => a + s.count, 0),
      outbound: series.filter((s) => s.day === d && s.direction !== "inbound").reduce((a, s) => a + s.count, 0),
    });
  }

  res.json({
    data: {
      contacts,
      openConversations: open,
      unreadMessages: unread,
      templates: {
        total: templates.length,
        approved: templates.filter((t) => t.status === "approved").length,
        pending: templates.filter((t) => t.status === "pending").length,
      },
      messages: {
        sent7d: days.reduce((a, d) => a + d.outbound, 0),
        received7d: days.reduce((a, d) => a + d.inbound, 0),
        daily: days,
      },
      recentCampaigns: recentCampaigns.rows,
    },
  });
}

/** Superadmin platform overview: the stat cards. */
export async function platformOverview(_req: Request, res: Response) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [usersByRole, segments, channels, messages24h, activeCampaigns, lastUpdate, totals] = await Promise.all([
    usersRepository.countByRole(),
    usersRepository.segmentCounts(),
    channelsRepository.countAll(),
    messagesRepository.countSince(since),
    campaignsRepository.countActive(),
    runStore().latest(),
    statsRepository.totals(),
  ]);
  res.json({
    data: {
      version: readVersion(getRoot()),
      users: usersByRole,
      totalUsers: segments.all,
      segments,
      channels,
      messages24h,
      activeCampaigns,
      onlineAgents: realtime.onlineUserIds().length,
      ...totals,
      lastUpdate: lastUpdate ? { status: lastUpdate.status, toVersion: lastUpdate.toVersion, startedAt: lastUpdate.startedAt } : null,
    },
  });
}

const reportQuery = z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((v) => v.to >= v.from, "`to` must be after `from`");

/** Daily WhatsApp messages (in/out) and sign-ups for a date range (max 92 days, UTC days). */
export async function platformReport(req: Request, res: Response) {
  const q = parseQuery(reportQuery, req);
  const from = new Date(Date.UTC(q.from.getUTCFullYear(), q.from.getUTCMonth(), q.from.getUTCDate()));
  const days = Math.min(92, Math.floor((q.to.getTime() - from.getTime()) / 86_400_000) + 1);
  const to = new Date(from.getTime() + days * 86_400_000);
  const [msgs, signups] = await Promise.all([statsRepository.messagesByDay(from, to), usersRepository.signupsByDay(from, to)]);
  const series = Array.from({ length: days }, (_, i) => {
    const day = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    return {
      day,
      inbound: msgs.filter((m) => m.day === day && m.direction === "inbound").reduce((a, m) => a + m.count, 0),
      outbound: msgs.filter((m) => m.day === day && m.direction !== "inbound").reduce((a, m) => a + m.count, 0),
      signups: signups.find((x) => x.day === day)?.count ?? 0,
    };
  });
  res.json({ data: series });
}

/** Sign-ins in the last N days grouped by browser and operating system. */
export async function loginStats(req: Request, res: Response) {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const agents = await statsRepository.loginAgents(new Date(Date.now() - days * 86_400_000));
  const tally = (key: "browser" | "os") => {
    const m = new Map<string, number>();
    for (const ua of agents) {
      const k = parseUserAgent(ua)[key];
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };
  res.json({ data: { days, total: agents.length, browsers: tally("browser"), os: tally("os") } });
}

export async function serverInfo(_req: Request, res: Response) {
  const t0 = performance.now();
  let dbOk = true;
  try {
    await pool.query("SELECT 1");
  } catch {
    dbOk = false;
  }
  const mem = process.memoryUsage();
  res.json({
    data: {
      node: process.version,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
      loadAverage: os.loadavg(),
      cpus: os.cpus().length,
      database: { ok: dbOk, latencyMs: Math.round(performance.now() - t0) },
      pid: process.pid,
      instance: process.env.NODE_APP_INSTANCE ?? "0",
    },
  });
}

export function onlineAgents(_req: Request, res: Response) {
  res.json({ data: realtime.onlineUserIds() });
}
