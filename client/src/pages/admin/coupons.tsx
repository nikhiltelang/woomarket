import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Info, Pencil, Plus, Search, TicketPercent, Trash2 } from "lucide-react";
import type { Paginated } from "@shared/api-types";
import type { Coupon } from "@shared/schema";
import { usePlatform } from "@/contexts/platform";
import { apiRequest, fieldErrors, queryClient } from "@/lib/api";
import { formatDay, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch } from "@/components/ui/form";
import { Badge, Card, EmptyState, ErrorState, PageHeader, Spinner } from "@/components/ui/display";
import { Pagination, Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, useConfirm, useToast } from "@/components/ui/overlay";

const KEY = "/api/superadmin/coupons";
const invalidate = () => void queryClient.invalidateQueries({ queryKey: [KEY] });

interface FormState {
  name: string;
  code: string;
  type: "fixed" | "percent";
  discountValue: string;
  expiryType: "lifetime" | "date";
  /** yyyy-mm-dd in the admin's local time. */
  expiresOn: string;
  usageLimit: string;
  status: boolean;
}

const blank: FormState = { name: "", code: "", type: "fixed", discountValue: "", expiryType: "lifetime", expiresOn: "", usageLimit: "-1", status: true };

const toLocalDay = (d: string | Date) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

const isExpired = (c: Coupon) => c.expiryType === "date" && c.expiresAt !== null && new Date(c.expiresAt) <= new Date();

