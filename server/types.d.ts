import type { Channel } from "@shared/schema";
import type { Role } from "@shared/roles";

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: Role;
  permissions: string[];
  createdBy: string | null;
  /** Tenant owner id: the admin's own id, a team member's admin, null for superadmins. */
  tenantId: string | null;
  twoFactorEnabled: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      authMethod?: "session" | "bearer";
      channel?: Channel;
      rawBody?: Buffer;
      requestId?: string;
      /** Set when the request arrived on a verified white-label domain. */
      brand?: import("@shared/schema").Brand;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrfToken?: string;
    oauthState?: string;
    oauthNext?: string;
    oauthNonce?: string;
    oauthProvider?: string;
    /** Set when a signed-in user starts SSO to link a provider to their account. */
    oauthLinkUserId?: string;
    maintenanceBypass?: boolean;
    /** Password (or SSO) accepted; waiting for the two-factor code. */
    pending2fa?: { userId: string; expiresAt: number; attempts: number; via: string };
  }
}

export {};
