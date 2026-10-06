import { lazy, Suspense, type ComponentType } from "react";
import { Redirect, Route, Switch } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Role } from "@shared/roles";
import { queryClient } from "@/lib/api";
import { AuthProvider, useAuth } from "@/contexts/auth";
import { ChannelProvider } from "@/contexts/channel";
import { SocketProvider } from "@/contexts/socket";
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
const Templates = lazy(() => import("@/pages/templates"));
const Campaigns = lazy(() => import("@/pages/campaigns"));
const CampaignAnalytics = lazy(() => import("@/pages/campaign-analytics"));
const Settings = lazy(() => import("@/pages/settings"));
const Team = lazy(() => import("@/pages/team"));
const Account = lazy(() => import("@/pages/account"));
const Plans = lazy(() => import("@/pages/plans"));
const EmailMarketing = lazy(() => import("@/pages/email-marketing"));
const SmsMarketing = lazy(() => import("@/pages/sms-marketing"));
const SystemSettings = lazy(() => import("@/pages/admin/system-settings"));
const AdminOverview = lazy(() => import("@/pages/admin/overview"));
const AdminUsers = lazy(() => import("@/pages/admin/users"));
const AdminChannels = lazy(() => import("@/pages/admin/channels"));
const AdminPlans = lazy(() => import("@/pages/admin/plans"));
const AppUpdate = lazy(() => import("@/pages/admin/app-update"));

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
  { path: "/dashboard", component: Dashboard, roles: TENANT, channel: true },
  { path: "/inbox", component: Inbox, roles: TENANT, permission: "inbox:view", channel: true },
  { path: "/contacts", component: Contacts, roles: TENANT, permission: "contacts:view", channel: true },
  { path: "/groups", component: Groups, roles: TENANT, permission: "contacts:view", channel: true },
  { path: "/templates", component: Templates, roles: TENANT, permission: "templates:view", channel: true },
  { path: "/campaigns", component: Campaigns, roles: TENANT, permission: "campaigns:view", channel: true },
  { path: "/analytics/campaign/:campaignId", component: CampaignAnalytics, roles: TENANT, permission: "campaigns:view" },
  { path: "/email-marketing", component: EmailMarketing, roles: TENANT, permission: "email:view", channel: true },
  { path: "/sms-marketing", component: SmsMarketing, roles: TENANT, permission: "sms:view", channel: true },
  { path: "/settings", component: Settings, roles: TENANT, permission: "settings:view" },
  { path: "/team", component: Team, roles: TENANT, permission: "team:view" },
  { path: "/plans", component: Plans, roles: TENANT },
  { path: "/account", component: Account },
  { path: "/admin", component: AdminOverview, roles: SUPER },
  { path: "/users", component: AdminUsers, roles: SUPER },
  { path: "/channels-management", component: AdminChannels, roles: SUPER },
  { path: "/master-subscriptions", component: AdminPlans, roles: SUPER },
  { path: "/app-update", component: AppUpdate, roles: SUPER },
  { path: "/system-settings", component: SystemSettings, roles: SUPER },
];

function Authenticated() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <PageLoader />;
  if (!user) return <Redirect to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  const home = user.role === "superadmin" ? "/admin" : "/dashboard";

  return (
    <ChannelProvider>
      <SocketProvider>
        <AppLayout>
          <Suspense fallback={<PageLoader />}>
            <Switch>
              <Route path="/">
                <Redirect to={home} />
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
          <AuthProvider>
            <Switch>
              <Route path="/login" component={LoginPage} />
              <Route path="/signup" component={SignupPage} />
              <Route component={Authenticated} />
            </Switch>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
