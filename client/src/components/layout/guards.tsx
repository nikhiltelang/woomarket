import type { ReactNode } from "react";
import { Link } from "wouter";
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
  if (isLoading) return <PageLoader />;
  if (!activeChannel) {
    return (
      <PageContainer>
        <EmptyState
          icon={<PhoneOff className="h-10 w-10" />}
          title="Connect a WhatsApp number first"
          description="Inbox, contacts, templates and campaigns all work on a connected WhatsApp Business number."
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
