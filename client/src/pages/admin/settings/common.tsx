import type { ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import type { PanelConfig, SystemConfig } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/api";
import { PUBLIC_CONFIG_KEY } from "@/contexts/platform";
import { PageContainer } from "@/components/layout/app-layout";
import { Card, PageHeader, PageLoader } from "@/components/ui/display";
import { useToast } from "@/components/ui/overlay";

export type AdminSystemConfig = Omit<SystemConfig, "extensionSettings"> & {
  extensionSettings: {
    googleLogin: { enabled: boolean; clientId: string; hasClientSecret: boolean };
    microsoftLogin: { enabled: boolean; clientId: string; tenant: string; hasClientSecret: boolean };
    aiAssistant: { enabled: boolean; model: string; monthlyLimit: number; hasApiKey: boolean };
    payments: {
      stripe: { enabled: boolean; publishableKey: string; hasSecretKey: boolean; hasWebhookSecret: boolean };
      razorpay: { enabled: boolean; keyId: string; hasKeySecret: boolean; hasWebhookSecret: boolean };
      taxRate: number;
      taxLabel: string;
      invoiceDetails: string;
      trialPlanId: string | null;
      trialDays: number;
    };
    whatsappSignup: { enabled: boolean; appId: string; configId: string; coexistence: boolean; hasAppSecret: boolean; envAppSecret: boolean };
    queue: { enabled: boolean; prefix: string; concurrency: number; urlMasked: string | null; envUrl: string | null };
  };
};

export interface SystemConfigResponse {
  data: AdminSystemConfig;
  panel: PanelConfig;
  googleRedirectUri: string;
  microsoftRedirectUri: string;
  defaults: { robotsTxt: string; sitemapXml: string };
}

export const SYSTEM_CONFIG_KEY = ["/api/system-config"];

export function useSystemConfig() {
  return useQuery<SystemConfigResponse>({ queryKey: SYSTEM_CONFIG_KEY });
}

export function refreshConfig() {
  void queryClient.invalidateQueries({ queryKey: SYSTEM_CONFIG_KEY });
  void queryClient.invalidateQueries({ queryKey: PUBLIC_CONFIG_KEY });
}

/** Saves one settings section (PUT /api/system-config/:section). */
export function useSaveSection(section: string, successTitle = "Settings saved") {
  const toast = useToast();
  return useMutation({
    mutationFn: (body: unknown) => apiRequest("PUT", `/api/system-config/${section}`, body),
    onSuccess: () => {
      toast({ title: successTitle, variant: "success" });
      refreshConfig();
    },
    onError: (err) => toast({ title: "Could not save", description: (err as Error).message, variant: "error" }),
  });
}

export function SectionShell({ title, description, children, wide }: { title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return (
    <PageContainer wide={wide}>
      <Link href="/system-settings" className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" /> System settings
      </Link>
      <PageHeader title={title} description={description} />
      {children}
    </PageContainer>
  );
}

export function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={className ?? "p-5"}>{children}</Card>;
}

/** Waits for the configuration before rendering a section form (so forms initialise with real values). */
export function WithConfig({ children }: { children: (c: SystemConfigResponse) => ReactNode }) {
  const { data, isLoading } = useSystemConfig();
  if (isLoading || !data) return <PageLoader />;
  return <>{children(data)}</>;
}
