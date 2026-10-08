import { describe, it, expect, afterEach, vi } from "vitest";
import { botSettingsSchema, isWithinHours, keywordMatches, pickRule, responseAsText, ruleSchema, type Trigger } from "@shared/chatbot";
import type { ChatbotRule, Conversation, Message } from "@shared/schema";
import { chatbotRepository, handleIncoming, outsideHours, testChatbot } from "../services/chatbot.service";
import { conversationsRepository, messagesRepository } from "../repositories/conversations.repository";
import * as assistant from "../services/ai/assistant.service";
import { tenantSettingsRepository } from "../services/delivery.service";

afterEach(() => vi.restoreAllMocks());

const kw = (keywords: string[], match: "contains" | "exact" | "starts_with" = "contains") => ({ type: "keyword", keywords, match }) as Extract<Trigger, { type: "keyword" }>;

describe("keyword matching", () => {
  it("matches whole words, ignoring case and spacing", () => {
    expect(keywordMatches(kw(["hi"]), "Hi there")).toBe(true);
    expect(keywordMatches(kw(["hi"]), "this is it")).toBe(false);
    expect(keywordMatches(kw(["opening hours"]), "what are your  OPENING   hours?")).toBe(true);
    expect(keywordMatches(kw(["price"]), "प्राइस price?")).toBe(true);
  });
  it("supports exact and starts-with", () => {
    expect(keywordMatches(kw(["stop"], "exact"), " STOP ")).toBe(true);
    expect(keywordMatches(kw(["stop"], "exact"), "stop please")).toBe(false);
    expect(keywordMatches(kw(["order"], "starts_with"), "order #123")).toBe(true);
    expect(keywordMatches(kw(["order"], "starts_with"), "my order")).toBe(false);
  });
});

describe("picking a rule", () => {
  const rule = (id: string, trigger: Trigger, priority = 0, extra: Partial<{ enabled: boolean; channels: string[] }> = {}) => ({ id, trigger, priority, enabled: true, channels: ["whatsapp", "web"], ...extra });
  const rules = [
    rule("fallback", { type: "fallback" }),
    rule("away", { type: "outside_hours" }),
    rule("welcome", { type: "first_message" }),
    rule("price2", kw(["price"]), 5),
    rule("price1", kw(["price", "cost"]), 1),
    rule("tap", { type: "button", buttonId: "Pricing" }),
    rule("off", kw(["hello"]), 0, { enabled: false }),
    rule("ig", kw(["hello"]), 0, { channels: ["instagram"] }),
  ];
  const msg = { channel: "whatsapp" as const, text: "", firstMessage: false, outsideHours: false };
  it("checks buttons, then keywords by priority, then welcome, away and fallback", () => {
    expect(pickRule(rules, { ...msg, text: "Prices?", buttonId: "pricing" })?.rule.id).toBe("tap");
    expect(pickRule(rules, { ...msg, text: "what's the price", firstMessage: true })?.rule.id).toBe("price1");
    expect(pickRule(rules, { ...msg, text: "hello", firstMessage: true, outsideHours: true })?.rule.id).toBe("welcome");
    expect(pickRule(rules, { ...msg, text: "hello", outsideHours: true })).toMatchObject({ reason: "outside_hours" });
    expect(pickRule(rules, { ...msg, text: "hello" })?.rule.id).toBe("fallback");
    expect(pickRule(rules, { ...msg, channel: "messenger", text: "hello" })).toBeNull();
    expect(pickRule(rules, { ...msg, channel: "instagram", text: "hello" })?.rule.id).toBe("ig");
  });
});

