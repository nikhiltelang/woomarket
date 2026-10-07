import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { PhoneOff, ShieldAlert } from "lucide-react";
import type { Role } from "@shared/roles";
import { useAuth } from "@/contexts/auth";
import { useChannel } from "@/contexts/channel";
import { EmptyState, PageLoader } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { PageContainer } from "./app-layout";

export function AccessDenied() {
  return (
    <PageContainer>
      <EmptyState
        icon={<ShieldAlert className="h-10 w-10" />}
        title="Access denied"
        description="Your account doesn't have permission to view this page. Ask your administrator for access."
        action={
          <Link href="/">
            <Button variant="outline">Go to home</Button>
          </Link>
        }
      />
    </PageContainer>
  );
}

/** Renders children only for allowed roles / permissions. The API enforces the same rules. */
export function Guard({ roles, permission, children }: { roles?: Role[]; permission?: string; children: ReactNode }) {
  const { user, can } = useAuth();
  if (!user) return null;
  if (roles && !roles.includes(user.role)) return <AccessDenied />;
  if (permission && !can(permission)) return <AccessDenied />;
  return <>{children}</>;
}

/** Tenant pages that operate on the active WhatsApp channel. */
export function RequireChannel({ children }: { children: ReactNode }) {
  const { activeChannel, isLoading } = useChannel();
  const { can } = useAuth();
  const [location] = useLocation();
  if (isLoading) return <PageLoader />;
  if (!activeChannel) {
    // Contacts and groups are stored per connected number, so email and SMS need one too.
    const marketing = location.startsWith("/email-marketing") || location.startsWith("/sms-marketing");
    return (
      <PageContainer>
        <EmptyState
          icon={<PhoneOff className="h-10 w-10" />}
          title={marketing ? "Add a number to hold your contacts" : "Connect a WhatsApp number first"}
          description={
            marketing
              ? "Contacts and groups are kept per connected number, and email and SMS campaigns send to them. Connect a WhatsApp number (the built-in simulator works for testing) to create your audience."
              : "Inbox, templates and WhatsApp campaigns run on a connected WhatsApp Business number."
          }
          action={
            can("settings:edit") ? (
              <Link href="/settings">
                <Button>Connect a number</Button>
              </Link>
            ) : (
              <p className="text-sm text-fg-muted">Ask your account administrator to connect one.</p>
            )
          }
        />
      </PageContainer>
    );
  }
  return <>{children}</>;
}
