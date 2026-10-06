import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, History, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { UPDATE_STEPS, type UpdateEvent, type UpdateStatus, type UpdateStep } from "@shared/api-types";
import { apiRequest, queryClient } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import { PageContainer } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, PageHeader, PageLoader, ProgressBar, StatusBadge } from "@/components/ui/display";
import { useConfirm, useToast } from "@/components/ui/overlay";

const STEP_LABELS: Record<UpdateStep, string> = {
  backup: "Back up current version",
  replace: "Replace application files",
  dependencies: "Install dependencies",
  build: "Build application",
  database: "Update database schema",
  restart: "Restart application",
  complete: "Complete",
};
const STATUS_KEY = ["/api/app-update/status"];

function LogLine({ e }: { e: UpdateEvent }) {
  const color = e.status === "error" ? "text-red-400" : e.status === "warning" ? "text-yellow-300" : e.status === "done" ? "text-emerald-300" : "text-slate-300";
  return (
    <div>
      <span className={color}>
        [{new Date(e.at).toLocaleTimeString()}] {e.step}:{e.status}
      </span>{" "}
      <span className="text-slate-200">{e.message}</span>
    </div>
  );
}

export default function AppUpdatePage() {
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [events, setEvents] = useState<UpdateEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const { data: status, isLoading } = useQuery<UpdateStatus>({ queryKey: STATUS_KEY, refetchInterval: streaming ? false : 10_000 });

  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append("file", file!);
      return apiRequest<{ newVersion: string; message: string }>("POST", "/api/app-update/upload", fd);
    },
    onSuccess: (r) => {
      toast({ title: `Version ${r.newVersion} ready to install`, variant: "success" });
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    },
    onError: (err) => toast({ title: "Upload rejected", description: (err as Error).message, variant: "error" }),
  });

  const rollback = useMutation({
    mutationFn: () => apiRequest<{ restoredVersion: string; warnings: string[]; message: string }>("POST", "/api/app-update/rollback"),
    onSuccess: (r) => {
      toast({ title: `Rolled back to v${r.restoredVersion}`, description: r.message, variant: "success" });
      r.warnings.forEach((w) => toast({ title: "Rollback warning", description: w, variant: "warning" }));
    },
    onError: (err) => toast({ title: "Rollback failed", description: (err as Error).message, variant: "error" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
  });

  async function applyUpdate() {
    const target = status?.pendingUpload?.newVersion;
    if (!(await confirm({ title: `Apply update to v${target}?`, description: "The application is backed up, its files replaced, dependencies reinstalled, rebuilt, the database schema updated, and the process restarted. Failures roll back automatically.", confirmText: "Apply update" }))) return;
    setStreaming(true);
    setEvents([]);
    let final: UpdateEvent | null = null;
    try {
      const csrf = (await apiRequest<{ csrfToken: string }>("GET", "/api/csrf-token")).csrfToken;
      const res = await fetch("/api/app-update/execute", { method: "POST", headers: { "X-CSRF-Token": csrf }, credentials: "include" });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const e = JSON.parse(line.slice(5).trim()) as UpdateEvent;
          setEvents((prev) => [...prev, e]);
          if ((e.step === "complete" && e.status === "done") || e.status === "error" || (e.step === "rollback" && e.status !== "running")) final = e;
        }
      }
      if (!final) toast({ title: "Connection closed before the update reported a result", description: "The server may be restarting — refresh in a moment.", variant: "warning" });
      else if (final.step === "complete") toast({ title: "Update complete", description: final.message, variant: "success" });
      else toast({ title: final.step === "rollback" && final.status === "done" ? "Update failed and was rolled back" : "Update failed", description: final.message, variant: "error" });
    } catch (err) {
      toast({ title: "Could not start update", description: (err as Error).message, variant: "error" });
    } finally {
      setStreaming(false);
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    }
  }

  if (isLoading || !status) return <PageLoader />;

  // Show the live stream while running; otherwise hydrate from the last persisted run.
  const shown = events.length ? events : (status.lastRun?.events ?? []);
  const stepState: Partial<Record<UpdateStep, UpdateEvent["status"]>> = {};
  for (const e of shown) if ((UPDATE_STEPS as readonly string[]).includes(e.step)) stepState[e.step as UpdateStep] = e.status;
  const lastProgress = [...shown].reverse().find((e) => e.progress !== undefined)?.progress ?? 0;
  const failed = shown.some((e) => e.status === "error");
  const busy = streaming || status.updateInProgress;

  return (
    <PageContainer>
      <PageHeader title="Application Update" description="Upload a release ZIP built with npm run build:prod-zip and apply it in place." />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Current version</p>
          <p className="mt-2 text-2xl font-semibold">v{status.currentVersion}</p>
          <p className="mt-1 text-xs text-fg-muted">{busy ? <Badge tone="info">{status.lockKind ?? "update"} in progress</Badge> : "No update in progress"}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Backup status</p>
          {status.backup ? (
            <>
              <p className="mt-2 text-sm">
                <strong>Backup available:</strong> v{status.backup.version}
              </p>
              <p className="text-xs text-fg-muted">Created {formatDate(status.backup.createdAt)}</p>
            </>
          ) : (
            <p className="mt-2 text-sm text-fg-muted">No backup available</p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={!status.backup || busy}
            loading={rollback.isPending}
            onClick={async () => {
              if (await confirm({ title: `Roll back to v${status.backup?.version}?`, description: "The current version is replaced by the backup and dependencies are reinstalled.", confirmText: "Roll back", destructive: true })) {
                rollback.mutate();
              }
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Rollback to Previous Version
          </Button>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Upload release</p>
          <input ref={fileRef} type="file" accept=".zip,application/zip" className="mt-3 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-subtle file:px-3 file:py-1.5 file:text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Release ZIP" />
          <Button size="sm" className="mt-3" onClick={() => upload.mutate()} loading={upload.isPending} disabled={!file || busy}>
            <Upload className="h-3.5 w-3.5" /> Upload
          </Button>
        </Card>
      </div>

      {status.pendingUpload && (
        <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm">
            <Badge tone="success">Version {status.pendingUpload.newVersion} ready to install</Badge>
            <span className="ml-2 text-fg-muted">
              {status.pendingUpload.originalName} · uploaded {formatDate(status.pendingUpload.uploadedAt)}
            </span>
          </p>
          <Button onClick={applyUpdate} disabled={busy} loading={streaming}>
            Apply Update
          </Button>
        </Card>
      )}

      <p className="mt-4 flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Never upload GitHub's “Download ZIP”. Applying an update deletes node_modules, rebuilds, force-pushes the schema and restarts the process — test on a disposable instance first.
      </p>

      <Card className="mt-6">
        <CardHeader
          title={events.length ? "Progress" : "Previous update log"}
          description={
            !events.length && status.lastRun
              ? `v${status.lastRun.fromVersion} → v${status.lastRun.toVersion} · ${status.lastRun.triggeredByUsername ?? "unknown"} · ${formatDate(status.lastRun.startedAt)}`
              : undefined
          }
          actions={!events.length && status.lastRun && <StatusBadge status={status.lastRun.status} />}
        />
        {shown.length === 0 ? (
          <p className="flex items-center gap-2 p-5 text-sm text-fg-muted">
            <History className="h-4 w-4" /> No update has been run yet.
          </p>
        ) : (
          <div className="p-5">
            <ProgressBar value={lastProgress} tone={failed ? "danger" : lastProgress === 100 ? "success" : "primary"} />
            <ol className="mt-4 grid gap-2 sm:grid-cols-2">
              {UPDATE_STEPS.map((s) => {
                const st = stepState[s];
                return (
                  <li key={s} className={cn("flex items-center gap-2 text-sm", !st && "text-fg-muted", st === "error" && "text-danger")}>
                    <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border", st === "done" && "border-success bg-success text-white", st === "error" && "border-danger bg-danger text-white", st === "warning" && "border-warning bg-warning text-white", !st && "border-border")}>
                      {st === "done" ? <Check className="h-3 w-3" /> : st === "error" ? <X className="h-3 w-3" /> : st === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : st === "warning" ? "!" : null}
                    </span>
                    {STEP_LABELS[s]}
                  </li>
                );
              })}
            </ol>
            <pre className="mt-4 max-h-80 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {shown.map((e, i) => (
                <LogLine key={i} e={e} />
              ))}
            </pre>
            {!events.length && status.lastRun?.finalMessage && <p className="mt-3 text-sm text-fg-muted">{status.lastRun.finalMessage}</p>}
          </div>
        )}
      </Card>
    </PageContainer>
  );
}
