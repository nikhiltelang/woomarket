import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  BarChart3,
  Bell,
  Building2,
  ChevronDown,
  Clock,
  ChevronsUpDown,
  Filter,
  CreditCard,
  Bug,
  KeyRound,
  LayoutGrid,
  PanelsTopLeft,
  Palette,
  ScrollText,
  TicketPercent,
  Gauge,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageCircle,
  Menu,
  MessageSquareText,
  Shield,
  SlidersHorizontal,
  UserCircle,
  Users,
  UsersRound,
  Webhook,
  X,
} from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Paginated } from "@shared/api-types";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { usePlatform } from "@/contexts/platform";
import { useSocket, useSocketEvent } from "@/contexts/socket";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, displayName, relativeTime } from "@/lib/utils";
import { Avatar } from "@/components/ui/display";
import { useToast } from "@/components/ui/overlay";
import { LanguageSwitcher } from "@/components/public";

interface NavLeaf {
  href: string;
  label: string;
  icon?: ReactNode;
  permission?: string;
  badge?: number;
  badgeTone?: "primary" | "warning" | "danger";
}
interface NavItem extends NavLeaf {
  children?: NavLeaf[];
}

type Counts = Record<"all" | "active" | "banned" | "email-unverified" | "mobile-unverified" | "with-subscription", number>;

