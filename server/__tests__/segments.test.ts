import { describe, it, expect } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describeRules, segmentRulesSchema, segmentSchema } from "@shared/segments";
import { compileRules } from "../services/segments.service";

const dialect = new MySqlDialect();
const compile = (rules: unknown) => dialect.sqlToQuery(compileRules(segmentRulesSchema.parse(rules)));

describe("segment rules", () => {
  it("validates conditions", () => {
    expect(segmentRulesSchema.safeParse({ match: "all", conditions: [] }).success).toBe(false);
    expect(segmentRulesSchema.safeParse({ conditions: [{ field: "custom", key: "City", op: "eq", value: "x" }] }).success).toBe(false);
    expect(segmentRulesSchema.safeParse({ conditions: [{ field: "custom", key: "city", op: "eq", value: "Pune" }] }).success).toBe(true);
    expect(segmentRulesSchema.safeParse({ conditions: [{ field: "group", op: "in", value: "not-a-uuid" }] }).success).toBe(false);
    expect(segmentRulesSchema.safeParse({ conditions: Array.from({ length: 21 }, () => ({ field: "tag", op: "has", value: "vip" })) }).success).toBe(false);
    expect(segmentSchema.safeParse({ name: " ", rules: { conditions: [{ field: "tag", op: "has", value: "vip" }] } }).success).toBe(false);
  });

  it("compiles to parameterised SQL joined by the match mode", () => {
    const q = compile({ match: "any", conditions: [{ field: "tag", op: "has", value: "vip" }, { field: "name", op: "contains", value: "50%_off" }] });
    expect(q.sql).toContain(" OR ");
    expect(q.sql).toContain("JSON_CONTAINS");
    expect(q.params).toContain("vip");
    expect(q.params).toContain("%50\\%\\_off%");
    expect(compile({ conditions: [{ field: "tag", op: "has", value: "a" }, { field: "tag", op: "not_has", value: "b" }] }).sql).toContain(") AND (NOT ");
  });

  it("reads custom fields from metadata, comparing numbers numerically", () => {
    const q = compile({ conditions: [{ field: "custom", key: "age", op: "gt", value: "30" }] });
    expect(q.sql).toContain("JSON_EXTRACT");
    expect(q.params).toContain('$."age"');
    expect(q.sql).toContain("DECIMAL");
    expect(q.params).toContain(30);
    const eq = compile({ conditions: [{ field: "custom", key: "city", op: "eq", value: "Pune" }] });
    expect(eq.sql).toContain("LOWER(");
    expect(eq.params).toContain("pune");
    expect(compile({ conditions: [{ field: "custom", key: "renewal", op: "lt", value: "2026-12-01" }] }).sql).not.toContain("DECIMAL");
  });

  it("uses engagement subqueries and treats never-contacted as old", () => {
    const q = compile({ conditions: [{ field: "engagement", op: "email_not_opened", value: 30 }] });
    expect(q.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM `email_campaign_recipients`/);
    const since = q.params.find((p) => p instanceof Date || typeof p === "string" && /^\d{4}-/.test(p));
    expect(since).toBeTruthy();
    expect(compile({ conditions: [{ field: "engagement", op: "whatsapp_replied", value: 7 }] }).sql).toContain("'inbound'");
    expect(compile({ conditions: [{ field: "last_contact", op: "older_than_days", value: 90 }] }).sql).toContain("IS NULL OR");
  });

  it("describes rules in words", () => {
    const r = segmentRulesSchema.parse({ conditions: [{ field: "custom", key: "city", op: "eq", value: "Pune" }, { field: "engagement", op: "email_opened", value: 30 }] });
    expect(describeRules(r)).toBe("city is “Pune” and opened an email in the last 30 days");
  });
});
