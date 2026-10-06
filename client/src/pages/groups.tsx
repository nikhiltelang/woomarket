import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import type { Group } from "@shared/schema";
import { useChannel } from "@/contexts/channel";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDay, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Card, EmptyState, PageHeader, PageLoader } from "@/components/ui/display";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

type GroupRow = Group & { contactCount: number };

export default function GroupsPage() {
  const { activeChannel } = useChannel();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<GroupRow | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const channelId = activeChannel!.id;
  const { data, isLoading } = useQuery<{ data: GroupRow[] }>({ queryKey: ["/api/groups", { channelId }] });

  const openDialog = (g: GroupRow | null) => {
    setEditing(g);
    setName(g?.name ?? "");
    setDescription(g?.description ?? "");
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: () =>
      editing
        ? apiRequest("PUT", `/api/groups/${editing.id}`, { name, description })
        : apiRequest("POST", "/api/groups", { name, description, channelId }),
    onSuccess: () => {
      toast({ title: editing ? "Group updated" : "Group created", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      setOpen(false);
    },
    onError: (err) => toast({ title: "Could not save group", description: (err as Error).message, variant: "error" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/groups/${id}`),
    onSuccess: () => {
      toast({ title: "Group deleted", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    },
  });

  if (isLoading) return <PageLoader />;
  const groups = data?.data ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Groups"
        description="Segment contacts to target campaigns."
        actions={
          can("groups:manage") && (
            <Button onClick={() => openDialog(null)}>
              <Plus className="h-4 w-4" /> New group
            </Button>
          )
        }
      />
      {groups.length === 0 ? (
        <Card>
          <EmptyState icon={<UsersRound className="h-10 w-10" />} title="No groups yet" description="Create a group, then add contacts to it from the Contacts page." />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <Card key={g.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">{g.name}</h2>
                  <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{g.description || "No description"}</p>
                </div>
                {can("groups:manage") && (
                  <div className="flex shrink-0">
                    <Button size="icon" variant="ghost" onClick={() => openDialog(g)} aria-label={`Edit ${g.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${g.name}`}
                      onClick={async () => {
                        if (await confirm({ title: `Delete "${g.name}"?`, description: "Contacts stay; they're just removed from this group.", confirmText: "Delete", destructive: true })) {
                          remove.mutate(g.id);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-auto flex items-end justify-between pt-5">
                <p>
                  <span className="text-2xl font-semibold tabular-nums">{formatNumber(g.contactCount)}</span>
                  <span className="ml-1 text-sm text-fg-muted">contacts</span>
                </p>
                <Link href="/contacts" className="text-xs font-medium text-primary hover:underline">
                  Manage contacts
                </Link>
              </div>
              <p className="mt-2 text-xs text-fg-muted">Created {formatDay(g.createdAt)}</p>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit group" : "New group"}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" htmlFor="g-name">
            <Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
          </Field>
          <Field label="Description" htmlFor="g-desc">
            <Textarea id="g-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
          </Field>
        </div>
      </Dialog>
    </PageContainer>
  );
}
