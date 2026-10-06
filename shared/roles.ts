export const ROLES = {
  SUPERADMIN: "superadmin",
  ADMIN: "admin",
  TEAM: "team",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const PERMISSIONS = {
  CONTACTS_VIEW: "contacts:view",
  CONTACTS_CREATE: "contacts:create",
  CONTACTS_EDIT: "contacts:edit",
  CONTACTS_DELETE: "contacts:delete",
  CONTACTS_EXPORT: "contacts:export",
  GROUPS_MANAGE: "groups:manage",
  INBOX_VIEW: "inbox:view",
  INBOX_SEND: "inbox:send",
  INBOX_ASSIGN: "inbox:assign",
  TEMPLATES_VIEW: "templates:view",
  TEMPLATES_CREATE: "templates:create",
  TEMPLATES_EDIT: "templates:edit",
  TEMPLATES_DELETE: "templates:delete",
  TEMPLATES_SYNC: "templates:sync",
  CAMPAIGNS_VIEW: "campaigns:view",
  CAMPAIGNS_CREATE: "campaigns:create",
  CAMPAIGNS_EDIT: "campaigns:edit",
  CAMPAIGNS_DELETE: "campaigns:delete",
  CAMPAIGNS_SEND: "campaigns:send",
  TEAM_VIEW: "team:view",
  TEAM_CREATE: "team:create",
  TEAM_EDIT: "team:edit",
  TEAM_DELETE: "team:delete",
  TEAM_PERMISSIONS: "team:permissions",
  ANALYTICS_VIEW: "analytics:view",
  ANALYTICS_EXPORT: "analytics:export",
  SETTINGS_VIEW: "settings:view",
  SETTINGS_EDIT: "settings:edit",
  AUTOMATIONS_VIEW: "automations:view",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Grouped for the permission editor in the Team screen. */
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  { label: "Contacts", permissions: ["contacts:view", "contacts:create", "contacts:edit", "contacts:delete", "contacts:export", "groups:manage"] },
  { label: "Inbox", permissions: ["inbox:view", "inbox:send", "inbox:assign"] },
  { label: "Templates", permissions: ["templates:view", "templates:create", "templates:edit", "templates:delete", "templates:sync"] },
  { label: "Campaigns", permissions: ["campaigns:view", "campaigns:create", "campaigns:edit", "campaigns:delete", "campaigns:send"] },
  { label: "Team", permissions: ["team:view", "team:create", "team:edit", "team:delete", "team:permissions"] },
  { label: "Analytics", permissions: ["analytics:view", "analytics:export"] },
  { label: "Settings", permissions: ["settings:view", "settings:edit", "automations:view"] },
];

/** Default permissions for a newly invited team member. */
export const DEFAULT_TEAM_PERMISSIONS: Permission[] = [
  "contacts:view",
  "inbox:view",
  "inbox:send",
  "templates:view",
  "campaigns:view",
  "analytics:view",
];

/** Permissions a team member may never receive (they stay with the tenant admin). */
export const ADMIN_ONLY_PERMISSIONS: Permission[] = ["team:create", "team:delete", "team:permissions", "settings:edit"];

export function hasPermission(userPermissions: readonly string[] | null | undefined, ...required: string[]): boolean {
  if (!userPermissions) return false;
  return required.some((p) => userPermissions.includes(p));
}
