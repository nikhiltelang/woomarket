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
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      authMethod?: "session" | "bearer";
      channel?: Channel;
      rawBody?: Buffer;
      requestId?: string;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrfToken?: string;
  }
}

export {};
