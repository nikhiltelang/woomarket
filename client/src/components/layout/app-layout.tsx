import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  BarChart3,
  Building2,
  ChevronsUpDown,
  CreditCard,
  FileText,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageSquareText,
  SlidersHorizontal,
  Megaphone,
  Menu,
  MessageSquare,
  RefreshCw,
  Settings,
  Shield,
  UserCircle,
  Users,
  UsersRound,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { useSocket, useSocketEvent } from "@/contexts/socket";
import { cn, displayName } from "@/lib/utils";
import { Avatar } from "@/components/ui/display";
import { useToast } from "@/components/ui/overlay";
import { queryClient } from "@/lib/api";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  permission?: string;
  badge?: number;
}

function useNav(): { title: string; items: NavItem[] }[] {
  const { user } = useAuth();
  const { data: unread } = useQuery<{ count: number }>({
    queryKey: ["/api/conversations/unread-count"],
    enabled: user?.role !== "superadmin",
    refetchInterval: 60_000,
  });
  if (user?.role === "superadmin") {
    return [
      {
        title: "Platform",
        items: [
          { href: "/admin", label: "Overview", icon: <LayoutDashboard className="h-4 w-4" /> },
          { href: "/users", label: "Users", icon: <Users className="h-4 w-4" /> },
          { href: "/channels-management", label: "Channels", icon: <Building2 className="h-4 w-4" /> },
          { href: "/master-subscriptions", label: "Plans", icon: <CreditCard className="h-4 w-4" /> },
        ],
      },
      {
        title: "System",
        items: [
          { href: "/system-settings", label: "System settings", icon: <SlidersHorizontal className="h-4 w-4" /> },
          { href: "/app-update", label: "Application Update", icon: <RefreshCw className="h-4 w-4" /> },
        ],
      },
    ];
  }
  return [
    {
      title: "Workspace",
      items: [
        { href: "/dashboard", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
        { href: "/inbox", label: "Inbox", icon: <MessageSquare className="h-4 w-4" />, permission: "inbox:view", badge: unread?.count },
        { href: "/contacts", label: "Contacts", icon: <Users className="h-4 w-4" />, permission: "contacts:view" },
        { href: "/groups", label: "Groups", icon: <UsersRound className="h-4 w-4" />, permission: "contacts:view" },
        { href: "/templates", label: "Templates", icon: <FileText className="h-4 w-4" />, permission: "templates:view" },
        { href: "/campaigns", label: "Campaigns", icon: <Megaphone className="h-4 w-4" />, permission: "campaigns:view" },
      ],
    },
    {
      title: "Marketing",
      items: [
        { href: "/email-marketing", label: "Email marketing", icon: <Mail className="h-4 w-4" />, permission: "email:view" },
        { href: "/sms-marketing", label: "SMS marketing", icon: <MessageSquareText className="h-4 w-4" />, permission: "sms:view" },
      ],
    },
    {
      title: "Account",
      items: [
        { href: "/team", label: "Team", icon: <Shield className="h-4 w-4" />, permission: "team:view" },
        { href: "/settings", label: "WhatsApp numbers", icon: <Settings className="h-4 w-4" />, permission: "settings:view" },
        { href: "/plans", label: "Plan & usage", icon: <BarChart3 className="h-4 w-4" /> },
      ],
    },
  ];
}

function ChannelSwitcher() {
  const { channels, activeChannel, setActiveChannelId } = useChannel();
  if (!channels.length) return null;
  return (
    <label className="relative flex min-w-0 items-center">
      <span className="sr-only">Active WhatsApp number</span>
      <select
        value={activeChannel?.id ?? ""}
        onChange={(e) => setActiveChannelId(e.target.value)}
        className="h-9 max-w-[16rem] min-w-0 appearance-none truncate rounded-md border border-border bg-surface py-0 pr-8 pl-3 text-sm font-medium"
      >
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.phoneNumber ? ` · ${c.phoneNumber}` : ""}
          </option>
        ))}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute right-2 h-4 w-4 text-fg-muted" />
    </label>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout, can } = useAuth();
  const { connected } = useSocket();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const toast = useToast();
  const groups = useNav();

  useSocketEvent("conversation_updated", () => void queryClient.invalidateQueries({ queryKey: ["/api/conversations/unread-count"] }));

  if (!user) return null;
  const isActive = (href: string) => location === href || location.startsWith(`${href}/`);

  const sidebar = (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-5" aria-label="Main">
      <Link href={user.role === "superadmin" ? "/admin" : "/dashboard"} className="flex items-center gap-2 px-2">
        <img src="/favicon.svg" alt="" className="h-7 w-7" />
        <span className="text-base font-semibold tracking-tight">WooMarket360</span>
      </Link>
      {groups.map((g) => {
        const items = g.items.filter((i) => !i.permission || can(i.permission));
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <p className="mb-1 px-2 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">{g.title}</p>
            <ul className="flex flex-col gap-0.5">
              {items.map((i) => (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors",
                      isActive(i.href) ? "bg-primary-soft font-medium text-primary" : "text-fg-muted hover:bg-subtle hover:text-fg",
                    )}
                    aria-current={isActive(i.href) ? "page" : undefined}
                  >
                    {i.icon}
                    <span className="flex-1">{i.label}</span>
                    {!!i.badge && (
                      <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-fg tabular-nums">{i.badge > 99 ? "99+" : i.badge}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <div className="mt-auto border-t border-border pt-4">
        <Link href="/account" className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-subtle" onClick={() => setOpen(false)}>
          <Avatar name={displayName(user)} className="h-8 w-8" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{displayName(user)}</span>
            <span className="block truncate text-xs text-fg-muted capitalize">{user.role}</span>
          </span>
          <UserCircle className="h-4 w-4 text-fg-muted" />
        </Link>
        <button
          onClick={async () => {
            setSigningOut(true);
            try {
              await logout();
            } catch (err) {
              setSigningOut(false);
              toast({ title: "Couldn't sign out", description: (err as Error).message, variant: "error" });
            }
          }}
          disabled={signingOut}
          className="mt-1 flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm text-fg-muted hover:bg-subtle hover:text-fg disabled:opacity-60"
        >
          <LogOut className="h-4 w-4" /> {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface">
            <button className="absolute top-4 right-3 p-1 text-fg-muted" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 lg:px-6">
          <button className="p-1 text-fg-muted lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          {user.role !== "superadmin" && <ChannelSwitcher />}
          <div className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
            <span className={cn("h-2 w-2 rounded-full", connected ? "bg-success" : "bg-fg-muted/50")} aria-hidden />
            <span className="hidden sm:inline">{connected ? "Live" : "Offline"}</span>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

export function PageContainer({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn("mx-auto w-full px-4 py-6 lg:px-8", wide ? "max-w-[1600px]" : "max-w-6xl")}>{children}</div>;
}
