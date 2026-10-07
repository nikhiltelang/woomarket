import { useQuery } from "@tanstack/react-query";
import { PageContainer } from "@/components/layout/app-layout";
import { Card, ErrorState, PageHeader, PageLoader } from "@/components/ui/display";

const PAGES = {
  application: { title: "Application information", description: "Version, runtime and database the application is running on." },
  server: { title: "Server information", description: "The machine and HTTP server handling this request." },
} as const;

export default function SystemInfoPage({ kind }: { kind: keyof typeof PAGES }) {
  const { data, isLoading, error, refetch } = useQuery<{ data: { label: string; value: string }[] }>({ queryKey: [`/api/superadmin/system-info/${kind}`] });
  if (isLoading) return <PageLoader />;
  const page = PAGES[kind];
  return (
    <PageContainer wide>
      <PageHeader title={page.title} description={page.description} />
      <Card className="overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : (
          <dl className="divide-y divide-border">
            {data?.data.map((r) => (
              <div key={r.label} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <dt className="text-fg-muted sm:text-base">{r.label}</dt>
                <dd className="font-medium break-all tabular-nums sm:text-right sm:text-base">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </PageContainer>
  );
}
