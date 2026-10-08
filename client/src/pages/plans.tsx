import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, CreditCard, Download, Receipt, Tag } from "lucide-react";
import { PROVIDER_LABELS, formatMoney, type BillingCycle, type BillingQuote, type PaymentProvider, type PublicBillingConfig } from "@shared/billing";
import type { Plan, Subscription } from "@shared/schema";
import { useAuth } from "@/contexts/auth";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate, formatDay, formatNumber } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { Badge, Card, CardHeader, PageHeader, PageLoader } from "@/components/ui/display";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { Dialog, Tabs, useConfirm, useToast } from "@/components/ui/overlay";
import { PAYMENT_TONE, PROVIDER_NAME, type PaymentRow } from "./admin/payments";

const LIMIT_LABELS: Record<string, string> = { channel: "WhatsApp numbers", contacts: "Contacts", team: "Team members", campaign: "Campaigns" };
const limitText = (n: number | undefined) => (n === undefined || n === -1 ? "Unlimited" : n === 0 ? "Not included" : formatNumber(n));
const price = (p: Plan, cycle: BillingCycle) => Number(cycle === "annual" ? p.annualPrice : p.monthlyPrice) || 0;
const KEY = ["/api/billing"];

interface Overview {
  config: PublicBillingConfig;
  subscription: Subscription | null;
  payments: PaymentRow[];
}

export default function PlansPage() {
  const { subscription, user, refresh } = useAuth();
  const toast = useToast();
  const owner = user?.role === "admin";
  const plans = useQuery<{ data: Plan[] }>({ queryKey: ["/api/admin/plans"] });
  const billing = useQuery<{ data: Overview }>({ queryKey: KEY, enabled: owner });
  const [cycle, setCycle] = useState<BillingCycle>(subscription?.billingCycle === "annual" ? "annual" : "monthly");
  const [buying, setBuying] = useState<Plan | null>(null);
  const [checking, setChecking] = useState<string | null>(null);

  // Back from Stripe Checkout: confirm the payment (the webhook may not have arrived yet).
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const q = new URLSearchParams(location.search);
    const id = q.get("payment");
    if (!id) return;
    handled.current = true;
    history.replaceState(null, "", location.pathname);
    if (q.get("cancelled")) toast({ title: "Payment cancelled", description: "Nothing was charged." });
    else setChecking(id);
  }, [toast]);

  const done = () => {
    refresh();
    void queryClient.invalidateQueries({ queryKey: KEY });
  };

  if (plans.isLoading || (owner && billing.isLoading)) return <PageLoader />;
  const cfg = billing.data?.data.config;
  const cur = cfg?.currency ?? "USD";
  const list = plans.data?.data ?? [];
  const trial = subscription?.gatewayProvider === "trial";
  const paidSub = Number(subscription?.amount ?? 0) > 0;
  const annualSaving = (p: Plan) => Math.max(0, Math.round((1 - Number(p.annualPrice) / (Number(p.monthlyPrice) * 12 || 1)) * 100));

  return (
    <PageContainer>
      <PageHeader
        title="Plan & billing"
        description={
          subscription ? (
            <>
              You're on <b>{subscription.planData.name}</b>
              {trial ? " (free trial)" : ` (${subscription.billingCycle})`}
              {(paidSub || trial) && <> until <b>{formatDay(subscription.endDate)}</b></>}.
            </>
          ) : (
            "Your account has no active plan. Choose one below."
          )
        }
        actions={<Tabs value={cycle} onChange={setCycle} tabs={[{ value: "monthly", label: "Monthly" }, { value: "annual", label: "Yearly" }]} />}
      />
      {owner && cfg && !cfg.providers.length && <p className="mb-4 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">Online payment isn't set up on this platform yet. Contact the platform administrator to change plans.</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {list.map((p) => {
          const current = subscription?.planId === p.id;
          const amount = price(p, cycle);
          const free = Number(p.monthlyPrice) === 0 && Number(p.annualPrice) === 0;
          const label = current ? (free ? "Current plan" : trial ? "Buy this plan" : "Renew") : free ? "Switch to Free" : subscription && price(p, "monthly") > Number(list.find((x) => x.id === subscription.planId)?.monthlyPrice ?? 0) ? "Upgrade" : "Choose";
          return (
            <Card key={p.id} className={cn("flex flex-col p-6", current && "ring-2 ring-primary")}>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{p.name}</h2>
                {current ? <Badge tone="primary">{trial ? "Trial" : "Current plan"}</Badge> : p.popular ? <Badge tone="info">Popular</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-fg-muted">{p.description}</p>
              <p className="mt-4">
                <span className="text-3xl font-semibold tabular-nums">{formatMoney(amount, cur).replace(/\.00$/, "")}</span>
                <span className="text-sm text-fg-muted"> / {cycle === "annual" ? "year" : "month"}</span>
              </p>
              {cycle === "annual" && !free && annualSaving(p) > 0 && <p className="text-xs text-success">Save {annualSaving(p)}% compared with monthly</p>}
              <dl className="mt-5 space-y-1.5 text-sm">
                {Object.entries(LIMIT_LABELS).map(([k, l]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <dt className="text-fg-muted">{l}</dt>
                    <dd className="font-medium">{limitText(p.permissions?.[k])}</dd>
                  </div>
                ))}
              </dl>
              <ul className="mt-5 flex-1 space-y-1.5 border-t border-border pt-4 text-sm">
                {(p.features ?? []).map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {f}
                  </li>
                ))}
              </ul>
              {owner && cfg && (
                <Button className="mt-5" variant={current ? "outline" : "primary"} disabled={(current && free) || (!free && !cfg.providers.length)} onClick={() => setBuying(p)}>
                  {label}
                </Button>
              )}
            </Card>
          );
        })}
      </div>
      {!owner && <p className="mt-6 text-sm text-fg-muted">Only the account owner can change the plan.</p>}

      {owner && billing.data && billing.data.data.payments.length > 0 && <History rows={billing.data.data.payments} />}

      {buying && cfg && <CheckoutDialog plan={buying} cycle={cycle} cfg={cfg} hasPaidPlan={paidSub} onClose={() => setBuying(null)} onPaid={done} onPending={setChecking} />}
      {checking && <ConfirmingDialog paymentId={checking} onClose={() => setChecking(null)} onPaid={done} />}
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