describe("rules and settings", () => {
  it("validates WhatsApp limits and unique option ids", () => {
    const base = { name: "Menu", channels: ["whatsapp"], trigger: { type: "first_message" } };
    const buttons = (b: { id: string; title: string }[]) => ruleSchema.safeParse({ ...base, response: { type: "buttons", text: "Pick one", buttons: b } });
    expect(buttons([{ id: "a", title: "A" }, { id: "b", title: "B" }]).success).toBe(true);
    expect(buttons([{ id: "a", title: "A" }, { id: "A", title: "B" }]).success).toBe(false);
    expect(buttons([1, 2, 3, 4].map((i) => ({ id: `o${i}`, title: `O${i}` }))).success).toBe(false);
    expect(buttons([{ id: "a", title: "A title that is far too long" }]).success).toBe(false);
    expect(buttons([{ id: "has space", title: "A" }]).success).toBe(false);
    expect(ruleSchema.safeParse({ ...base, channels: [], response: { type: "text", text: "Hi" } }).success).toBe(false);
  });

  it("works out business hours in the tenant's time zone", () => {
    const s = botSettingsSchema.parse({});
    // Thursday 2026-10-08 03:30 UTC = 09:00 in Kolkata.
    expect(isWithinHours(s.hours, new Date("2026-10-08T03:30:00Z"), "Asia/Kolkata")).toBe(true);
    expect(isWithinHours(s.hours, new Date("2026-10-08T03:29:00Z"), "Asia/Kolkata")).toBe(false);
    expect(isWithinHours(s.hours, new Date("2026-10-10T06:00:00Z"), "Asia/Kolkata")).toBe(false); // Saturday
    expect(outsideHours({ ...s, hours: {} }, new Date("2026-10-10T06:00:00Z"), "UTC")).toBe(false); // no hours = always open
  });

  it("turns options into a numbered list for website chat", () => {
    expect(responseAsText({ type: "buttons", text: "How can we help?", buttons: [{ id: "a", title: "Hours" }, { id: "b", title: "Prices" }] })).toBe("How can we help?\n\n1. Hours\n2. Prices");
  });
});

