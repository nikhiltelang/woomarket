import type { Request, Response } from "express";
import os from "node:os";
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

/** Superadmin platform overview. */
export async function platformOverview(_req: Request, res: Response) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [usersByRole, channels, messages24h, activeCampaigns, lastUpdate] = await Promise.all([
    usersRepository.countByRole(),
    channelsRepository.countAll(),
    messagesRepository.countSince(since),
    campaignsRepository.countActive(),
    runStore().latest(),
  ]);
  res.json({
    data: {
      version: readVersion(getRoot()),
      users: usersByRole,
      totalUsers: Object.values(usersByRole).reduce((a, n) => a + n, 0),
      channels,
      messages24h,
      activeCampaigns,
      onlineAgents: realtime.onlineUserIds().length,
      lastUpdate: lastUpdate ? { status: lastUpdate.status, toVersion: lastUpdate.toVersion, startedAt: lastUpdate.startedAt } : null,
    },
  });
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
