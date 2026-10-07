import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MessageSquareReply } from "lucide-react";
import type { SupportRequest } from "@shared/schema";
import { apiRequest, fieldErrors, queryClient } from "@/lib/api";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/form";
import { Card, EmptyState, ErrorState, PageHeader, Spinner } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useToast } from "@/components/ui/overlay";
import { SUPPORT_TYPES, SupportStatusBadge, SupportTypeBadge, type SupportType } from "@/components/support";

const KEY = "/api/support-requests";

function NewRequestDialog({ type, onClose }: { type: SupportType | null; onClose: () => void }) {
  const toast = useToast();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string>();
  const send = useMutation({
    mutationFn: () => apiRequest("POST", KEY, { type, message }),
    onSuccess: () => {
      toast({ title: "Sent", description: "The platform team will get back to you here.", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: [KEY] });
      setMessage("");
      onClose();
    },
    onError: (err) => {
      const fe = fieldErrors(err);
      setError(fe.message);
      if (!fe.message) toast({ title: "Could not send", description: (err as Error).message, variant: "error" });
    },
  });
  const t = type ? SUPPORT_TYPES[type] : null;
  return (
    <Dialog
      open={Boolean(type)}
      onClose={onClose}
      title={t?.action ?? ""}
      description={type === "bug" ? "Tell us what happened, what you expected and the steps to reproduce it." : "Tell us what you need help with."}
      footer={<Button onClick={() => send.mutate()} loading={send.isPending} disabled={message.trim().length < 10}>Submit</Button>}
    >
      <Field label="Message" htmlFor="sr-message" required error={error} hint="At least 10 characters.">
        <Textarea id="sr-message" rows={7} maxLength={5000} value={message} onChange={(e) => { setMessage(e.target.value); setError(undefined); }} invalid={Boolean(error)} />
      </Field>
    </Dialog>
  );
}

export default function ReportRequestPage() {
  const [creating, setCreating] = useState<SupportType | null>(null);
  const { data, isLoading, error, refetch } = useQuery<{ data: SupportRequest[] }>({ queryKey: [KEY] });

  return (
    <PageContainer wide>
      <PageHeader
        title="Your listed report & request"
        description="Report a problem or ask the platform team for help. Replies appear here and in your notifications."
        actions={(["bug", "support"] as const).map((type) => {
          const t = SUPPORT_TYPES[type];
          const Icon = t.icon;
          return (
            <Button key={type} variant="outline" className={t.button} onClick={() => setCreating(type)}>
              <Icon className="h-4 w-4" /> {t.action}
            </Button>
          );
        })}
      />
      <Card className="overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="p-10 text-center"><Spinner /></div>
        ) : (
          <Table>
            <thead>
              <tr className="[&>th]:bg-primary [&>th]:text-primary-fg">
                <Th className="w-44">Type</Th>
                <Th>Message</Th>
                <Th className="hidden w-40 md:table-cell">Sent</Th>
                <Th className="w-32 text-right">Status</Th>
              </tr>
            </thead>
            <tbody>
              {!data?.data.length ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState title="Data not found" description="Nothing reported yet." />
                  </td>
                </tr>
              ) : (
                data.data.map((r) => (
                  <Tr key={r.id}>
                    <Td className="align-top"><SupportTypeBadge type={r.type} /></Td>
                    <Td className="align-top">
                      <p className="break-words whitespace-pre-line">{r.message}</p>
                      {r.adminReply && (
                        <div className={cn("mt-2 rounded-md border-l-2 border-primary bg-primary-soft/40 px-3 py-2 text-sm")}>
                          <p className="mb-0.5 flex items-center gap-1 text-xs font-medium text-primary">
                            <MessageSquareReply className="h-3.5 w-3.5" /> Reply from the platform team · {relativeTime(r.repliedAt)}
                          </p>
                          <p className="break-words whitespace-pre-line">{r.adminReply}</p>
                        </div>
                      )}
                    </Td>
                    <Td className="hidden align-top text-fg-muted tabular-nums md:table-cell">{formatDate(r.createdAt)}</Td>
                    <Td className="text-right align-top"><SupportStatusBadge status={r.status} /></Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        )}
      </Card>
      <NewRequestDialog type={creating} onClose={() => setCreating(null)} />
    </PageContainer>
  );
}
