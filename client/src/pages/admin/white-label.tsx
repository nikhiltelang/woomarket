import { useMutation, useQuery } from "@tanstack/react-query";
import { Palette } from "lucide-react";
import type { Brand } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, PageHeader, PageLoader } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { useConfirm, useToast } from "@/components/ui/overlay";

type Row = Brand & {
  owner: { id: string; username: string; email: string } | null;
  clients: number;
  domains: { id: string; domain: string; verified: boolean; disabled: boolean; verifiedAt: string | null }[];
};

/** Superadmin: every agency brand and custom domain, with a switch to turn a domain off. */
export default function AdminWhiteLabel() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<{ data: Row[] }>({ queryKey: ["/api/admin/white-label"] });
  const toggle = useMutation({
    mutationFn: (d: { id: string; disabled: boolean }) => apiRequest("PUT", `/api/admin/white-label/domains/${d.id}`, { disabled: d.disabled }),
    onSuccess: () => {
      toast({ title: "Domain updated", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/white-label"] });
    },
  });
  if (isLoading) return <PageLoader />;
  const rows = data?.data ?? [];
  return (
    <PageContainer wide>
      <PageHeader title="White-label" description="Agencies reselling the platform under their own brand. Enable it per access level (Manage levels → White-label)." />
      {rows.length === 0 ? (
        <Card><EmptyState icon={<Palette className="h-10 w-10" />} title="No brands yet" description="Agencies on an access level with white-label set up their brand from their own White-label page." /></Card>
      ) : (
        <Card>
          <Table>
            <thead><tr><Th>Brand</Th><Th>Agency</Th><Th className="text-right">Clients</Th><Th>Domains</Th><Th>Created</Th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <Tr key={b.id}>
                  <Td>
                    <span className="flex items-center gap-2 font-medium">
                      <span className="h-3 w-3 rounded-full" style={{ background: b.baseColor }} aria-hidden />
                      {b.name}
                    </span>
                  </Td>
                  <Td className="text-sm">{b.owner ? <>@{b.owner.username}<br /><span className="text-xs text-fg-muted">{b.owner.email}</span></> : "—"}</Td>
                  <Td className="text-right tabular-nums">{b.clients}</Td>
                  <Td>
                    <ul className="space-y-1">
                      {b.domains.length === 0 && <li className="text-xs text-fg-muted">None</li>}
                      {b.domains.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span>{d.domain}</span>
                          {d.disabled ? <Badge tone="danger">Off</Badge> : d.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Pending</Badge>}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (d.disabled || (await confirm({ title: `Turn off ${d.domain}?`, description: "The domain stops showing the brand and its clients sign in on the platform's address instead.", confirmText: "Turn off", destructive: true })))
                                toggle.mutate({ id: d.id, disabled: !d.disabled });
                            }}
                          >
                            {d.disabled ? "Turn on" : "Turn off"}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{formatDate(b.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </PageContainer>
  );
}
