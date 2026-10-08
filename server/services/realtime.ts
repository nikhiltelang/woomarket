import type { Server as HttpServer } from "node:http";
import { Adapter as MemoryAdapter } from "socket.io-adapter";
import type { Request, RequestHandler } from "express";
import { Server, type Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { jwtSecret } from "../config";
import { usersRepository, toAuthUser } from "../repositories/users.repository";
import { conversationsRepository } from "../repositories/conversations.repository";
import { assertChannelAccess } from "../middlewares/tenant";
import { childLogger } from "../lib/logger";
import type { AuthUser } from "../types";

const log = childLogger("realtime");
let io: Server | null = null;

type Ack = (res: { ok: boolean; error?: string }) => void;

/** Emits are no-ops until the hub is attached (e.g. in tests and CLI scripts). */
export const realtime = {
  toChannel(channelId: string | null | undefined, event: string, payload: unknown) {
    if (io && channelId) io.to(`channel:${channelId}`).emit(event, payload);
  },
  toConversation(conversationId: string, event: string, payload: unknown) {
    if (io) io.to(`conversation:${conversationId}`).emit(event, payload);
  },
  toUser(userId: string, event: string, payload: unknown) {
    if (io) io.to(`user:${userId}`).emit(event, payload);
  },
  /** Drops live connections of a user (e.g. after a ban). */
  disconnectUser(userId: string) {
    if (io) io.in(`user:${userId}`).disconnectSockets(true);
  },
  onlineUserIds(): string[] {
    if (!io) return [];
    const ids = new Set<string>();
    for (const s of io.sockets.sockets.values()) if (s.data.user) ids.add((s.data.user as AuthUser).id);
    return [...ids];
  },
};

async function resolveUser(socket: Socket): Promise<AuthUser | null> {
  const req = socket.request as Request;
  let userId = req.session?.userId ?? null;
  const token = socket.handshake.auth?.token as string | undefined;
  if (!userId && token) {
    try {
      userId = (jwt.verify(token, jwtSecret(), { audience: "woomarket360" }) as { sub?: string }).sub ?? null;
    } catch {
      userId = null;
    }
  }
  if (!userId) return null;
  const user = await usersRepository.findById(userId);
  return user && user.status === "active" ? toAuthUser(user) : null;
}

export function attachRealtime(server: HttpServer, sessionMiddleware: RequestHandler): Server {
  io = new Server(server, { transports: ["polling", "websocket"], serveClient: false });
  io.engine.use(sessionMiddleware);

  io.use(async (socket, next) => {
    try {
      const user = await resolveUser(socket);
      if (!user) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthUser;
    socket.join(`user:${user.id}`);
    log.debug({ userId: user.id }, "socket connected");

    const guard = (fn: (...args: any[]) => Promise<void>) => async (payload: any, ack?: Ack) => {
      try {
        await fn(payload);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    };

    socket.on(
      "join_channel",
      guard(async ({ channelId }: { channelId: string }) => {
        await assertChannelAccess(user, channelId);
        for (const room of socket.rooms) if (room.startsWith("channel:")) socket.leave(room);
        socket.join(`channel:${channelId}`);
        socket.emit("joined_channel", { channelId });
      }),
    );

    const conversationGuard = async (conversationId: string) => {
      const conv = await conversationsRepository.findById(conversationId);
      if (!conv) throw new Error("Conversation not found");
      await assertChannelAccess(user, conv.channelId);
      return conv;
    };

    socket.on(
      "join_conversation",
      guard(async ({ conversationId }: { conversationId: string }) => {
        await conversationGuard(conversationId);
        socket.join(`conversation:${conversationId}`);
      }),
    );
    socket.on("leave_conversation", ({ conversationId }: { conversationId: string }) => {
      socket.leave(`conversation:${conversationId}`);
    });
    socket.on(
      "conversation_opened",
      guard(async ({ conversationId }: { conversationId: string }) => {
        const conv = await conversationGuard(conversationId);
        await conversationsRepository.markRead(conversationId);
        realtime.toChannel(conv.channelId, "messages_read", { conversationId });
      }),
    );
    for (const evt of ["user_typing", "user_stopped_typing"] as const) {
      socket.on(evt, ({ conversationId }: { conversationId: string }) => {
        if (!socket.rooms.has(`conversation:${conversationId}`)) return;
        socket.to(`conversation:${conversationId}`).emit(evt, { conversationId, userId: user.id, username: user.username });
      });
    }
    socket.on("test_event", (payload: unknown, ack?: (v: unknown) => void) => {
      const response = { received: payload, at: new Date().toISOString() };
      socket.emit("test_response", response);
      ack?.(response);
    });
  });

  return io;
}

export async function closeRealtime(): Promise<void> {
  if (!io) return;
  await new Promise<void>((resolve) => io!.close(() => resolve()));
  io = null;
}

/**
 * Switches Socket.IO between in-memory and Redis broadcasting (Redis mode, several servers).
 * Connected clients are asked to reconnect so their rooms exist in the new adapter.
 */
export function setRealtimeAdapter(adapter: Parameters<Server["adapter"]>[0] | null): void {
  if (!io) return;
  io.adapter(adapter ?? MemoryAdapter);
  io.disconnectSockets();
}
