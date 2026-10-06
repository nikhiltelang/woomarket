import { PageContainer } from "@/components/layout/app-layout";
import { PageHeader } from "@/components/ui/display";
import { SmtpSettings } from "@/components/smtp-settings";

export default function SystemSettingsPage() {
  return (
    <PageContainer>
      <PageHeader title="System settings" description="Platform-wide defaults used when a tenant hasn't configured their own." />
      <SmtpSettings platform canEdit />
    </PageContainer>
  );
}