describe("engine", () => {
  const at = new Date("2026-10-08T06:00:00Z");
  const conv = { id: "conv1", channelId: "ch1", type: "web", tags: [], assignedTo: null, botPausedUntil: null, contactName: "Asha" } as unknown as Conversation;
  const stored = (id: string, trigger: object, response: object, extra: Partial<ChatbotRule> = {}) =>
    ({ id, userId: "t1", name: id, enabled: true, priority: 1, channels: ["web", "whatsapp"], trigger, response, actions: {}, cooldownMinutes: 0, timesTriggered: 0, ...extra }) as ChatbotRule;
  const setup = (rules: ChatbotRule[], settings: object = { enabled: true }) => {
    vi.spyOn(chatbotRepository, "settings").mockResolvedValue(botSettingsSchema.parse({ timezone: "UTC", ...settings }));
    vi.spyOn(chatbotRepository, "rules").mockResolvedValue(rules);
    vi.spyOn(chatbotRepository, "repliesSince").mockResolvedValue(0);
    vi.spyOn(chatbotRepository, "markTriggered").mockResolvedValue();
    vi.spyOn(chatbotRepository, "setPause").mockResolvedValue();
    const events = vi.spyOn(chatbotRepository, "logEvent").mockResolvedValue();
    const sent = vi.spyOn(messagesRepository, "create").mockImplementation(async (v) => ({ ...v, id: "m1" }) as Message);
    vi.spyOn(conversationsRepository, "recordMessage").mockResolvedValue();
    vi.spyOn(conversationsRepository, "findById").mockResolvedValue(conv);
    return { events, sent };
  };
  const ev = (text: string, extra: object = {}) => ({ tenantId: "t1", conversation: conv, channel: "web" as const, text, previousInboundAt: new Date(at.getTime() - 60_000), isNew: false, at, ...extra });

  it("answers with the matching rule and records a bot message", async () => {
    const { events, sent } = setup([stored("hours", kw(["hours"]), { type: "buttons", text: "We open at 9", buttons: [{ id: "more", title: "More" }] })]);
    const d = await handleIncoming(ev("your hours?"));
    expect(d).toMatchObject({ outcome: "replied", ruleId: "hours", reason: "keyword", reply: "We open at 9\n\n1. More" });
    expect(sent.mock.calls[0][0]).toMatchObject({ fromType: "bot", metadata: { bot: true, ruleId: "hours" } });
    expect(sent.mock.calls[0][0].metadata).not.toHaveProperty("sentBy");
    expect(events.mock.calls[0][0]).toMatchObject({ outcome: "replied", conversationId: "conv1" });
  });

  it("stays quiet when off, paused, cooling down or looping", async () => {
    let { sent } = setup([stored("any", { type: "fallback" }, { type: "text", text: "Hi" })], { enabled: false });
    expect(await handleIncoming(ev("x"))).toBeNull();
    vi.restoreAllMocks();

    ({ sent } = setup([stored("any", { type: "fallback" }, { type: "text", text: "Hi" })]));
    expect(await handleIncoming(ev("x", { conversation: { ...conv, botPausedUntil: new Date(at.getTime() + 60_000) } }))).toMatchObject({ outcome: "skipped", detail: expect.stringMatching(/Paused/) });
    vi.restoreAllMocks();

    ({ sent } = setup([stored("any", { type: "fallback" }, { type: "text", text: "Hi" }, { cooldownMinutes: 60 })]));
    vi.spyOn(chatbotRepository, "repliesSince").mockResolvedValue(1);
    expect(await handleIncoming(ev("x"))).toMatchObject({ outcome: "skipped", detail: expect.stringMatching(/Cooldown/) });
    vi.restoreAllMocks();

    ({ sent } = setup([stored("any", { type: "fallback" }, { type: "text", text: "Hi" })]));
    vi.spyOn(chatbotRepository, "repliesSince").mockImplementation(async (_c, _s, ruleId) => (ruleId ? 0 : 6));
    const pause = vi.spyOn(chatbotRepository, "setPause").mockResolvedValue();
    expect(await handleIncoming(ev("x"))).toMatchObject({ outcome: "skipped", detail: expect.stringMatching(/Loop guard/) });
    expect(pause).toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });

  it("welcomes new chats and returning customers after 24 hours", async () => {
    setup([stored("welcome", { type: "first_message" }, { type: "text", text: "Welcome!" })]);
    expect(await handleIncoming(ev("hey"))).toMatchObject({ outcome: "skipped", detail: "No rule matched" });
    expect(await handleIncoming(ev("hey", { previousInboundAt: new Date(at.getTime() - 25 * 3600e3) }))).toMatchObject({ outcome: "replied", reason: "first_message" });
    expect(await handleIncoming(ev("hey", { isNew: true }))).toMatchObject({ outcome: "replied" });
  });

  it("hands off when the AI can't answer from the knowledge", async () => {
    setup([stored("faq", { type: "fallback" }, { type: "ai", knowledge: "Delivery takes 2-4 days.", unsureText: "A teammate will help." })], { enabled: true, handoffHours: 24 });
    vi.spyOn(messagesRepository, "listForConversation").mockResolvedValue([{ direction: "inbound", content: "Where is my refund?" } as Message]);
    vi.spyOn(assistant, "botAnswer").mockResolvedValue({ reply: null, simulated: true });
    const patch = vi.spyOn(chatbotRepository, "patchConversation").mockResolvedValue();
    const d = await handleIncoming(ev("Where is my refund?"));
    expect(d).toMatchObject({ outcome: "handoff", reply: "A teammate will help." });
    expect(patch.mock.calls[0][1].botPausedUntil).toEqual(new Date(at.getTime() + 24 * 3600e3));
  });

  it("dry-runs in the test console without sending", async () => {
    const { sent } = setup([stored("menu", { type: "first_message" }, { type: "list", text: "Choose", button: "Options", rows: [{ id: "a", title: "A" }] })]);
    vi.spyOn(tenantSettingsRepository, "getSending").mockResolvedValue({ timezone: "UTC" } as never);
    const r = await testChatbot("t1", { channel: "whatsapp", text: "hi", firstMessage: true, at });
    expect(r.matched).toMatchObject({ name: "menu", reason: "first_message", reply: { text: "Choose", options: [{ id: "a", title: "A" }] } });
    expect((await testChatbot("t1", { channel: "whatsapp", text: "hi", firstMessage: false, at })).matched).toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });
});
