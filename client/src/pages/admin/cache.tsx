import { useMutation, useQuery } from "@tanstack/react-query";
import { Eraser, Trash2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Card, ErrorState, PageHeader, PageLoader } from "@/components/ui/display";
import { useConfirm, useToast } from "@/components/ui/overlay";

interface CacheItem {
  key: string;
  name: string;
  description: string;
  entries: number;
}
const KEY = "/api/superadmin/cache";

export default function CachePage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading, error, refetch } = useQuery<{ data: CacheItem[] }>({ queryKey: [KEY], staleTime: 0 });
  const clear = useMutation({
    mutationFn: (keys?: string[]) => apiRequest<{ data: Record<string, number> }>("POST", `${KEY}/clear`, keys ? { keys } : {}),
    onSuccess: (res) => {
      const removed = Object.values(res.data).reduce((a, b) => a + b, 0);
      toast({ title: "Cache cleared", description: `${formatNumber(removed)} entr${removed === 1 ? "y" : "ies"} removed.`, variant: "success" });
      // Everything this browser fetched may reflect the old settings.
      void queryClient.invalidateQueries();
    },
    onError: (err) => toast({ title: "Could not clear cache", description: (err as Error).message, variant: "error" }),
  });
  if (isLoading) return <PageLoader />;
  const items = data?.data ?? [];
  const total = items.reduce((a, i) => a + i.entries, 0);

  return (
    <PageContainer wide>
      <PageHeader
        title="Cache"
        description="Clear cached settings and stale records. Nothing a user needs is removed."
        actions={
          <Button
            onClick={async () => {
              if (await confirm({ title: "Clear all caches?", description: "Settings reload from the database on the next request and stale records are deleted.", confirmText: "Clear cache" })) clear.mutate(undefined);
            }}
            loading={clear.isPending && !clear.variables}
          >
            <Eraser className="h-4 w-4" /> Clear all cache
          </Button>
        }
      />
      <Card className="overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => (
              <li key={i.key} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">{i.name}</p>
                  <p className="text-sm text-fg-muted">{i.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <span className="text-sm tabular-nums">
                    <span className="font-semibold">{formatNumber(i.entries)}</span> <span className="text-fg-muted">entr{i.entries === 1 ? "y" : "ies"}</span>
                  </span>
                  <Button size="sm" variant="outline" disabled={!i.entries} loading={clear.isPending && clear.variables?.[0] === i.key} onClick={() => clear.mutate([i.key])}>
                    <Trash2 className="h-3.5 w-3.5" /> Clear
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="mt-3 text-xs text-fg-muted">{formatNumber(total)} entr{total === 1 ? "y" : "ies"} in total. Expired sessions are also removed automatically every 15 minutes.</p>
    </PageContainer>
  );
}
