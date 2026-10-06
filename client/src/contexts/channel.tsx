import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PublicChannel } from "@shared/api-types";
import { useAuth } from "./auth";

interface ChannelValue {
  channels: PublicChannel[];
  activeChannel: PublicChannel | null;
  setActiveChannelId: (id: string) => void;
  isLoading: boolean;
}

const ChannelCtx = createContext<ChannelValue | null>(null);
const STORAGE_KEY = "wm360.activeChannel";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function ChannelProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isTenant = user?.role === "admin" || user?.role === "team";
  const { data, isLoading } = useQuery<{ data: PublicChannel[] }>({ queryKey: ["/api/channels"], enabled: isTenant });
  const [selected, setSelected] = useState<string | null>(readStored);

  const channels = useMemo(() => data?.data ?? [], [data]);
  const activeChannel = useMemo(
    () => channels.find((c) => c.id === selected) ?? channels.find((c) => c.isActive) ?? channels[0] ?? null,
    [channels, selected],
  );

  useEffect(() => {
    if (activeChannel && activeChannel.id !== selected) setSelected(activeChannel.id);
  }, [activeChannel, selected]);

  const setActiveChannelId = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {}
  };

  return (
    <ChannelCtx.Provider value={{ channels, activeChannel, setActiveChannelId, isLoading: isTenant && isLoading }}>
      {children}
    </ChannelCtx.Provider>
  );
}

export function useChannel() {
  const ctx = useContext(ChannelCtx);
  if (!ctx) throw new Error("useChannel must be used inside ChannelProvider");
  return ctx;
}