function CouponDialog({ coupon, open, onClose }: { coupon: Coupon | null; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { config } = usePlatform();
  const [v, setV] = useState<FormState>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setV(
      coupon
        ? {
            name: coupon.name,
            code: coupon.code,
            type: coupon.type as FormState["type"],
            discountValue: String(Number(coupon.discountValue)),
            expiryType: coupon.expiryType as FormState["expiryType"],
            expiresOn: coupon.expiresAt ? toLocalDay(coupon.expiresAt) : "",
            usageLimit: String(coupon.usageLimit),
            status: coupon.status,
          }
        : blank,
    );
  }, [open, coupon]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: v.name,
        code: v.code,
        type: v.type,
        discountValue: v.discountValue,
        expiryType: v.expiryType,
        // Valid through the end of the chosen day, in the admin's time zone.
        expiresAt: v.expiryType === "date" && v.expiresOn ? new Date(`${v.expiresOn}T23:59:59.999`).toISOString() : null,
        usageLimit: v.usageLimit,
        status: v.status,
      };
      return coupon ? apiRequest("PUT", `${KEY}/${coupon.id}`, body) : apiRequest("POST", KEY, body);
    },
    onSuccess: () => {
      toast({ title: coupon ? "Coupon updated" : "Coupon created", variant: "success" });
      invalidate();
      onClose();
    },
    onError: (err) => {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (!Object.keys(fe).length) toast({ title: "Could not save coupon", description: (err as Error).message, variant: "error" });
    },
  });

  const set = <K extends keyof FormState>(k: K) => (value: FormState[K]) => setV((s) => ({ ...s, [k]: value }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={coupon ? "Edit coupon" : "Add new coupon"}
      footer={
        <Button className="w-full" onClick={() => save.mutate()} loading={save.isPending}>
          Submit
        </Button>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name" htmlFor="cp-name" required error={errors.name}>
          <Input id="cp-name" value={v.name} placeholder="Enter coupon name" onChange={(e) => set("name")(e.target.value)} invalid={Boolean(errors.name)} />
        </Field>
        <Field label="Code" htmlFor="cp-code" required error={errors.code} hint="Customers enter this; letters, digits, - and _.">
          <Input
            id="cp-code"
            value={v.code}
            placeholder="Enter code"
            className="w-full font-mono uppercase"
            onChange={(e) => set("code")(e.target.value.toUpperCase().replace(/\s/g, ""))}
            invalid={Boolean(errors.code)}
          />
        </Field>
        <Field label="Type" htmlFor="cp-type" required>
          <Select id="cp-type" value={v.type} onChange={(e) => set("type")(e.target.value as FormState["type"])}>
            <option value="fixed">Fixed</option>
            <option value="percent">Percentage</option>
          </Select>
        </Field>
        <Field label="Discount value" htmlFor="cp-value" required error={errors.discountValue}>
          <div className="flex">
            <Input
              id="cp-value"
              type="number"
              min={0}
              step="0.01"
              value={v.discountValue}
              placeholder="Enter discount value"
              className="flex-1 rounded-r-none"
              onChange={(e) => set("discountValue")(e.target.value)}
              invalid={Boolean(errors.discountValue)}
            />
            <span className="inline-flex h-9 items-center rounded-r-md border border-l-0 border-border bg-subtle px-3 text-sm">
              {v.type === "percent" ? "%" : (config?.currency ?? "USD")}
            </span>
          </div>
        </Field>
        <Field label="Expiry type" htmlFor="cp-expiry" required>
          <Select id="cp-expiry" value={v.expiryType} onChange={(e) => set("expiryType")(e.target.value as FormState["expiryType"])}>
            <option value="lifetime">Lifetime</option>
            <option value="date">Until a date</option>
          </Select>
        </Field>
        {v.expiryType === "date" && (
          <Field label="Expires after" htmlFor="cp-date" required error={errors.expiresAt}>
            <Input id="cp-date" type="date" value={v.expiresOn} onChange={(e) => set("expiresOn")(e.target.value)} invalid={Boolean(errors.expiresAt)} />
          </Field>
        )}
        <Field label="Usage limit" htmlFor="cp-limit" required error={errors.usageLimit}>
          <Input id="cp-limit" type="number" min={-1} step={1} value={v.usageLimit} onChange={(e) => set("usageLimit")(e.target.value)} invalid={Boolean(errors.usageLimit)} />
          <p className="mt-1 flex items-center gap-1 text-xs text-info">
            <Info className="h-3.5 w-3.5" /> Enter -1 for unlimited usage
          </p>
        </Field>
        <Switch checked={v.status} onChange={set("status")} label="Active" description="Inactive coupons can't be applied." />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export default function CouponsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { config } = usePlatform();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [open, setOpen] = useState(false);
  const limit = config?.recordsPerPage ?? 20;
  const { data, isLoading, error, refetch } = useQuery<Paginated<Coupon>>({ queryKey: [KEY, { page, limit, search: query }] });

  const fail = (title: string) => (err: unknown) => toast({ title, description: (err as Error).message, variant: "error" });
  const toggle = useMutation({ mutationFn: (id: number) => apiRequest("PUT", `${KEY}/${id}/status`), onSuccess: invalidate, onError: fail("Could not change status") });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${KEY}/${id}`),
    onSuccess: () => {
      toast({ title: "Coupon deleted", variant: "success" });
      invalidate();
    },
    onError: fail("Could not delete coupon"),
  });

  const symbol = config?.currencySymbol ?? "$";
  const discountText = (c: Coupon) => (c.type === "percent" ? `${Number(c.discountValue)}%` : `${symbol}${Number(c.discountValue).toFixed(2)}`);

  return (
    <PageContainer wide>
      <PageHeader
        title="All coupons"
        description="Discount codes applied when you assign a plan to a tenant."
        actions={
          <>
            <form
              className="flex"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                setPage(1);
                setQuery(search.trim());
              }}
            >
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name / Code" className="w-48 rounded-r-none" aria-label="Search coupons" />
              <Button type="submit" className="rounded-l-none" aria-label="Search"><Search className="h-4 w-4" /></Button>
            </form>
            <Button variant="outline" className="border-primary text-primary" onClick={() => { setEditing(null); setOpen(true); }}>
              <Plus className="h-4 w-4" /> Add new
            </Button>
          </>
        }
      />
      <Card className="overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="p-10 text-center"><Spinner /></div>
        ) : !data?.data.length ? (
          <EmptyState
            icon={<TicketPercent className="h-10 w-10" />}
            title={query ? "No matching coupons" : "No coupons yet"}
            description={query ? "Try another name or code." : "Create a code to discount a plan when you assign it."}
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr className="[&>th]:bg-primary [&>th]:text-primary-fg">
                  <Th>S.N.</Th>
                  <Th>Name</Th>
                  <Th>Code</Th>
                  <Th>Discount</Th>
                  <Th className="hidden md:table-cell">Expiry</Th>
                  <Th>Uses left</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Action</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((c, i) => {
                  const expired = isExpired(c);
                  const left = c.usageLimit === -1 ? null : Math.max(0, c.usageLimit - c.usedCount);
                  return (
                    <Tr key={c.id}>
                      <Td className="text-fg-muted tabular-nums">{(page - 1) * limit + i + 1}</Td>
                      <Td className="font-medium">{c.name}</Td>
                      <Td><code className="rounded bg-subtle px-1.5 py-0.5 text-xs">{c.code}</code></Td>
                      <Td className="tabular-nums">{discountText(c)}</Td>
                      <Td className="hidden md:table-cell">
                        {c.expiryType === "lifetime" ? "Lifetime" : (
                          <span className={expired ? "text-danger" : undefined}>{expired ? "Expired " : "Until "}{formatDay(c.expiresAt)}</span>
                        )}
                      </Td>
                      <Td className="tabular-nums">
                        {left === null ? "Unlimited" : formatNumber(left)}
                        <span className="block text-xs text-fg-muted">{formatNumber(c.usedCount)} used</span>
                      </Td>
                      <Td>
                        <button onClick={() => toggle.mutate(c.id)} aria-label={`${c.status ? "Deactivate" : "Activate"} ${c.code}`} title="Click to toggle">
                          {c.status ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                        </button>
                      </Td>
                      <Td className="text-right whitespace-nowrap">
                        <Button size="icon" variant="ghost" aria-label={`Edit ${c.code}`} onClick={() => { setEditing(c); setOpen(true); }}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${c.code}`}
                          onClick={async () => {
                            if (await confirm({ title: `Delete coupon ${c.code}?`, description: "Subscriptions that used it keep their discount.", confirmText: "Delete", destructive: true })) remove.mutate(c.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <Pagination page={page} limit={limit} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <CouponDialog coupon={editing} open={open} onClose={() => setOpen(false)} />
    </PageContainer>
  );
}
