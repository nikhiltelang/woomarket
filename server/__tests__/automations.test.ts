import { describe, it, expect } from "vitest";
import { automationSchema, dateMatches, enterBranch, flatten, nextAfter, parseDateField, stepsBefore, waitUntil, type Step } from "@shared/automations";
import { flowsForEvent } from "../services/automations.service";

const email = (id: string): Step => ({ id, type: "send_email", subject: "Hi", contentHtml: "<p>Hi</p>" });
const tag = (id: string, t = "x"): Step => ({ id, type: "add_tags", tags: [t] });
const steps: Step[] = [
  email("s_mail1"),
  { id: "s_wait", type: "wait", amount: 2, unit: "days" },
  {
    id: "s_cond",
    type: "condition",
    check: { kind: "step", stepId: "s_mail1", event: "opened" },
    yes: [tag("s_yes1"), tag("s_yes2")],
    no: [],
  },
  tag("s_after"),
];

describe("flow tree", () => {
  it("walks steps, branches and what comes after a branch", () => {
    expect(flatten(steps).map((s) => s.id)).toEqual(["s_mail1", "s_wait", "s_cond", "s_yes1", "s_yes2", "s_after"]);
    expect(nextAfter(steps, "s_mail1")?.id).toBe("s_wait");
    expect(nextAfter(steps, "s_yes1")?.id).toBe("s_yes2");
    // The end of a branch continues below the condition.
    expect(nextAfter(steps, "s_yes2")?.id).toBe("s_after");
    expect(nextAfter(steps, "s_after")).toBeNull();
    const cond = steps[2] as Extract<Step, { type: "condition" }>;
    expect(enterBranch(steps, cond, true)?.id).toBe("s_yes1");
    expect(enterBranch(steps, cond, false)?.id).toBe("s_after"); // empty branch
    expect(stepsBefore(steps, "s_yes2").map((s) => s.id)).toEqual(["s_mail1", "s_wait", "s_yes1"]);
  });

  it("validates flows", () => {
    const base = { name: "F", trigger: { type: "manual" } };
    expect(automationSchema.safeParse({ ...base, steps }).success).toBe(true);
    // A check pointing at a later message, or an event the channel can't report.
    const later = [{ ...steps[2], check: { kind: "step", stepId: "s_mail2", event: "opened" } }, email("s_mail2")];
    expect(automationSchema.safeParse({ ...base, steps: later }).success).toBe(false);
    const wrongEvent = [email("s_msg"), { id: "s_c1", type: "condition", check: { kind: "step", stepId: "s_msg", event: "replied" }, yes: [], no: [] }];
    expect(automationSchema.safeParse({ ...base, steps: wrongEvent }).error?.issues[0].message).toMatch(/can't be checked/);
    expect(automationSchema.safeParse({ ...base, steps: [tag("s_dup1"), tag("s_dup1")] }).success).toBe(false);
  });
});

describe("dates", () => {
  it("reads common date formats", () => {
    expect(parseDateField("1990-05-17")).toEqual({ year: 1990, month: 5, day: 17 });
    expect(parseDateField("17/05/1990")).toEqual({ year: 1990, month: 5, day: 17 });
    expect(parseDateField("17-05")).toEqual({ year: null, month: 5, day: 17 });
    expect(parseDateField("31/13/1990")).toBeNull();
    expect(parseDateField("soon")).toBeNull();
  });
  it("matches birthdays with offsets, yearly or exact, and 29 February", () => {
    expect(dateMatches("1990-05-17", "2026-05-17", 0, true)).toBe(true);
    expect(dateMatches("1990-05-17", "2026-05-17", 0, false)).toBe(false);
    expect(dateMatches("1990-05-17", "2026-05-14", -3, true)).toBe(true); // 3 days before
    expect(dateMatches("2026-10-01", "2026-10-08", 7, false)).toBe(true); // a week after signing up
    expect(dateMatches("2000-02-29", "2026-02-28", 0, true)).toBe(true);
    expect(dateMatches("2000-02-29", "2028-02-28", 0, true)).toBe(false); // 2028 has a 29th
  });
});

describe("waits", () => {
  const now = new Date("2026-10-08T06:00:00Z"); // Thursday 11:30 in Kolkata
  it("adds the delay, then waits for a local time and skips weekends", () => {
    expect(waitUntil({ id: "w", type: "wait", amount: 90, unit: "minutes" }, now, "UTC").toISOString()).toBe("2026-10-08T07:30:00.000Z");
    // 1 day later is Friday 11:30 IST; 10:00 IST next is Saturday 04:30Z.
    expect(waitUntil({ id: "w", type: "wait", amount: 1, unit: "days", until: "10:00" }, now, "Asia/Kolkata").toISOString()).toBe("2026-10-10T04:30:00.000Z");
    // …and on weekdays only that becomes Monday.
    expect(waitUntil({ id: "w", type: "wait", amount: 1, unit: "days", until: "10:00", weekdaysOnly: true }, now, "Asia/Kolkata").toISOString()).toBe("2026-10-12T04:30:00.000Z");
  });
});

describe("triggers", () => {
  const flows = [
    { id: "new", trigger: { type: "contact_created", sources: ["manual", "api"] } },
    { id: "lead", trigger: { type: "tag_added", tag: "Lead" } },
    { id: "vipgroup", trigger: { type: "group_joined", groupId: "g1" } },
    { id: "price", trigger: { type: "message_received", keywords: ["price"] } },
    { id: "anymsg", trigger: { type: "message_received", keywords: [] } },
  ];
  it("starts the right flows", () => {
    expect(flowsForEvent(flows, "contact.created", { contact: { id: "c", source: "manual", tags: ["lead"], groups: [] } })).toEqual(["new", "lead"]);
    expect(flowsForEvent(flows, "contact.created", { contact: { id: "c", source: "import", tags: [], groups: ["g1"] } })).toEqual(["vipgroup"]);
    expect(flowsForEvent(flows, "contact.updated", { contact: { id: "c", tags: ["lead"] }, tagsAdded: [], groupsAdded: [] })).toEqual([]);
    expect(flowsForEvent(flows, "contact.updated", { contact: { id: "c" }, tagsAdded: ["LEAD"], groupsAdded: ["g1"] })).toEqual(["lead", "vipgroup"]);
    expect(flowsForEvent(flows, "message.received", { contact: { id: "c" }, text: "What's the price?" })).toEqual(["price", "anymsg"]);
    expect(flowsForEvent(flows, "message.received", { contact: { id: "c" }, text: "priceless" })).toEqual(["anymsg"]);
  });
});