type CheckoutResponse =
  | { kind: "done" }
  | { kind: "redirect"; url: string; paymentId: string }
  | { kind: "razorpay"; paymentId: string; order: { keyId: string; orderId: string; amount: number; currency: string; name: string; description: string; prefill: { name: string; email: string } } }
  | { kind: "simulate"; payment: PaymentRow };

interface RazorpayInstance {
  open(): void;
  on(ev: string, cb: (r: { error?: { description?: string } }) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (o: Record<string, unknown>) => RazorpayInstance;
  }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load Razorpay. Check that ad blockers allow checkout.razorpay.com."));
    document.body.appendChild(s);
  });
}

function CheckoutDialog({ plan, cycle, cfg, hasPaidPlan, onClose, onPaid, onPending }: { plan: Plan; cycle: BillingCycle; cfg: PublicBillingConfig; hasPaidPlan: boolean; onClose: () => void; onPaid: () => void; onPending: (id: string) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [coupon, setCoupon] = useState("");
  const [applied, setApplied] = useState<string | undefined>();
  const [provider, setProvider] = useState<PaymentProvider>(cfg.providers[0] ?? "simulator");
  const [simulating, setSimulating] = useState<PaymentRow | null>(null);
  const q = useQuery<{ data: BillingQuote }, Error>({
    queryKey: ["billing-quote", plan.id, cycle, applied ?? ""],
    queryFn: () => apiRequest("POST", "/api/billing/quote", { planId: plan.id, cycle, couponCode: applied }),
    retry: false,
  });
  // A bad coupon: show the error and fall back to the price without it.
  useEffect(() => {
    if (q.error && applied) {
      toast({ title: "Coupon not applied", description: q.error.message, variant: "error" });
      setApplied(undefined);
    }
  }, [q.error, applied, toast]);
  const quote = q.data?.data;
  const pay = useMutation({
    mutationFn: () => apiRequest<{ data: CheckoutResponse }>("POST", "/api/billing/checkout", { planId: plan.id, cycle, couponCode: applied, provider }),
    onSuccess: async (r) => {
      const d = r.data;
      if (d.kind === "done") {
        toast({ title: `You're now on ${plan.name}`, variant: "success" });
        onPaid();
        onClose();
      } else if (d.kind === "redirect") {
        window.location.assign(d.url);
      } else if (d.kind === "simulate") {
        setSimulating(d.payment);
      } else {
        try {
          await loadRazorpay();
        } catch (err) {
          toast({ title: "Could not open Razorpay", description: (err as Error).message, variant: "error" });
          return;
        }
        const rzp = new window.Razorpay!({
          key: d.order.keyId,
          amount: d.order.amount,
          currency: d.order.currency,
          name: d.order.name,
          description: d.order.description,
          order_id: d.order.orderId,
          prefill: d.order.prefill,
          handler: (resp: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
            void apiRequest("POST", `/api/billing/payments/${d.paymentId}/razorpay`, { orderId: resp.razorpay_order_id, paymentId: resp.razorpay_payment_id, signature: resp.razorpay_signature })
              .then(() => {
                toast({ title: "Payment received", description: `You're now on ${plan.name}.`, variant: "success" });
                onPaid();
                onClose();
              })
              .catch(() => {
                // The webhook may still confirm it: keep checking.
                onPending(d.paymentId);
                onClose();
              });
          },
          modal: { ondismiss: () => toast({ title: "Payment not completed", description: "You can try again any time." }) },
        });
        rzp.on("payment.failed", (e) => toast({ title: "Payment failed", description: e.error?.description, variant: "error" }));
        rzp.open();
      }
    },
    onError: (err) => toast({ title: "Could not start the payment", description: (err as Error).message, variant: "error" }),
  });
  const simulate = useMutation({
    mutationFn: (outcome: "paid" | "failed") => apiRequest<{ data: PaymentRow }>("POST", `/api/billing/payments/${simulating!.id}/simulate`, { outcome }),
    onSuccess: (r) => {
      if (r.data.status === "paid") {
        toast({ title: "Payment received", description: `You're now on ${plan.name}. Invoice ${r.data.invoiceNumber ?? ""} was emailed.`, variant: "success" });
        onPaid();
        onClose();
      } else {
        toast({ title: "Payment declined", description: r.data.failureReason ?? undefined, variant: "error" });
        setSimulating(null);
        void queryClient.invalidateQueries({ queryKey: KEY });
      }
    },
  });

  const m = (n: number) => formatMoney(n, quote?.currency ?? cfg.currency);
  const startPay = async () => {
    if (quote?.kind === "switch" && quote.total === 0 && hasPaidPlan && quote.credit === 0) {
      if (!(await confirm({ title: `Switch to ${plan.name} now?`, description: "Your current plan ends today. Time left on it isn't refunded.", confirmText: "Switch" }))) return;
    }
    pay.mutate();
  };

  if (simulating) {
    return (
      <Dialog
        open
        onClose={onClose}
        size="sm"
        title="Test payment"
        description="No payment gateway is configured on this development server."
        footer={
          <>
            <Button variant="outline" onClick={() => simulate.mutate("failed")} loading={simulate.isPending && simulate.variables === "failed"}>Decline</Button>
            <Button onClick={() => simulate.mutate("paid")} loading={simulate.isPending && simulate.variables === "paid"}><CreditCard className="h-4 w-4" /> Pay {m(simulating.total)}</Button>
          </>
        }
      >
        <p className="text-sm">{simulating.planName} plan ({simulating.billingCycle})</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={quote?.kind === "renew" ? `Renew ${plan.name}` : `${plan.name} plan`}
      footer={
        <Button onClick={() => void startPay()} loading={pay.isPending} disabled={!quote}>
          {quote && quote.total > 0 ? <><CreditCard className="h-4 w-4" /> Pay {m(quote.total)}</> : "Confirm"}
        </Button>
      }
    >
      {!quote ? (
        <PageLoader />
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <dl className="space-y-1.5">
            <div className="flex justify-between"><dt>{plan.name}, {cycle === "annual" ? "1 year" : "1 month"}</dt><dd className="tabular-nums">{m(quote.price)}</dd></div>
            {quote.discount > 0 && <div className="flex justify-between text-success"><dt>Coupon {quote.couponCode}</dt><dd className="tabular-nums">−{m(quote.discount)}</dd></div>}
            {quote.credit > 0 && <div className="flex justify-between text-success"><dt>Credit for unused time on your current plan</dt><dd className="tabular-nums">−{m(quote.credit)}</dd></div>}
            {quote.tax > 0 && <div className="flex justify-between text-fg-muted"><dt>{quote.taxLabel} ({quote.taxRate}%)</dt><dd className="tabular-nums">{m(quote.tax)}</dd></div>}
            <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{m(quote.total)}</dd></div>
          </dl>
          <p className="text-fg-muted">
            {quote.kind === "renew" ? "Your plan is extended" : "Your plan becomes active"} from <b>{formatDay(quote.startsAt)}</b> to <b>{formatDay(quote.endsAt)}</b>. It doesn't renew automatically: we'll remind you before it ends.
          </p>
          {quote.price > 0 && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setApplied(coupon.trim() || undefined);
              }}
            >
              <Field label="Coupon code" htmlFor="co-coupon" className="flex-1">
                <Input id="co-coupon" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder="WELCOME10" maxLength={40} />
              </Field>
              <Button type="submit" variant="outline" disabled={!coupon.trim()} loading={q.isFetching && Boolean(applied)}><Tag className="h-4 w-4" /> Apply</Button>
            </form>
          )}
          {quote.total > 0 && cfg.providers.length > 1 && (
            <fieldset>
              <legend className="mb-2 font-medium">Pay with</legend>
              <div className="flex flex-col gap-2">
                {cfg.providers.map((p) => (
                  <label key={p} className={cn("flex cursor-pointer items-center gap-2 rounded-md border p-3", provider === p ? "border-primary bg-primary/5" : "border-border")}>
                    <input type="radio" name="provider" value={p} checked={provider === p} onChange={() => setProvider(p)} />
                    {PROVIDER_LABELS[p]}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Polls a payment after returning from the gateway, until it's settled. */
function ConfirmingDialog({ paymentId, onClose, onPaid }: { paymentId: string; onClose: () => void; onPaid: () => void }) {
  const toast = useToast();
  // Each fetch also asks the gateway, in case its webhook hasn't arrived yet.
  const p = useQuery<{ data: PaymentRow }>({ queryKey: [`/api/billing/payments/${paymentId}`], refetchInterval: (q) => (q.state.data?.data.status === "pending" && q.state.dataUpdateCount < 15 ? 2000 : false) });
  const status = p.data?.data.status;
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (p.dataUpdatedAt) setTries((n) => n + 1);
  }, [p.dataUpdatedAt]);
  useEffect(() => {
    if (status === "paid") {
      toast({ title: "Payment received", description: `You're now on ${p.data!.data.planName}.`, variant: "success" });
      onPaid();
      onClose();
    }
  }, [status, toast, onPaid, onClose, p.data]);
  return (
    <Dialog open onClose={onClose} size="sm" title={status === "failed" ? "Payment failed" : status === "expired" ? "Payment not completed" : "Confirming your payment…"} footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <p className="text-sm text-fg-muted">
        {status === "failed" ? p.data?.data.failureReason ?? "The payment didn't go through. Nothing was charged." : status === "expired" ? "The checkout expired before it was paid." : tries >= 15 ? "This is taking longer than usual. Your plan updates as soon as the payment is confirmed; you'll also get an email." : "This usually takes a few seconds."}
      </p>
    </Dialog>
  );
}

function History({ rows }: { rows: PaymentRow[] }) {
  return (
    <Card className="mt-8">
      <CardHeader title={<span className="flex items-center gap-2"><Receipt className="h-4 w-4" /> Payments & invoices</span>} />
      <div className="overflow-x-auto">
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Plan</Th>
              <Th>Paid with</Th>
              <Th>Status</Th>
              <Th className="text-right">Total</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Tr key={p.id}>
                <Td className="text-xs text-fg-muted">{formatDate(p.paidAt ?? p.createdAt)}</Td>
                <Td>{p.planName} <span className="text-xs text-fg-muted">({p.billingCycle})</span></Td>
                <Td className="text-sm">{PROVIDER_NAME[p.provider] ?? p.provider}</Td>
                <Td><Badge tone={PAYMENT_TONE[p.status]}>{p.status === "expired" ? "not completed" : p.status}</Badge></Td>
                <Td className="text-right tabular-nums">{formatMoney(p.total, p.currency)}</Td>
                <Td className="text-right">
                  {p.invoiceNumber && (
                    <a href={`/api/billing/payments/${p.id}/invoice`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <Download className="h-3.5 w-3.5" /> {p.invoiceNumber}
                    </a>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}
