import { describe, it, expect, afterEach, vi } from "vitest";
import { connectPage, graph, replyPolicy, socialAccountsRepository } from "../services/social.service";
import { processWebhookPayload } from "../services/webhook-handler";
import type { SocialAccount } from "@shared/schema";

afterEach(() => vi.restoreAllMocks());

describe("reply window", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const ago = (h: number) => ({ lastIncomingMessageAt: new Date(now - h * 3600e3) });
  it("allows normal replies for 24 hours and Human Agent replies for 7 days", () => {
    expect(replyPolicy(ago(2), false, now)).toBe("response");
    expect(replyPolicy(ago(30), false, now)).toBe("closed");
    expect(replyPolicy(ago(30), true, now)).toBe("human_agent");
    expect(replyPolicy(ago(24 * 8), true, now)).toBe("closed");
    expect(replyPolicy({ lastIncomingMessageAt: null }, true, now)).toBe("closed");
  });
});

describe("connecting a Page", () => {
  const input = { channelId: "c1", pageId: "1234567890", accessToken: "EAAG-real-token", messenger: true, instagram: true, humanAgentTag: false };
  it("saves Messenger and Instagram accounts and subscribes the Page", async () => {
    const calls: string[] = [];
    vi.spyOn(graph, "call").mockImplementation(async (method, path) => {
      calls.push(`${method} ${path.split("?")[0]}`);
      return (path.startsWith("1234567890?") ? { id: "1234567890", name: "Kurta House", instagram_business_account: { id: "17841400000000001", username: "kurtahouse" } } : { success: true }) as never;
    });
    vi.spyOn(socialAccountsRepository, "byExternal").mockResolvedValue(undefined);
    const upsert = vi.spyOn(socialAccountsRepository, "upsert").mockImplementation(async (v) => ({ ...v, id: v.platform }) as SocialAccount);
    const saved = await connectPage("t1", input);
    expect(calls).toEqual(["GET 1234567890", "POST 1234567890/subscribed_apps"]);
    expect(saved.map((a) => [a.platform, a.externalId, a.name])).toEqual([
      ["messenger", "1234567890", "Kurta House"],
      ["instagram", "17841400000000001", "@kurtahouse"],
    ]);
    expect(upsert.mock.calls[0][0].accessToken).not.toContain("EAAG");
  });

  it("explains a missing Instagram account and refuses accounts owned elsewhere", async () => {
    vi.spyOn(graph, "call").mockResolvedValue({ id: "1234567890", name: "No IG" } as never);
    vi.spyOn(socialAccountsRepository, "byExternal").mockResolvedValue(undefined);
    await expect(connectPage("t1", { ...input, messenger: false })).rejects.toThrow(/Instagram professional account/);
    vi.spyOn(socialAccountsRepository, "byExternal").mockResolvedValue({ userId: "someone-else" } as SocialAccount);
    await expect(connectPage("t1", { ...input, instagram: false })).rejects.toThrow(/another workspace/);
  });

  it("turns Meta errors into a clear message", async () => {
    vi.spyOn(graph, "call").mockRejectedValue(new Error("Invalid OAuth access token."));
    await expect(connectPage("t1", input)).rejects.toThrow(/Meta didn't accept the Page or token: Invalid OAuth/);
  });
});

describe("webhook routing", () => {
  it("sends page and instagram objects to the social handler and ignores unknown accounts", async () => {
    const lookup = vi.spyOn(socialAccountsRepository, "byExternal").mockResolvedValue(undefined);
    await processWebhookPayload({ object: "page", entry: [{ id: "999", messaging: [{ sender: { id: "1" }, message: { mid: "m1", text: "hi" } }] }] });
    await processWebhookPayload({ object: "instagram", entry: [{ id: "888", messaging: [] }] });
    expect(lookup.mock.calls).toEqual([["messenger", "999"], ["instagram", "888"]]);
  });
});
