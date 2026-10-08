import { describe, it, expect, afterEach, vi } from "vitest";
import type { Channel } from "@shared/schema";
import { completeSignupSchema } from "@shared/whatsapp-signup";
import { completeSignup, metaGraph, publicSignupConfig } from "../services/whatsapp-signup.service";
import { channelsRepository } from "../repositories/channels.repository";
import * as subscription from "../middlewares/subscription";
import { whatsappFactory } from "../services/whatsapp";
import { encryptSecret } from "../lib/crypto";
import { localThrottle } from "../services/message-queue";
import { makeChannel, mockSystemConfig } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const settings = { enabled: true, appId: "1234567890", appSecret: encryptSecret("app-secret"), configId: "5555555555", coexistence: true };
const input = (mode: "cloud" | "coexistence") => completeSignupSchema.parse({ code: "CODE123", wabaId: "1111111111", phoneNumberId: "2222222222", businessId: "3333333333", mode });

function setup(existing?: Channel) {
  mockSystemConfig({ extensionSettings: { whatsappSignup: settings } });
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  vi.spyOn(metaGraph, "call").mockImplementation(async (method, path, opts) => {
    calls.push(`${method} ${path}`);
    bodies[path] = opts?.body ?? opts?.query;
    if (path === "oauth/access_token") return { access_token: "EAAB-business-token" } as never;
    if (path.endsWith("/phone_numbers")) return { data: [{ id: "2222222222", display_phone_number: "+91 98765 43210", verified_name: "Kurta House" }] } as never;
    if (path.endsWith("/smb_app_data")) return { request_id: "req_1" } as never;
    return { success: true } as never;
  });
  vi.spyOn(channelsRepository, "findByPhoneNumberId").mockResolvedValue(existing);
  vi.spyOn(subscription, "assertWithinPlan").mockResolvedValue();
  const created: Record<string, unknown>[] = [];
  vi.spyOn(channelsRepository, "create").mockImplementation(async (v) => {
    created.push(v as never);
    return makeChannel({ ...(v as Partial<Channel>), id: "new-channel" });
  });
  vi.spyOn(channelsRepository, "update").mockImplementation(async (id, v) => makeChannel({ ...(existing ?? {}), ...(v as Partial<Channel>), id }));
  vi.spyOn(channelsRepository, "findById").mockImplementation(async (id) => makeChannel({ id, connectionMethod: "embedded" }));
  vi.spyOn(channelsRepository, "recordHealth").mockResolvedValue();
  vi.spyOn(whatsappFactory, "create").mockReturnValue({ checkHealth: async () => ({ status: "healthy", details: {} }) } as never);
  return { calls, bodies, created };
}

describe("Embedded Signup", () => {
  it("is simulated on development servers without a Meta app", async () => {
    mockSystemConfig({ extensionSettings: {} });
    expect(await publicSignupConfig()).toMatchObject({ enabled: true, simulated: true, appId: null });
    mockSystemConfig({ extensionSettings: { whatsappSignup: settings } });
    expect(await publicSignupConfig()).toMatchObject({ enabled: true, simulated: false, appId: "1234567890", configId: "5555555555" });
  });

  it("connects a new Cloud API number: exchange, verify, subscribe, register with a PIN", async () => {
    const { calls, bodies, created } = setup();
    const r = await completeSignup("tenant-1", input("cloud"));
    expect(calls).toEqual(["GET oauth/access_token", "GET 1111111111/phone_numbers", "POST 1111111111/subscribed_apps", "POST 2222222222/register"]);
    expect(bodies["oauth/access_token"]).toEqual({ client_id: "1234567890", client_secret: "app-secret", code: "CODE123" });
    expect(r.pin).toMatch(/^\d{6}$/);
    expect(bodies["2222222222/register"]).toEqual({ messaging_product: "whatsapp", pin: r.pin });
    expect(created[0]).toMatchObject({ name: "Kurta House", phoneNumber: "+919876543210", accessToken: "EAAB-business-token", connectionMethod: "embedded", isCoexistence: false, createdBy: "tenant-1" });
    expect(created[0].twoStepPin).not.toBe(r.pin); // stored encrypted
    expect(r.created).toBe(true);
  });

  it("connects a WhatsApp Business app number without registering it, and starts both syncs", async () => {
    const { calls, bodies } = setup();
    const r = await completeSignup("tenant-1", input("coexistence"));
    expect(calls).not.toContain("POST 2222222222/register");
    expect(calls.filter((c) => c === "POST 2222222222/smb_app_data")).toHaveLength(2);
    expect(bodies["2222222222/smb_app_data"]).toEqual({ messaging_product: "whatsapp", sync_type: "history" });
    expect(r.pin).toBeNull();
    const saved = vi.mocked(channelsRepository.update).mock.calls.at(-1)![1];
    expect(saved.onboarding).toMatchObject({ mode: "coexistence", contacts: { requestId: "req_1" }, history: { requestId: "req_1" } });
  });

  it("refuses numbers of another account or outside the shared WABA", async () => {
    setup(makeChannel({ createdBy: "someone-else" }));
    await expect(completeSignup("tenant-1", input("cloud"))).rejects.toMatchObject({ code: "NUMBER_IN_USE" });
    vi.restoreAllMocks();
    setup();
    await expect(completeSignup("tenant-1", { ...input("cloud"), phoneNumberId: "9999999999" })).rejects.toMatchObject({ code: "PHONE_NOT_IN_WABA" });
  });

  it("keeps the channel when registration fails, with a warning", async () => {
    const { calls } = setup();
    vi.mocked(metaGraph.call).mockImplementation(async (_m, path) => {
      calls.push(path);
      if (path === "oauth/access_token") return { access_token: "tok" } as never;
      if (path.endsWith("/phone_numbers")) return { data: [{ id: "2222222222", display_phone_number: "15550001111" }] } as never;
      if (path.endsWith("/register")) throw new Error("Two-step verification PIN mismatch");
      return {} as never;
    });
    const r = await completeSignup("tenant-1", input("cloud"));
    expect(r.pin).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/couldn't register/);
  });
});

describe("Coexistence throughput", () => {
  it("lets a Coexistence number send at most 20 messages per second", async () => {
    const ch = makeChannel({ id: "coex", isCoexistence: true });
    const start = Date.now();
    // Align to the start of a second so all 20 fit in one window.
    await new Promise((r) => setTimeout(r, 1000 - (start % 1000) + 5));
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) await localThrottle(ch);
    expect(Date.now() - t0).toBeLessThan(200);
    await localThrottle(ch); // the 21st waits for the next second
    expect(Math.floor(Date.now() / 1000)).toBeGreaterThan(Math.floor(t0 / 1000));
    // Regular numbers aren't throttled locally.
    const t1 = Date.now();
    for (let i = 0; i < 50; i++) await localThrottle(makeChannel({ id: "cloud" }));
    expect(Date.now() - t1).toBeLessThan(100);
  });
});
