import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { Download, MessageSquare, Pencil, Plus, Search, Trash2, Upload, Users } from "lucide-react";
import { contactSchema } from "@shared/validation";
import type { Contact, Group } from "@shared/schema";
import type { Paginated } from "@shared/api-types";
import { useChannel } from "@/contexts/channel";
import { useAuth } from "@/contexts/auth";
import { apiRequest, buildUrl, queryClient } from "@/lib/api";
import { downloadUrl, formatDay, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner, StatusBadge } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

type ContactForm = z.input<typeof contactSchema>;
type GroupRow = Group & { contactCount: number };

function ContactDialog({ open, onClose, contact, groups }: { open: boolean; onClose: () => void; contact: Contact | null; groups: GroupRow[] }) {
  const { activeChannel } = useChannel();
  const toast = useToast();
  const form = useForm<ContactForm>({ resolver: zodResolver(contactSchema) });
  const [tags, setTags] = useState("");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    form.reset({ name: contact?.name ?? "", phone: contact?.phone ?? "", email: contact?.email ?? "", status: (contact?.status as never) ?? "active" });
    setTags((contact?.tags ?? []).join(", "));
    setSelectedGroups(contact?.groups ?? []);
  }, [open, contact]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (values: ContactForm) => {
      const body = { ...values, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), groups: selectedGroups };
      return contact
        ? apiRequest("PUT", `/api/contacts/${contact.id}`, body)
        : apiRequest("POST", "/api/contacts", { ...body, channelId: activeChannel!.id });
    },
    onSuccess: () => {
      toast({ title: contact ? "Contact updated" : "Contact added", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
      onClose();
    },
    onError: (err) => toast({ title: "Could not save contact", description: (err as Error).message, variant: "error" }),
  });
  const errors = form.formState.errors;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={contact ? "Edit contact" : "Add contact"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={form.handleSubmit((v) => save.mutate(v))} loading={save.isPending}>
            {contact ? "Save changes" : "Add contact"}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
        <Field label="Name" htmlFor="c-name" error={errors.name?.message}>
          <Input id="c-name" {...form.register("name")} invalid={!!errors.name} />
        </Field>
        <Field label="WhatsApp number" htmlFor="c-phone" error={errors.phone?.message} hint="International format with country code, e.g. +14155550123">
          <Input id="c-phone" inputMode="tel" {...form.register("phone")} invalid={!!errors.phone} />
        </Field>
        <Field label="Email" htmlFor="c-email" error={errors.email?.message}>
          <Input id="c-email" type="email" {...form.register("email")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status" htmlFor="c-status">
            <Select id="c-status" {...form.register("status")}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="blocked">Blocked</option>
            </Select>
          </Field>
          <Field label="Tags" htmlFor="c-tags" hint="Comma separated">
            <Input id="c-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        {groups.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Groups</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {groups.map((g) => (
                <Checkbox
                  key={g.id}
                  label={g.name}
                  checked={selectedGroups.includes(g.id)}
                  onChange={(v) => setSelectedGroups((s) => (v ? [...s, g.id] : s.filter((x) => x !== g.id)))}
                />
              ))}
            </div>
          </fieldset>
        )}
      </form>
    </Dialog>
  );
}

interface ImportResult {
  total: number;
  imported: number;
  duplicates: number;
  invalid: number;
  errors: { row: number; message: string }[];
}

