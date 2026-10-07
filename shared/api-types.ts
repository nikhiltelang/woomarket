/** Response shapes shared by the API and the React client. */
import type { Role } from "./roles";

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: Role;
  status: string;
  permissions: string[];
  phone: string | null;
  avatar: string | null;
  createdBy: string | null;
  lastLogin: string | null;
  createdAt: string | null;
  isEmailVerified: boolean;
  isMobileVerified: boolean;
  accessLevel: number | null;
  twoFactorEnabled: boolean;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ApiErrorBody {
  success: false;
  message: string;
  code?: string;
  details?: unknown;
}

/** Channel as returned by the API: the access token is never exposed. */
export interface PublicChannel {
  id: string;
  name: string;
  phoneNumberId: string;
  phoneNumber: string | null;
  whatsappBusinessAccountId: string | null;
  isActive: boolean;
  healthStatus: string | null;
  healthDetails: Record<string, unknown>;
  lastHealthCheck: string | null;
  connectionMethod: string;
  createdBy: string | null;
  createdAt: string | null;
  tokenPreview: string;
}

export const UPDATE_STEPS = ["backup", "replace", "dependencies", "build", "database", "restart", "complete"] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];

export interface UpdateEvent {
  step: UpdateStep | "rollback" | "error";
  status: "running" | "done" | "warning" | "error";
  message: string;
  progress?: number;
  at: string;
  version?: string;
}

export interface UpdateRunView {
  id: string;
  status: "running" | "success" | "failed" | "interrupted";
  fromVersion: string | null;
  toVersion: string | null;
  triggeredByUsername: string | null;
  finalMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  events: UpdateEvent[];
}

export interface UpdateStatus {
  currentVersion: string;
  backup: { version: string; createdAt: string | null } | null;
  updateInProgress: boolean;
  lockKind: string | null;
  pendingUpload: { newVersion: string; originalName: string; uploadedAt: string } | null;
  lastRun: UpdateRunView | null;
}
