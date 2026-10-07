import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Eye, LifeBuoy } from "lucide-react";
import type { Paginated } from "@shared/api-types";
import type { SupportRequest } from "@shared/schema";
import { usePlatform } from "@/contexts/platform";
import { apiRequest, queryClient } from "@/lib/api";
import { displayName, formatDate, relativeTime } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/form";
import { Card, EmptyState, ErrorState, PageHeader, Spinner } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useToast } from "@/components/ui/overlay";
import { SUPPORT_STATUS_LABEL, SupportStatusBadge, SupportTypeBadge } from "@/components/support";

type Row = SupportRequest & { reporter: { username: string; firstName: string | null; lastName: string | null; email: string; role: string } };
const KEY = "/api/superadmin/support-requests";
const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;

function ReviewDialog({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState("open");
  const [reply, setReply] = useState("");
  useEffect(() => {
    if (row) {
      setStatus(row.status);
      setReply(row.adminReply ?? "");
    }
  }, [row]);
  const save = useMutation({
    mutationFn: () => apiRequest("PUT", `${KEY}/${row!.id}`, { status, reply }),
    onSuccess: () => {
      toast({ title: "Request updated", description: "The reporter has been notified.", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [KEY] });
      void queryClient.invalidateQueries({ queryKey: [`${KEY}/counts`] });
      onClose();
    },
    onError: (err) => toast({ title: "Could not update", description: (err as Error).message, variant: "error" }),
  });
  return (
    <Dialog
      open={Boolean(row)}
      onClose={onClose}
      size="lg"
      title={row ? `#${row.id} · ${row.type === "bug" ? "Bug report" : "Support request"}` : ""}
      description={row ? `From ${displayName(row.reporter)} (${row.reporter.email}) · ${formatDate(row.createdAt)}` : undefined}
      footer={<Button onClick={() => save.mutate()} loading={save.isPending}>Save & notify</Button>}
    >
      {row && (
        <div className="space-y-4">
          <div className="rounded-md bg-subtle p-3 text-sm break-words whitespace-pre-line">{row.message}</div>
          <Field label="Status" htmlFor="sr-status">
            <Select id="sr-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
              {STATUSES.map((s) => <option key={s} value={s}>{SUPPORT_STATUS_LABEL[s]}</option>)}
            </Select>
          </Field>
          <Field label="Reply" htmlFor="sr-reply" hint="Shown to the reporter on their Report & request page and sent as an in-app notification.">
            <Textarea id="sr-reply" rows={5} maxLength={5000} value={reply} onChange={(e) => setReply(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

export default function SupportRequestsPage() {
  const { config } = usePlatform();
  const [status, setStatus] = useState<"" | (typeof STATUSES)[number]>("open");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<Row | null>(null);
  const limit = config?.recordsPerPage ?? 20;
  const { data, isLoading, error, refetch } = useQuery<Paginated<Row>>({ queryKey: [KEY, { page, limit, status, type }] });
  const { data: counts } = useQuery<{ data: Record<string, number> }>({ queryKey: [`${KEY}/counts`] });
  const c = counts?.data ?? {};
  const total = Object.values(c).reduce((a, b) => a + b, 0);

  return (
    <PageContainer wide>
      <PageHeader
        title="Report & request"
        description="Bug reports and support requests from tenants and their teams."
        actions={
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-44" aria-label="Filter by type">
            <option value="">All types</option>
            <option value="bug">Bug reports</option>
            <option value="support">Support requests</option>
          </Select>
        }
      />
      <div className="mb-4 overflow-x-auto">
        <Tabs
          value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          tabs={[
            ...STATUSES.map((s) => ({ value: s, label: `${SUPPORT_STATUS_LABEL[s]} (${c[s] ?? 0})` })),
            { value: "" as const, label: `All (${total})` },
          ]}
        />
      </div>
      <Card className="overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="p-10 text-center"><Spinner /></div>
        ) : !data?.data.length ? (
          <EmptyState icon={<LifeBuoy className="h-10 w-10" />} title="Data not found" description={status ? `No ${SUPPORT_STATUS_LABEL[status].toLowerCase()} requests.` : "Nobody has reported anything yet."} />
        ) : (
          <>
            <Table>
              <thead>
                <tr className="[&>th]:bg-primary [&>th]:text-primary-fg">
                  <Th className="w-44">Type</Th>
                  <Th>Message</Th>
                  <Th className="hidden lg:table-cell">Reported by</Th>
                  <Th className="hidden md:table-cell">Sent</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Action</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((r) => (
                  <Tr key={r.id}>
                    <Td><SupportTypeBadge type={r.type} /></Td>
                    <Td className="max-w-md">
                      <p className="line-clamp-2 break-words">{r.message}</p>
                      {r.adminReply && <p className="mt-0.5 text-xs text-fg-muted">Replied {relativeTime(r.repliedAt)}</p>}
                    </Td>
                    <Td className="hidden lg:table-cell">
                      <p className="font-medium">{displayName(r.reporter)}</p>
                      <p className="text-xs text-fg-muted">{r.reporter.email} · {r.reporter.role === "team" ? "Team member" : "Tenant admin"}</p>
                    </Td>
                    <Td className="hidden whitespace-nowrap text-fg-muted tabular-nums md:table-cell">{relativeTime(r.createdAt)}</Td>
                    <Td><SupportStatusBadge status={r.status} /></Td>
                    <Td className="text-right">
                      <Button size="sm" variant="outline" className="border-primary text-primary" onClick={() => setViewing(r)}>
                        <Eye className="h-3.5 w-3.5" /> Review
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} limit={limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <ReviewDialog row={viewing} onClose={() => setViewing(null)} />
    </PageContainer>
  );
}
