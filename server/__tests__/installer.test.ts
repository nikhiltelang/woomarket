import { describe, it, expect } from "vitest";
import dotenv from "dotenv";
import { adminSchema, applicationSchema, databaseSchema, installSchema } from "@shared/install";
import { databaseUrl, envValue, mergeEnv } from "../install/installer";
import { parseDatabaseUrl } from "../db";

describe("database URL", () => {
  it("round-trips credentials with special characters", () => {
    const db = databaseSchema.parse({ host: "db.internal", port: 3307, database: "wm_prod", user: "wm@app", password: "p@ss:w/rd#%? &'\"" });
    expect(parseDatabaseUrl(databaseUrl(db))).toEqual({ user: "wm@app", password: "p@ss:w/rd#%? &'\"", host: "db.internal", port: 3307, database: "wm_prod" });
  });

  it("omits an empty password", () => {
    expect(databaseUrl(databaseSchema.parse({ host: "localhost", database: "wm", user: "root" }))).toBe("mysql://root@localhost:3306/wm");
  });
});

describe(".env writing", () => {
  it("quotes values so dotenv reads them back exactly", () => {
    const values = { A: "plain-value_1", B: "has space", C: "it's", D: 'say "hi"', E: "#notacomment", F: "" };
    const text = Object.entries(values).map(([k, v]) => `${k}=${envValue(v)}`).join("\n");
    expect(dotenv.parse(text)).toEqual(values);
  });

  it("refuses values dotenv can't represent", () => {
    expect(() => envValue("both ' and \"")).toThrow();
    expect(() => envValue("line\nbreak")).toThrow();
  });

  it("replaces existing keys, keeps everything else, and appends new keys", () => {
    const before = "# My settings\nPORT=4000\nDATABASE_URL=old\n# SMTP_HOST=commented\nCUSTOM=keep me\n";
    const after = mergeEnv(before, { DATABASE_URL: "mysql://u@h:3306/d", SESSION_SECRET: "abc" });
    const parsed = dotenv.parse(after);
    expect(parsed).toEqual({ PORT: "4000", DATABASE_URL: "mysql://u@h:3306/d", CUSTOM: "keep me", SESSION_SECRET: "abc" });
    expect(after).toContain("# My settings");
    expect(after).toContain("# SMTP_HOST=commented");
    expect(after.match(/DATABASE_URL=/g)).toHaveLength(1);
  });

  it("creates a file from scratch", () => {
    expect(dotenv.parse(mergeEnv("", { A: "1", B: "two words" }))).toEqual({ A: "1", B: "two words" });
  });
});

describe("wizard input", () => {
  const valid = {
    database: { host: "127.0.0.1", port: 3306, database: "woomarket360", user: "wm", password: "x", createDatabase: true },
    application: { siteName: "Acme Messaging", appUrl: "https://app.acme.test/", demoData: false },
    admin: { username: "owner", email: "Owner@Acme.test", password: "Str0ngPassword", confirmPassword: "Str0ngPassword" },
  };

  it("accepts a complete setup and normalises it", () => {
    const v = installSchema.parse(valid);
    expect(v.application.appUrl).toBe("https://app.acme.test");
    expect(v.admin.email).toBe("owner@acme.test");
    expect(v.smtp).toBeNull();
  });

  it("rejects weak or mismatched passwords, bad database names and URLs", () => {
    expect(adminSchema.safeParse({ ...valid.admin, password: "short1A", confirmPassword: "short1A" }).success).toBe(false);
    expect(adminSchema.safeParse({ ...valid.admin, confirmPassword: "Different1Pass" }).success).toBe(false);
    expect(databaseSchema.safeParse({ ...valid.database, database: "wm; DROP DATABASE x" }).success).toBe(false);
    expect(applicationSchema.safeParse({ ...valid.application, appUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(applicationSchema.safeParse({ ...valid.application, appUrl: "ftp://x.test" }).success).toBe(false);
  });
});
