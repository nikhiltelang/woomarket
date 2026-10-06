import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { FileText, Plus, RefreshCw, Trash2, Pencil } from "lucide-react";
import { templateSchema } from "@shared/validation";
import type { Template } from "@shared/schema";
import { useChannel } from "@/contexts/channel";
import { useAuth } from "@/contexts/auth";
import { useSocketEvent } from "@/contexts/socket";
import { apiRequest, queryClient } from "@/lib/api";
import { formatDay, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Badge, Card, EmptyState, PageHeader, PageLoader, StatusBadge } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

type TemplateForm = z.input<typeof templateSchema>;

export function TemplatePreview({ header, body, footer, buttons }: { header?: string | null; body: string; footer?: string | null; buttons?: { text: string }[] }) {
  return (
    <div className="rounded-lg bg-[#efeae2] p-4 dark:bg-subtle">
      <div className="max-w-xs rounded-lg bg-bubble-in p-3 text-sm shadow-sm">
        {header && <p className="mb-1 font-semibold">{header}</p>}
        <p className="break-words whitespace-pre-wrap">
          {body.split(/(\{\{\s*\d+\s*\}\})/g).map((part, i) =>
            /^\{\{/.test(part) ? (
              <span key={i} className="rounded bg-info-soft px-1 text-info">
                {part}
              </span>
            ) : (
              part
            ),
          ) || <span className="text-fg-muted">Message body…</span>}
        </p>
        {footer && <p className="mt-2 text-xs text-fg-muted">{footer}</p>}
      </div>
      {!!buttons?.length && (
        <div className="mt-1 flex max-w-xs flex-col gap-1">
          {buttons.map((b, i) => (
            <div key={i} className="rounded-lg bg-bubble-in py-2 text-center text-sm font-medium text-info shadow-sm">
              {b.text || "Button"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateDialog({ open, onClose, template }: { open: boolean; onClose: () => void; template: Template | null }) {
  const { activeChannel } = useChannel();
  const toast = useToast();
  const form = useForm<TemplateForm>({ resolver: zodResolver(templateSchema) });
  const buttons = useFieldArray({ control: form.control, name: "buttons" });

  useEffect(() => {
    if (!open) return;
    form.reset({
      name: template?.name ?? "",
      category: (template?.category as TemplateForm["category"]) ?? "MARKETING",
      language: template?.language ?? "en_US",
      header: template?.header ?? "",
      body: template?.body ?? "",
      footer: template?.footer ?? "",
      buttons: (template?.buttons ?? []).map((b) => ({ type: b.type, text: b.text, url: b.url })),
    });
  }, [open, template]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (v: TemplateForm) => {
      const body = { ...v, header: v.header || null, footer: v.footer || null };
      return template
        ? apiRequest<{ data: Template }>("PUT", `/api/templates/${template.id}`, body)
        : apiRequest<{ data: Template }>("POST", "/api/templates", { ...body, channelId: activeChannel!.id });
    },
    onSuccess: (r) => {
      const t = r.data;
      if (t.status === "draft" && t.rejectionReason) {
        toast({ title: "Saved, but WhatsApp rejected the submission", description: t.rejectionReason, variant: "warning" });
      } else {
        toast({ title: "Template submitted for approval", description: "Meta usually reviews templates within minutes.", variant: "success" });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
      onClose();
    },
    onError: (err) => toast({ title: "Could not save template", description: (err as Error).message, variant: "error" }),
  });

  const values = form.watch();
  const errors = form.formState.errors;
  const addVariable = () => {
    const body = values.body ?? "";
    const next = new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))).size + 1;
    form.setValue("body", `${body}{{${next}}}`, { shouldValidate: true });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={template ? "Edit template" : "New message template"}
      description="Templates must be approved by Meta before they can be used in campaigns or outside the 24-hour window."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={form.handleSubmit((v) => save.mutate(v))} loading={save.isPending}>
            Submit for approval
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="t-name" error={errors.name?.message} className="sm:col-span-3" hint="e.g. order_update — lowercase and underscores">
              <Input id="t-name" {...form.register("name")} invalid={!!errors.name} />
            </Field>
            <Field label="Category" htmlFor="t-cat">
              <Select id="t-cat" {...form.register("category")}>
                <option value="MARKETING">Marketing</option>
                <option value="UTILITY">Utility</option>
                <option value="AUTHENTICATION">Authentication</option>
              </Select>
            </Field>
            <Field label="Language" htmlFor="t-lang" error={errors.language?.message}>
              <Select id="t-lang" {...form.register("language")}>
                {["en_US", "en_GB", "es", "pt_BR", "fr", "de", "it", "hi", "ar", "id"].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Header (optional)" htmlFor="t-header" error={errors.header?.message}>
            <Input id="t-header" maxLength={60} {...form.register("header")} />
          </Field>
          <Field
            label={
              <span className="flex items-center justify-between">
                Body
                <button type="button" onClick={addVariable} className="text-xs font-medium text-primary hover:underline">
                  + Add variable
                </button>
              </span>
            }
            htmlFor="t-body"
            error={errors.body?.message}
            hint="Use {{1}}, {{2}}… for personalised values filled in when sending."
          >
            <Textarea id="t-body" rows={6} maxLength={1024} {...form.register("body")} invalid={!!errors.body} />
          </Field>
          <Field label="Footer (optional)" htmlFor="t-footer" error={errors.footer?.message}>
            <Input id="t-footer" maxLength={60} {...form.register("footer")} />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Buttons (optional)</legend>
            {buttons.fields.map((f, i) => (
              <div key={f.id} className="flex flex-wrap gap-2">
                <Select className="w-36" {...form.register(`buttons.${i}.type`)} aria-label="Button type">
                  <option value="QUICK_REPLY">Quick reply</option>
                  <option value="URL">Website</option>
                </Select>
                <Input className="min-w-32 flex-1" placeholder="Button text" maxLength={25} {...form.register(`buttons.${i}.text`)} aria-label="Button text" />
                {values.buttons?.[i]?.type === "URL" && (
                  <Input className="min-w-40 flex-1" placeholder="https://…" {...form.register(`buttons.${i}.url`)} aria-label="Button URL" />
                )}
                <Button variant="ghost" size="icon" onClick={() => buttons.remove(i)} aria-label="Remove button">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {buttons.fields.length < 3 && (
              <Button variant="outline" size="sm" className="self-start" onClick={() => buttons.append({ type: "QUICK_REPLY", text: "" })}>
                <Plus className="h-3.5 w-3.5" /> Add button
              </Button>
            )}
          </fieldset>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Preview</p>
          <TemplatePreview header={values.header} body={values.body ?? ""} footer={values.footer} buttons={values.buttons} />
        </div>
      </div>
    </Dialog>
  );
}

export default function TemplatesPage() {
  const { activeChannel } = useChannel();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [preview, setPreview] = useState<Template | null>(null);
  const channelId = activeChannel!.id;
  const { data, isLoading } = useQuery<{ data: Template[] }>({ queryKey: ["/api/templates", { channelId }] });

  useSocketEvent("template_updated", () => void queryClient.invalidateQueries({ queryKey: ["/api/templates"] }));

  const sync = useMutation({
    mutationFn: () => apiRequest<{ total: number; created: number; updated: number }>("POST", "/api/templates/sync", { channelId }),
    onSuccess: (r) => {
      toast({ title: "Templates synced", description: `${r.total} from WhatsApp · ${r.created} new · ${r.updated} updated`, variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
    },
    onError: (err) => toast({ title: "Sync failed", description: (err as Error).message, variant: "error" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/templates/${id}`),
    onSuccess: () => {
      toast({ title: "Template deleted", variant: "success" });
      void queryClient.invalidateQueries({ queryKey: ["/api/templates"] });
    },
    onError: (err) => toast({ title: "Delete failed", description: (err as Error).message, variant: "error" }),
  });

  if (isLoading) return <PageLoader />;
  const rows = data?.data ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Message templates"
        description="Pre-approved messages for campaigns and for starting conversations."
        actions={
          <>
            {can("templates:sync") && (
              <Button variant="outline" onClick={() => sync.mutate()} loading={sync.isPending}>
                <RefreshCw className="h-4 w-4" /> Sync from WhatsApp
              </Button>
            )}
            {can("templates:create") && (
              <Button
                onClick={() => {
                  setEditing(null);
                  setOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> New template
              </Button>
            )}
          </>
        }
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState icon={<FileText className="h-10 w-10" />} title="No templates yet" description="Create a template or sync existing ones from your WhatsApp Business account." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Category</Th>
                <Th>Language</Th>
                <Th>Status</Th>
                <Th className="text-right">Used</Th>
                <Th className="hidden md:table-cell">Created</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <Tr key={t.id} onClick={() => setPreview(t)}>
                  <Td>
                    <p className="font-medium">{t.name}</p>
                    <p className="max-w-md truncate text-xs text-fg-muted">{t.body}</p>
                  </Td>
                  <Td>
                    <Badge>{t.category.toLowerCase()}</Badge>
                  </Td>
                  <Td className="text-fg-muted">{t.language}</Td>
                  <Td>
                    <StatusBadge status={t.status} />
                    {t.rejectionReason && <p className="mt-1 max-w-48 truncate text-xs text-danger" title={t.rejectionReason}>{t.rejectionReason}</p>}
                  </Td>
                  <Td className="text-right tabular-nums">{formatNumber(t.usageCount)}</Td>
                  <Td className="hidden text-fg-muted md:table-cell">{formatDay(t.createdAt)}</Td>
                  <Td className="text-right whitespace-nowrap" >
                    <span onClick={(e) => e.stopPropagation()}>
                      {can("templates:edit") && ["draft", "rejected"].includes(t.status ?? "") && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Edit ${t.name}`}
                          onClick={() => {
                            setEditing(t);
                            setOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {can("templates:delete") && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${t.name}`}
                          onClick={async () => {
                            if (await confirm({ title: `Delete template "${t.name}"?`, description: "It is also deleted from your WhatsApp Business account.", confirmText: "Delete", destructive: true })) {
                              remove.mutate(t.id);
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <TemplateDialog open={open} onClose={() => setOpen(false)} template={editing} />
      <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.name} description={preview ? `${preview.category} · ${preview.language}` : undefined}>
        {preview && <TemplatePreview header={preview.header} body={preview.body} footer={preview.footer} buttons={preview.buttons ?? []} />}
      </Dialog>
    </PageContainer>
  );
}