function ImportDialog({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: GroupRow[] }) {
  const { activeChannel } = useChannel();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [groupId, setGroupId] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append("file", file!);
      fd.append("channelId", activeChannel!.id);
      if (groupId) fd.append("groupId", groupId);
      return apiRequest<ImportResult>("POST", "/api/contacts/import", fd);
    },
    onSuccess: (r) => {
      setResult(r);
      void queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
    },
    onError: (err) => toast({ title: "Import failed", description: (err as Error).message, variant: "error" }),
  });

  const close = () => {
    setFile(null);
    setResult(null);
    setGroupId("");
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import contacts"
      description="Upload a CSV with columns: name, phone, email (optional), tags (optional, separated by ;)."
      footer={
        result ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!file}>
              Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-sm">
          <p>
            <strong>{formatNumber(result.imported)}</strong> of {formatNumber(result.total)} rows imported.
            {result.duplicates > 0 && ` ${formatNumber(result.duplicates)} already existed.`}
            {result.invalid > 0 && ` ${formatNumber(result.invalid)} were invalid.`}
          </p>
          {result.errors.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md bg-subtle p-3 text-xs">
              {result.errors.map((e) => (
                <li key={e.row}>
                  Row {e.row}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="CSV file" htmlFor="csv">
            <Input id="csv" type="file" accept=".csv,text/csv" className="pt-1.5" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          {groups.length > 0 && (
            <Field label="Add imported contacts to group" htmlFor="imp-group">
              <Select id="imp-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
    </Dialog>
  );
}

export default function ContactsPage() {
  const { activeChannel } = useChannel();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [, navigate] = useLocation();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [groupId, setGroupId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Contact | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkGroup, setBulkGroup] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setSelected(new Set()), [page, debounced, groupId, activeChannel?.id]);

  const channelId = activeChannel!.id;
  const limit = 25;
  const { data, isLoading, error, refetch } = useQuery<Paginated<Contact>>({
    queryKey: ["/api/contacts", { channelId, page, limit, search: debounced || undefined, groupId: groupId || undefined }],
    placeholderData: (prev) => prev,
  });
  const groups = useQuery<{ data: GroupRow[] }>({ queryKey: ["/api/groups", { channelId }] });
  const groupList = groups.data?.data ?? [];
  const groupName = (id: string) => groupList.find((g) => g.id === id)?.name;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/groups"] });
  };

  const remove = useMutation({
    mutationFn: (ids: string[]) =>
      ids.length === 1 ? apiRequest("DELETE", `/api/contacts/${ids[0]}`) : apiRequest("DELETE", "/api/contacts-bulk", { channelId, ids }),
    onSuccess: (_d, ids) => {
      toast({ title: `${ids.length} contact${ids.length > 1 ? "s" : ""} deleted`, variant: "success" });
      setSelected(new Set());
      refresh();
    },
    onError: (err) => toast({ title: "Delete failed", description: (err as Error).message, variant: "error" }),
  });

  const addToGroup = useMutation({
    mutationFn: (gid: string) => apiRequest("POST", "/api/groups/add-contacts", { groupId: gid, contactIds: [...selected] }),
    onSuccess: () => {
      toast({ title: "Added to group", variant: "success" });
      setBulkGroup("");
      setSelected(new Set());
      refresh();
    },
    onError: (err) => toast({ title: "Could not add to group", description: (err as Error).message, variant: "error" }),
  });

  const startChat = useMutation({
    mutationFn: (contactId: string) => apiRequest<{ data: { id: string } }>("POST", "/api/conversations", { contactId }),
    onSuccess: (r) => navigate(`/inbox?c=${r.data.id}`),
    onError: (err) => toast({ title: "Could not open conversation", description: (err as Error).message, variant: "error" }),
  });

  const rows = data?.data ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <PageContainer wide>
      <PageHeader
        title="Contacts"
        description={data ? `${formatNumber(data.total)} contacts on ${activeChannel!.name}` : undefined}
        actions={
          <>
            {can("contacts:export") && (
              <Button variant="outline" onClick={() => downloadUrl(buildUrl("/api/contacts/export", { channelId }))}>
                <Download className="h-4 w-4" /> Export
              </Button>
            )}
            {can("contacts:create") && (
              <>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  <Upload className="h-4 w-4" /> Import CSV
                </Button>
                <Button
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4" /> Add contact
                </Button>
              </>
            )}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-fg-muted" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone or email" className="pl-9" aria-label="Search contacts" />
          </div>
          <Select
            value={groupId}
            onChange={(e) => {
              setGroupId(e.target.value);
              setPage(1);
            }}
            className="w-48"
            aria-label="Filter by group"
          >
            <option value="">All groups</option>
            {groupList.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.contactCount})
              </option>
            ))}
          </Select>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-primary-soft px-3 py-1.5 text-sm">
              <span className="font-medium text-primary">{selected.size} selected</span>
              {can("groups:manage") && groupList.length > 0 && (
                <Select
                  value={bulkGroup}
                  onChange={(e) => {
                    setBulkGroup(e.target.value);
                    if (e.target.value) addToGroup.mutate(e.target.value);
                  }}
                  className="h-8 w-40 text-xs"
                  aria-label="Add selected to group"
                >
                  <option value="">Add to group…</option>
                  {groupList.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              )}
              {can("contacts:delete") && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    if (await confirm({ title: `Delete ${selected.size} contacts?`, description: "Their conversations and campaign history are removed too.", confirmText: "Delete", destructive: true })) {
                      remove.mutate([...selected]);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              )}
            </div>
          )}
        </div>

        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="p-10 text-center">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users className="h-10 w-10" />}
            title={debounced || groupId ? "No matching contacts" : "No contacts yet"}
            description={debounced || groupId ? "Try a different search or group." : "Add contacts one by one or import a CSV."}
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-10">
                    <Checkbox
                      checked={allSelected}
                      onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())}
                      label={<span className="sr-only">Select all</span>}
                    />
                  </Th>
                  <Th>Name</Th>
                  <Th>Phone</Th>
                  <Th className="hidden md:table-cell">Groups & tags</Th>
                  <Th>Status</Th>
                  <Th className="hidden lg:table-cell">Added</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <Tr key={c.id}>
                    <Td>
                      <Checkbox
                        checked={selected.has(c.id)}
                        onChange={(v) =>
                          setSelected((s) => {
                            const n = new Set(s);
                            v ? n.add(c.id) : n.delete(c.id);
                            return n;
                          })
                        }
                        label={<span className="sr-only">Select {c.name}</span>}
                      />
                    </Td>
                    <Td>
                      <p className="font-medium">{c.name}</p>
                      {c.email && <p className="text-xs text-fg-muted">{c.email}</p>}
                    </Td>
                    <Td className="tabular-nums">{c.phone}</Td>
                    <Td className="hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {(c.groups ?? []).map((g) => groupName(g) && <Badge key={g} tone="primary">{groupName(g)}</Badge>)}
                        {(c.tags ?? []).map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    </Td>
                    <Td>
                      <StatusBadge status={c.status} />
                    </Td>
                    <Td className="hidden text-fg-muted lg:table-cell">{formatDay(c.createdAt)}</Td>
                    <Td className="text-right whitespace-nowrap">
                      {can("inbox:send") && (
                        <Button size="icon" variant="ghost" onClick={() => startChat.mutate(c.id)} aria-label={`Message ${c.name}`}>
                          <MessageSquare className="h-4 w-4" />
                        </Button>
                      )}
                      {can("contacts:edit") && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            setEditing(c);
                            setDialogOpen(true);
                          }}
                          aria-label={`Edit ${c.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {can("contacts:delete") && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={async () => {
                            if (await confirm({ title: `Delete ${c.name}?`, confirmText: "Delete", destructive: true })) remove.mutate([c.id]);
                          }}
                          aria-label={`Delete ${c.name}`}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} limit={limit} total={data!.total} onPage={setPage} />
          </>
        )}
      </Card>

      <ContactDialog open={dialogOpen} onClose={() => setDialogOpen(false)} contact={editing} groups={groupList} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} groups={groupList} />
    </PageContainer>
  );
}
