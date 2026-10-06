import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Paginated, PublicChannel } from "@shared/api-types";
import { formatDate } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Badge, Card, EmptyState, PageHeader, PageLoader, StatusBadge } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";

export default function AdminChannels() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery<Paginated<PublicChannel>>({ queryKey: ["/api/channels/all", { page, limit: 25 }], placeholderData: (p) => p });
  if (isLoading) return <PageLoader />;
  return (
    <PageContainer wide>
      <PageHeader title="Channels" description="All WhatsApp numbers connected across tenants." />
      <Card>
        {!data?.data.length ? (
          <EmptyState title="No channels connected yet" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Channel</Th>
                  <Th>Connection</Th>
                  <Th>Health</Th>
                  <Th className="hidden md:table-cell">Quality</Th>
                  <Th className="hidden lg:table-cell">Owner</Th>
                  <Th className="hidden md:table-cell">Created</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((c) => (
                  <Tr key={c.id}>
                    <Td>
                      <p className="font-medium">{c.name}</p>
                      <p className="text-xs text-fg-muted">{c.phoneNumber}</p>
                    </Td>
                    <Td>
                      <Badge tone={c.connectionMethod === "simulator" ? "info" : "neutral"}>{c.connectionMethod}</Badge>
                      {!c.isActive && <Badge className="ml-1">inactive</Badge>}
                    </Td>
                    <Td>
                      <StatusBadge status={c.healthStatus} />
                    </Td>
                    <Td className="hidden md:table-cell">{String(c.healthDetails.qualityRating ?? "—")}</Td>
                    <Td className="hidden font-mono text-xs text-fg-muted lg:table-cell">{c.createdBy?.slice(0, 8)}</Td>
                    <Td className="hidden text-fg-muted md:table-cell">{formatDate(c.createdAt)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} limit={25} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </PageContainer>
  );
}
