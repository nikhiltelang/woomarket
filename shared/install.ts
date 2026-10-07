/** Web installer: request schemas shared by the setup wizard and the server. */
import { z } from "zod";

export const databaseSchema = z.object({
  host: z.string().trim().min(1, "Required").max(255),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  database: z.string().trim().regex(/^[A-Za-z0-9_$]{1,64}$/, "Letters, digits, _ and $ only"),
  user: z.string().trim().min(1, "Required").max(80),
  password: z.string().max(255).default(""),
  /** Create the database when it doesn't exist (needs CREATE privilege). */
  createDatabase: z.boolean().default(true),
});

export const applicationSchema = z.object({
  siteName: z.string().trim().min(1, "Required").max(100),
  appUrl: z
    .string()
    .trim()
    .url("Enter the full address, e.g. https://app.example.com")
    .refine((u) => /^https?:\/\//.test(u), "Use http:// or https://")
    .transform((u) => u.replace(/\/+$/, "")),
  /** Sample tenant with a simulator number, contacts and templates. */
  demoData: z.boolean().default(false),
});

export const adminSchema = z
  .object({
    firstName: z.string().trim().max(100).default(""),
    lastName: z.string().trim().max(100).default(""),
    username: z
      .string()
      .trim()
      .min(3, "At least 3 characters")
      .max(64)
      .regex(/^[a-zA-Z0-9._-]+$/, "Letters, numbers, dot, dash and underscore only"),
    email: z.string().trim().toLowerCase().email("Enter a valid email"),
    password: z
      .string()
      .min(10, "At least 10 characters")
      .max(128)
      .regex(/[a-z]/, "Include a lowercase letter")
      .regex(/[A-Z]/, "Include an uppercase letter")
      .regex(/\d/, "Include a number"),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: "Passwords don't match", path: ["confirmPassword"] });

export const smtpSchema = z.object({
  host: z.string().trim().min(1, "Required").max(255),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().trim().max(255).default(""),
  pass: z.string().max(255).default(""),
  fromEmail: z.string().trim().toLowerCase().email("Enter a valid email"),
  fromName: z.string().trim().max(100).default(""),
});

export const installSchema = z.object({
  database: databaseSchema,
  application: applicationSchema,
  admin: adminSchema,
  /** null = set up email later in System settings. */
  smtp: smtpSchema.nullable().default(null),
});
export type InstallInput = z.input<typeof installSchema>;

export interface Requirement {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface DatabaseCheck {
  ok: true;
  version: string;
  databaseExists: boolean;
  tableCount: number;
  /** Superadmin accounts already in the database (an earlier installation). */
  existingSuperadmins: number;
}

export type InstallStepKey = "database" | "configure" | "migrate" | "seed" | "save";
export const INSTALL_STEPS: { key: InstallStepKey; label: string }[] = [
  { key: "database", label: "Connecting to the database" },
  { key: "configure", label: "Generating secure keys" },
  { key: "migrate", label: "Creating tables" },
  { key: "seed", label: "Adding your administrator and default settings" },
  { key: "save", label: "Saving configuration" },
];
