import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import { useAuth } from "./auth";
import { useChannel } from "./channel";
import { useToast } from "@/components/ui/overlay";
import { queryClient } from "@/lib/api";

interface SocketValue {
  socket: Socket | null;
  connected: boolean;
}

const SocketCtx = createContext<SocketValue>({ socket: null, connected: false });

export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { activeChannel } = useChannel();
  const toast = useToast();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!user) return;
    const s = io({ transports: ["polling", "websocket"], withCredentials: true });
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    s.on("notification:new", (n: { title: string; body?: string }) => toast({ title: n.title, description: n.body, variant: "info" }));
    s.on("template_updated", () => void queryClient.invalidateQueries({ queryKey: ["/api/templates"] }));
    s.on("campaign_updated", () => void queryClient.invalidateQueries({ queryKey: ["/api/campaigns"] }));
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (socket && connected && activeChannel) socket.emit("join_channel", { channelId: activeChannel.id });
  }, [socket, connected, activeChannel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return <SocketCtx.Provider value={{ socket, connected }}>{children}</SocketCtx.Provider>;
}

export function useSocket() {
  return useContext(SocketCtx);
}

/** Subscribes to a server event for the lifetime of the component. */
export function useSocketEvent<T = any>(event: string, handler: (payload: T) => void) {
  const { socket } = useSocket();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!socket) return;
    const fn = (p: T) => ref.current(p);
    socket.on(event, fn);
    return () => {
      socket.off(event, fn);
    };
  }, [socket, event]);
}
