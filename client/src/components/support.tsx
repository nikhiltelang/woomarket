import { Bug, Headset } from "lucide-react";
import { Badge, StatusBadge } from "@/components/ui/display";

export type SupportType = "bug" | "support";

export const SUPPORT_TYPES: Record<SupportType, { label: string; action: string; icon: typeof Bug; tone: "warning" | "success"; button: string }> = {
  bug: { label: "Bug report", action: "Report a bug", icon: Bug, tone: "warning", button: "border-warning text-warning hover:bg-warning-soft" },
  support: { label: "Support request", action: "Request for support", icon: Headset, tone: "success", button: "border-success text-success hover:bg-success-soft" },
};

export const SUPPORT_STATUS_LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };

export function SupportTypeBadge({ type }: { type: string }) {
  const t = SUPPORT_TYPES[type as SupportType] ?? SUPPORT_TYPES.support;
  const Icon = t.icon;
  return (
    <Badge tone={t.tone}>
      <Icon className="h-3 w-3" /> {t.label}
    </Badge>
  );
}

export function SupportStatusBadge({ status }: { status: string }) {
  if (status === "in_progress") return <Badge tone="warning">In progress</Badge>;
  if (status === "resolved") return <Badge tone="success">Resolved</Badge>;
  return <StatusBadge status={status} />;
}
