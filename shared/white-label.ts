/**
 * White-label: an agency's brand and custom domains.
 */
import { z } from "zod";

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

export const brandSchema = z.object({
  name: z.string().trim().min(1, "Enter your brand name").max(100),
  baseColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #2563eb").default("#16a34a"),
  supportEmail: z.string().trim().toLowerCase().email().max(255).nullish().or(z.literal("")).transform((v) => v || null),
  supportUrl: z.string().trim().url().max(500).regex(/^https?:\/\//, "Use an http(s) link").nullish().or(z.literal("")).transform((v) => v || null),
  loginTitle: optionalText(120),
  loginSubtitle: optionalText(300),
  hidePoweredBy: z.boolean().default(false),
  allowSignup: z.boolean().default(true),
});
export type BrandInput = z.infer<typeof brandSchema>;

/** A host name such as app.agency.com: no scheme, port, path, IP address or localhost. */
export const domainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .transform((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, ""))
    .pipe(
      z
        .string()
        .max(253)
        .regex(/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a domain like app.youragency.com")
        .refine((d) => !/^\d+(\.\d+){3}$/.test(d), "Use a domain name, not an IP address"),
    ),
});

/** DNS record the agency adds to prove it owns the domain. */
export const verificationRecord = (domain: string, token: string) => ({ type: "TXT" as const, name: `_wm360-verify.${domain}`, value: `wm360-verify=${token}` });

/** Branding the browser applies on a brand's domain (or for its clients). */
export interface PublicBrand {
  name: string;
  logo: string | null;
  favicon: string | null;
  baseColor: string;
  supportEmail: string | null;
  supportUrl: string | null;
  loginTitle: string | null;
  loginSubtitle: string | null;
  allowSignup: boolean;
  /** Platform name for "Powered by", or null when hidden. */
  poweredBy: string | null;
  /** True when the page is served on the brand's own domain. */
  onBrandDomain: boolean;
}
