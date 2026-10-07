import { lazy, Suspense, type ComponentType } from "react";
import { Redirect, Route, Switch } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Role } from "@shared/roles";
import { queryClient } from "@/lib/api";
import { AuthProvider, useAuth } from "@/contexts/auth";
import { ChannelProvider } from "@/contexts/channel";
import { SocketProvider } from "@/contexts/socket";
import { TwoFactorGate } from "@/components/two-factor";
import { twoFactorRequired } from "@shared/platform";
import { PlatformProvider, usePlatform } from "@/contexts/platform";
import { CookieBanner, MaintenanceScreen } from "@/components/public";
import { ConfirmProvider, ToastProvider } from "@/components/ui/overlay";
import { PageLoader } from "@/components/ui/display";
import { AppLayout } from "@/components/layout/app-layout";
import { Guard, RequireChannel } from "@/components/layout/guards";
import LoginPage from "@/pages/login";
import SignupPage from "@/pages/signup";
import NotFound from "@/pages/not-found";

const Dashboard = lazy(() => import("@/pages/dashboard"));
const Inbox = lazy(() => import("@/pages/inbox"));
const Contacts = lazy(() => import("@/pages/contacts"));
const Groups = lazy(() => import("@/pages/groups"));
const Segments = lazy(() => import("@/pages/segments"));
const Templates = lazy(() => import("@/pages/templates"));
const Campaigns = lazy(() => import("@/pages/campaigns"));
const CampaignAnalytics = lazy(() => import("@/pages/campaign-analytics"));
const Settings = lazy(() => import("@/pages/settings"));
const Team = lazy(() => import("@/pages/team"));
const Account = lazy(() => import("@/pages/account"));
const Plans = lazy(() => import("@/pages/plans"));
const EmailMarketing = lazy(() => import("@/pages/email-marketing"));
const SmsMarketing = lazy(() => import("@/pages/sms-marketing"));
const SettingsHub = lazy(() => import("@/pages/admin/settings/hub"));
const SettingsSection = lazy(() => import("@/pages/admin/settings/section-page"));
const SendNotification = lazy(() => import("@/pages/admin/send-notification"));
const Levels = lazy(() => import("@/pages/admin/levels"));
const PolicyPage = lazy(() => import("@/pages/policy"));
const LandingRoute = lazy(() => import("@/pages/landing"));
const LandingEditor = lazy(() => import("@/pages/admin/landing-editor"));
const AdminOverview = lazy(() => import("@/pages/admin/overview"));
const AdminUsers = lazy(() => import("@/pages/admin/users"));
const AdminChannels = lazy(() => import("@/pages/admin/channels"));
const AdminPlans = lazy(() => import("@/pages/admin/plans"));
const AppUpdate = lazy(() => import("@/pages/admin/app-update"));
const Coupons = lazy(() => import("@/pages/admin/coupons"));
const SupportRequests = lazy(() => import("@/pages/admin/support-requests"));
const SystemInfo = lazy(() => import("@/pages/admin/system-info"));
const CachePage = lazy(() => import("@/pages/admin/cache"));
const LogsPage = lazy(() => import("@/pages/admin/logs"));
const ReportRequest = lazy(() => import("@/pages/report-request"));
const ApiKeys = lazy(() => import("@/pages/api-keys"));
const Webhooks = lazy(() => import("@/pages/webhooks"));
const Preferences = lazy(() => import("@/pages/preferences"));

const TENANT: Role[] = ["admin", "team"];
const SUPER: Role[] = ["superadmin"];

interface RouteDef {
  path: string;
  component: ComponentType<any>;
  roles?: Role[];
  permission?: string;
  channel?: boolean;
}