function useNav(): { title: string; items: NavItem[] }[] {
  const { user } = useAuth();
  const { t } = usePlatform();
  const isSuper = user?.role === "superadmin";
  const { data: unread } = useQuery<{ count: number }>({ queryKey: ["/api/conversations/unread-count"], enabled: !isSuper, refetchInterval: 60_000 });
  const { data: counts } = useQuery<{ data: Counts }>({ queryKey: ["/api/admin/users/counts"], enabled: isSuper, refetchInterval: 60_000 });
  const c = counts?.data;
  const { data: wl } = useQuery<{ data: { allowed: boolean } }>({ queryKey: ["/api/white-label"], enabled: user?.role === "admin", staleTime: 5 * 60_000 });
  const { data: support } = useQuery<{ data: Record<string, number> }>({ queryKey: ["/api/superadmin/support-requests/counts"], enabled: isSuper, refetchInterval: 60_000 });
  // A new report reaches the superadmin as a notification; refresh the open count with it.
  useSocketEvent("notification:new", () => {
    if (isSuper) void queryClient.invalidateQueries({ queryKey: ["/api/superadmin/support-requests/counts"] });
  });

  if (isSuper) {
    return [
      {
        title: t("nav.platform"),
        items: [
          { href: "/admin", label: t("nav.dashboard"), icon: <LayoutDashboard className="h-4 w-4" /> },
          {
            href: "/users",
            label: t("nav.manageUsers"),
            icon: <Users className="h-4 w-4" />,
            children: [
              { href: "/users/active", label: t("nav.activeUsers"), badge: c?.active },
              { href: "/users/banned", label: t("nav.bannedUsers"), badge: c?.banned, badgeTone: "danger" },
              { href: "/users/email-unverified", label: t("nav.emailUnverified"), badge: c?.["email-unverified"], badgeTone: "warning" },
              { href: "/users/mobile-unverified", label: t("nav.mobileUnverified"), badge: c?.["mobile-unverified"], badgeTone: "warning" },
              { href: "/users/with-subscription", label: t("nav.withSubscription"), badge: c?.["with-subscription"] },
              { href: "/users/all", label: t("nav.allUsers"), badge: c?.all },
              { href: "/users/send-notification", label: t("nav.sendNotification") },
            ],
          },
          { href: "/manage-levels", label: t("nav.manageLevels"), icon: <Gauge className="h-4 w-4" /> },
          { href: "/channels-management", label: t("nav.channels"), icon: <Building2 className="h-4 w-4" /> },
          { href: "/master-subscriptions", label: t("nav.plans"), icon: <CreditCard className="h-4 w-4" /> },
          { href: "/manage-coupons", label: t("nav.coupons"), icon: <TicketPercent className="h-4 w-4" /> },
          { href: "/report-request", label: t("nav.reportRequest"), icon: <Bug className="h-4 w-4" />, badge: support?.data.open, badgeTone: "warning" },
        ],
      },
      {
        title: t("nav.system"),
        items: [
          { href: "/system-settings", label: t("nav.systemSettings"), icon: <SlidersHorizontal className="h-4 w-4" /> },
          { href: "/landing-page", label: t("nav.landingPage"), icon: <PanelsTopLeft className="h-4 w-4" /> },
          { href: "/white-label-admin", label: t("nav.whiteLabel"), icon: <Palette className="h-4 w-4" /> },
          { href: "/logs", label: t("nav.logs"), icon: <ScrollText className="h-4 w-4" /> },
          {
            href: "/extra",
            label: t("nav.extra"),
            icon: <LayoutGrid className="h-4 w-4" />,
            children: [
              { href: "/extra/application", label: t("nav.application") },
              { href: "/extra/server", label: t("nav.server") },
              { href: "/extra/cache", label: t("nav.cache") },
              { href: "/extra/update", label: t("nav.appUpdate") },
            ],
          },
        ],
      },
    ];
  }
  // WhatsApp, email and SMS are peers: same position, same shape (campaigns, content, settings).
  return [
    {
      title: t("nav.overview"),
      items: [
        { href: "/dashboard", label: t("nav.dashboard"), icon: <LayoutDashboard className="h-4 w-4" /> },
        { href: "/reports", label: t("nav.reports"), icon: <BarChart3 className="h-4 w-4" />, permission: "analytics:view" },
      ],
    },
    {
      title: t("nav.audience"),
      items: [
        { href: "/contacts", label: t("nav.contacts"), icon: <Users className="h-4 w-4" />, permission: "contacts:view" },
        { href: "/groups", label: t("nav.groups"), icon: <UsersRound className="h-4 w-4" />, permission: "contacts:view" },
        { href: "/segments", label: t("nav.segments"), icon: <Filter className="h-4 w-4" />, permission: "contacts:view" },
      ],
    },
    {
      title: t("nav.marketing"),
      items: [
        {
          href: "/whatsapp",
          label: t("nav.whatsappMarketing"),
          icon: <MessageCircle className="h-4 w-4" />,
          badge: unread?.count,
          children: [
            { href: "/campaigns", label: t("nav.campaigns"), permission: "campaigns:view" },
            { href: "/templates", label: t("nav.templates"), permission: "templates:view" },
            { href: "/inbox", label: t("nav.inbox"), permission: "inbox:view", badge: unread?.count },
            { href: "/widget", label: t("nav.widget"), permission: "settings:view" },
            { href: "/settings", label: t("nav.channelSettings"), permission: "settings:view" },
          ],
        },
        {
          href: "/email-marketing",
          label: t("nav.emailMarketing"),
          icon: <Mail className="h-4 w-4" />,
          children: [
            { href: "/email-marketing/campaigns", label: t("nav.campaigns"), permission: "email:view" },
            { href: "/email-marketing/templates", label: t("nav.templates"), permission: "email:view" },
            { href: "/email-marketing/settings", label: t("nav.channelSettings"), permission: "email:view" },
          ],
        },
        {
          href: "/sms-marketing",
          label: t("nav.smsMarketing"),
          icon: <MessageSquareText className="h-4 w-4" />,
          children: [
            { href: "/sms-marketing/campaigns", label: t("nav.campaigns"), permission: "sms:view" },
            { href: "/sms-marketing/settings", label: t("nav.channelSettings"), permission: "sms:view" },
          ],
        },
      ],
    },
    {
      title: t("nav.account"),
      items: [
        { href: "/team", label: t("nav.team"), icon: <Shield className="h-4 w-4" />, permission: "team:view" },
        { href: "/plans", label: t("nav.plan"), icon: <BarChart3 className="h-4 w-4" /> },
        { href: "/preferences", label: t("nav.preferences"), icon: <Clock className="h-4 w-4" /> },
        ...(user?.role === "admin"
          ? [
              { href: "/developers/api-keys", label: t("nav.apiKeys"), icon: <KeyRound className="h-4 w-4" /> },
              { href: "/developers/webhooks", label: t("nav.webhooks"), icon: <Webhook className="h-4 w-4" /> },
              ...(wl?.data.allowed ? [{ href: "/white-label", label: t("nav.whiteLabel"), icon: <Palette className="h-4 w-4" /> }] : []),
            ]
          : []),
        { href: "/support", label: t("nav.reportRequest"), icon: <Bug className="h-4 w-4" /> },
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

interface InboxNotification {
  id: number;
  title: string;
  message: string;
  type: string;
  isRead: boolean;
  sentAt: string;
}

/** Bell with unread count and a dropdown of the user's notifications. */
function NotificationBell() {
  const { t } = usePlatform();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const unread = useQuery<{ count: number }>({ queryKey: ["/api/notifications/unread-count"], refetchInterval: 120_000 });
  const list = useQuery<Paginated<InboxNotification>>({ queryKey: ["/api/notifications/users", { limit: 15 }], enabled: open });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/notifications/users"] });
  };
  useSocketEvent("notification:new", refresh);
  const readOne = useMutation({ mutationFn: (id: number) => apiRequest("POST", `/api/notifications/${id}/read`), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => apiRequest("POST", "/api/notifications/mark-all"), onSuccess: refresh });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const count = unread.data?.count ?? 0;
  return (
    <div className="relative" ref={panel}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 text-fg-muted hover:bg-subtle hover:text-fg"
        aria-label={`${t("topbar.notifications")}${count ? ` (${count} unread)` : ""}`}
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white tabular-nums">{count > 9 ? "9+" : count}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold">{t("topbar.notifications")}</p>
            {count > 0 && (
              <button className="text-xs font-medium text-primary hover:underline" onClick={() => readAll.mutate()}>
                {t("topbar.markAllRead")}
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {list.data?.data.length ? (
              list.data.data.map((n) => (
                <li key={n.id}>
                  <button
                    className={cn("block w-full border-b border-border px-4 py-3 text-left hover:bg-subtle", !n.isRead && "bg-primary-soft/40")}
                    onClick={() => !n.isRead && readOne.mutate(n.id)}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {!n.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                      {n.title}
                    </span>
                    <span className="mt-0.5 line-clamp-3 block text-xs whitespace-pre-line text-fg-muted">{n.message}</span>
                    <span className="mt-1 block text-[11px] text-fg-muted">{relativeTime(n.sentAt)}</span>
                  </button>
                </li>
              ))
            ) : (
              <li className="px-4 py-8 text-center text-sm text-fg-muted">{list.isLoading ? "…" : t("topbar.noNotifications")}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

const BADGE_TONES = { primary: "bg-primary text-primary-fg", warning: "bg-warning-soft text-warning", danger: "bg-danger-soft text-danger" };

export function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout, can } = useAuth();
  const { config, t } = usePlatform();
  const { connected } = useSocket();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toast = useToast();
  const groups = useNav();

  useSocketEvent("conversation_updated", () => void queryClient.invalidateQueries({ queryKey: ["/api/conversations/unread-count"] }));

  if (!user) return null;
  const isActive = (href: string) => location === href || location.startsWith(`${href}/`);
  const badge = (n: number | undefined, tone: NavLeaf["badgeTone"] = "primary") =>
    n ? <span className={cn("rounded-full px-1.5 text-[11px] font-semibold tabular-nums", BADGE_TONES[tone])}>{n > 999 ? "999+" : n}</span> : null;

  const sidebar = (
    <nav className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-5" aria-label="Main">
      <Link href={user.role === "superadmin" ? "/admin" : "/dashboard"} className="flex items-center gap-2 px-2">
        <img src={config?.logo || "/favicon.svg"} alt="" className="h-7 w-7 rounded object-contain" />
        <span className="truncate text-base font-semibold tracking-tight">{config?.siteTitle ?? "WooMarket360"}</span>
      </Link>
      {groups.map((g) => {
        const items = g.items.filter((i) => !i.permission || can(i.permission));
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <p className="mb-1 px-2 text-[11px] font-semibold tracking-wider text-fg-muted uppercase">{g.title}</p>
            <ul className="flex flex-col gap-0.5">
              {items.map((i) => {
                if (i.children) {
                  const children = i.children.filter((c) => !c.permission || can(c.permission));
                  if (!children.length) return null;
                  const childActive = children.some((c) => isActive(c.href));
                  const isOpen = expanded[i.href] ?? (isActive(i.href) || childActive);
                  return (
                    <li key={i.href}>
                      <button
                        onClick={() => setExpanded((s) => ({ ...s, [i.href]: !isOpen }))}
                        aria-expanded={isOpen}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors",
                          isActive(i.href) || childActive ? "font-medium text-primary" : "text-fg-muted hover:bg-subtle hover:text-fg",
                        )}
                      >
                        {i.icon}
                        <span className="flex-1 text-left">{i.label}</span>
                        {!isOpen && badge(i.badge, i.badgeTone)}
                        <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} />
                      </button>
                      {isOpen && (
                        <ul className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-border pl-3">
                          {children.map((c) => (
                            <li key={c.href}>
                              <Link
                                href={c.href}
                                onClick={() => setOpen(false)}
                                aria-current={isActive(c.href) ? "page" : undefined}
                                className={cn(
                                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                                  isActive(c.href) ? "bg-primary-soft font-medium text-primary" : "text-fg-muted hover:bg-subtle hover:text-fg",
                                )}
                              >
                                <span className="flex-1">{c.label}</span>
                                {badge(c.badge, c.badgeTone)}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                }
                return (
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
                      {badge(i.badge, i.badgeTone)}
                    </Link>
                  </li>
                );
              })}
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
          <LogOut className="h-4 w-4" /> {signingOut ? t("nav.signingOut") : t("nav.signOut")}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-border bg-surface">
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
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitcher compact />
            <NotificationBell />
            <span className="flex items-center gap-2 pl-1 text-xs text-fg-muted">
              <span className={cn("h-2 w-2 rounded-full", connected ? "bg-success" : "bg-fg-muted/50")} aria-hidden />
              <span className="hidden sm:inline">{connected ? t("topbar.live") : t("topbar.offline")}</span>
            </span>
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
