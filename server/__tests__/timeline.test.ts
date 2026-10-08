import { describe, it, expect } from "vitest";
import { timelineQuery } from "@shared/timeline";
import type { TimelineItem } from "@shared/timeline";
import { mergePage } from "../services/timeline.service";

const item = (id: string, at: string, kind: TimelineItem["kind"] = "message"): TimelineItem => ({ id, kind, at, title: id });

describe("contact timeline", () => {
  it("merges sources newest first and pages with a cursor", () => {
    const messages = [item("m3", "2026-10-08T12:00:00.000Z"), item("m2", "2026-10-07T12:00:00.000Z"), item("m1", "2026-10-01T12:00:00.000Z")];
    const emails = [item("e1", "2026-10-08T09:00:00.000Z", "email")];
    const page = mergePage([messages, emails], 2);
    expect(page.items.map((i) => i.id)).toEqual(["m3", "e1"]);
    expect(page.nextBefore).toBe("2026-10-08T09:00:00.000Z");
    expect(mergePage([messages, emails], 10)).toMatchObject({ nextBefore: null });
  });

  it("never splits items that share the last timestamp across pages", () => {
    const t = "2026-10-08T10:00:00.000Z";
    const page = mergePage([[item("a", "2026-10-08T11:00:00.000Z"), item("b", t)], [item("c", t)], [item("d", "2026-10-07T10:00:00.000Z")]], 2);
    expect(page.items.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
    expect(page.nextBefore).toBe(t);
  });

  it("parses filters", () => {
    expect(timelineQuery.parse({ kinds: "email,note,bogus" }).kinds).toEqual(["email", "note"]);
    expect(timelineQuery.parse({}).kinds).toHaveLength(6);
    expect(timelineQuery.parse({ before: "2026-10-08T10:00:00.000Z" }).before).toEqual(new Date("2026-10-08T10:00:00.000Z"));
  });
});