const routes: RouteDef[] = [
  { path: "/dashboard", component: Dashboard, roles: TENANT },
  { path: "/inbox", component: Inbox, roles: TENANT, permission: "inbox:view", channel: true },
  { path: "/contacts", component: Contacts, roles: TENANT, permission: "contacts:view", channel: true },
  { path: "/groups", component: Groups, roles: TENANT, permission: "contacts:view", channel: true },
  { path: "/segments", component: Segments, roles: TENANT, permission: "contacts:view", channel: true },
  { path: "/templates", component: Templates, roles: TENANT, permission: "templates:view", channel: true },
  { path: "/campaigns", component: Campaigns, roles: TENANT, permission: "campaigns:view", channel: true },
  { path: "/analytics/campaign/:campaignId", component: CampaignAnalytics, roles: TENANT, permission: "campaigns:view" },
  { path: "/email-marketing/:tab", component: EmailMarketing, roles: TENANT, permission: "email:view", channel: true },
  { path: "/sms-marketing/:tab", component: SmsMarketing, roles: TENANT, permission: "sms:view", channel: true },
  { path: "/settings", component: Settings, roles: TENANT, permission: "settings:view" },
  { path: "/team", component: Team, roles: TENANT, permission: "team:view" },
  { path: "/plans", component: Plans, roles: TENANT },
  { path: "/support", component: ReportRequest, roles: TENANT },
  { path: "/preferences", component: Preferences, roles: TENANT },
  { path: "/developers/api-keys", component: ApiKeys, roles: ["admin"] },
  { path: "/developers/webhooks", component: Webhooks, roles: ["admin"] },
  { path: "/account", component: Account },
  { path: "/admin", component: AdminOverview, roles: SUPER },
  { path: "/users/send-notification", component: SendNotification, roles: SUPER },
  { path: "/users/:segment", component: AdminUsers, roles: SUPER },
  { path: "/manage-levels", component: Levels, roles: SUPER },
  { path: "/channels-management", component: AdminChannels, roles: SUPER },
  { path: "/master-subscriptions", component: AdminPlans, roles: SUPER },
  { path: "/manage-coupons", component: Coupons, roles: SUPER },
  { path: "/report-request", component: SupportRequests, roles: SUPER },
  { path: "/extra/application", component: () => <SystemInfo kind="application" />, roles: SUPER },
  { path: "/extra/server", component: () => <SystemInfo kind="server" />, roles: SUPER },
  { path: "/extra/cache", component: CachePage, roles: SUPER },
  { path: "/logs", component: LogsPage, roles: SUPER },
  { path: "/landing-page", component: LandingEditor, roles: SUPER },
  { path: "/extra/update", component: AppUpdate, roles: SUPER },
  { path: "/app-update", component: AppUpdate, roles: SUPER },
  { path: "/system-settings", component: SettingsHub, roles: SUPER },
  { path: "/system-settings/:section", component: SettingsSection, roles: SUPER },
];

function Authenticated() {
  const { user, isLoading, logout } = useAuth();
  const { config } = usePlatform();
  if (isLoading) return <PageLoader />;
  if (!user) return <Redirect to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  const home = user.role === "superadmin" ? "/admin" : "/dashboard";
  if (config?.maintenance.enabled && user.role !== "superadmin") {
    return <MaintenanceScreen title={config.maintenance.title} content={config.maintenance.content} onSignOut={() => void logout()} />;
  }
  if (twoFactorRequired(user.role, config?.twoFactorPolicy) && !user.twoFactorEnabled) return <TwoFactorGate />;

  return (
    <ChannelProvider>
      <SocketProvider>
        <AppLayout>
          <Suspense fallback={<PageLoader />}>
            <Switch>
              <Route path="/">
                <Redirect to={home} />
              </Route>
              <Route path="/users">
                <Redirect to="/users/all" />
              </Route>
              <Route path="/email-marketing">
                <Redirect to={`/email-marketing/campaigns${location.search}`} />
              </Route>
              <Route path="/sms-marketing">
                <Redirect to={`/sms-marketing/campaigns${location.search}`} />
              </Route>
              {routes.map(({ path, component: C, roles, permission, channel }) => (
                <Route key={path} path={path}>
                  {(params) => (
                    <Guard roles={roles} permission={permission}>
                      {channel ? (
                        <RequireChannel>
                          <C params={params} />
                        </RequireChannel>
                      ) : (
                        <C params={params} />
                      )}
                    </Guard>
                  )}
                </Route>
              ))}
              <Route component={NotFound} />
            </Switch>
          </Suspense>
        </AppLayout>
      </SocketProvider>
    </ChannelProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <PlatformProvider>
            <AuthProvider>
              <Suspense fallback={<PageLoader />}>
                <Switch>
                  <Route path="/">{() => <LandingRoute />}</Route>
                  <Route path="/home">{() => <LandingRoute always />}</Route>
                  <Route path="/login" component={LoginPage} />
                  <Route path="/signup" component={SignupPage} />
                  <Route path="/policy/:slug" component={PolicyPage} />
                  <Route component={Authenticated} />
                </Switch>
              </Suspense>
              <CookieBanner />
            </AuthProvider>
          </PlatformProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
