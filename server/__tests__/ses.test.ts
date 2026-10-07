import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { GetAccountCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { smtpConfigSchema } from "@shared/validation";
import type { EmailRecipient, SmtpConfig } from "@shared/schema";
import { createApp } from "../app";
import { mockDirectory } from "./helpers";
import { classifySesError, sendWithSes } from "../services/email/ses";
import { __setCertFetcher, handleSesEvent, handleSnsMessage, isSnsUrl, snsStringToSign, verifySnsSignature, type SnsMessage } from "../services/email/ses-feedback";
import { emailCampaignsRepository, smtpRepository, suppressionsRepository } from "../repositories/email.repository";
import { contactsRepository } from "../repositories/contacts.repository";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem";
const TOPIC = "arn:aws:sns:us-east-1:123456789012:ses-feedback";

function signed(m: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL">, version: "1" | "2" = "2"): SnsMessage {
  const msg = { ...m, SignatureVersion: version, SigningCertURL: CERT_URL } as SnsMessage;
  const signer = crypto.createSign(version === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(snsStringToSign(msg));
  return { ...msg, Signature: signer.sign(privateKey, "base64") };
}

const sesConfig = (o: Partial<SmtpConfig> = {}): SmtpConfig =>
  ({ id: "cfg-1", userId: "tenant-1", provider: "ses", region: "us-east-1", host: "email.us-east-1.amazonaws.com", port: 443, secure: true, user: "AKIAEXAMPLE000000000", password: "x", fromName: "Shop", fromEmail: "news@shop.test", configurationSet: null, snsTopicArn: null, logo: null, createdAt: new Date(), updatedAt: new Date(), ...o }) as SmtpConfig;

const recipient = (o: Partial<EmailRecipient> = {}): EmailRecipient =>
  ({ id: "r-1", campaignId: "c-1", contactId: "ct-1", email: "ada@x.test", name: "Ada", status: "sent", sentAt: new Date(), deliveredAt: new Date(), openedAt: null, errorMessage: null, messageId: "ses-msg-1", createdAt: new Date(), ...o }) as EmailRecipient;

beforeEach(() => {
  __setCertFetcher(async () => PEM);
});
afterEach(() => vi.restoreAllMocks());

describe("settings validation", () => {
  it("treats requests without a provider as SMTP (older clients)", () => {
    expect(smtpConfigSchema.parse({ host: "smtp.x.test", port: 587, user: "u", fromName: "X", fromEmail: "a@x.test" })).toMatchObject({ provider: "smtp" });
  });
  it("validates SES settings", () => {
    const base = { provider: "ses", region: "eu-west-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", fromName: "Shop", fromEmail: "News@Shop.test" };
    expect(smtpConfigSchema.parse(base)).toMatchObject({ provider: "ses", region: "eu-west-1", fromEmail: "news@shop.test" });
    expect(smtpConfigSchema.safeParse({ ...base, accessKeyId: "nope" }).success).toBe(false);
    expect(smtpConfigSchema.safeParse({ ...base, region: "europe" }).success).toBe(false);
    expect(smtpConfigSchema.safeParse({ ...base, configurationSet: "bad set!" }).success).toBe(false);
    expect(smtpConfigSchema.safeParse({ ...base, secretAccessKey: undefined }).success).toBe(true); // keep stored secret
  });
});

describe("sending through SES", () => {
  it("sends raw MIME with tags and configuration set, and adopts the account's send rate", async () => {
    const sent: unknown[] = [];
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetAccountCommand) return { SendQuota: { MaxSendRate: 14 } } as never;
      if (cmd instanceof SendEmailCommand) {
        sent.push(cmd.input);
        return { MessageId: "0100018f-abc" } as never;
      }
      throw new Error("unexpected command");
    });
    const id = await sendWithSes(
      { region: "eu-west-1", accessKeyId: "AKIAUNITTEST00000001", secretAccessKey: "secret-1" },
      { from: '"Shop" <news@shop.test>', to: "ada@x.test", subject: "Hello", html: "<p>Hi</p>", text: "Hi", headers: { "List-Unsubscribe": "<https://x.test/u>" }, tags: { wm_recipient: "r-1", "bad tag!": "v@l" }, configurationSet: "marketing" },
    );
    expect(id).toBe("0100018f-abc");
    const input = sent[0] as { Destination: { ToAddresses: string[] }; Content: { Raw: { Data: Buffer } }; ConfigurationSetName: string; EmailTags: { Name: string; Value: string }[] };
    expect(input.Destination.ToAddresses).toEqual(["ada@x.test"]);
    expect(input.ConfigurationSetName).toBe("marketing");
    expect(input.EmailTags).toEqual([{ Name: "wm_recipient", Value: "r-1" }, { Name: "bad_tag_", Value: "v_l" }]);
    const raw = Buffer.from(input.Content.Raw.Data).toString();
    expect(raw).toMatch(/^From: "?Shop"? <news@shop\.test>/m);
    expect(raw).toMatch(/^Subject: Hello/m);
    expect(raw).toMatch(/^List-Unsubscribe: <https:\/\/x\.test\/u>/m);
  });

  it("classifies errors: settings problems stop the campaign, throttling retries, recipients fail alone", () => {
    const err = (name: string, message = "") => Object.assign(new Error(message), { name });
    expect(classifySesError(err("InvalidClientTokenId"), "news@shop.test")).toBe("config");
    expect(classifySesError(err("AccessDeniedException"), "news@shop.test")).toBe("config");
    expect(classifySesError(err("MessageRejected", "Email address is not verified. The following identities failed the check in region EU-WEST-1: news@shop.test"), "news@shop.test")).toBe("config");
    expect(classifySesError(err("MessageRejected", "Email address is not verified: ada@x.test"), "news@shop.test")).toBe("permanent");
    expect(classifySesError(err("TooManyRequestsException"), "news@shop.test")).toBe("temporary");
    expect(classifySesError(err("LimitExceededException"), "news@shop.test")).toBe("temporary");
  });
});

describe("SNS signatures", () => {
  const note = { Type: "Notification", MessageId: "m-1", TopicArn: TOPIC, Message: '{"notificationType":"Delivery"}', Timestamp: "2026-10-07T10:00:00.000Z", Subject: "x" };

  it("accepts SignatureVersion 1 and 2, and rejects tampering", async () => {
    expect(await verifySnsSignature(signed(note, "2"))).toBe(true);
    expect(await verifySnsSignature(signed(note, "1"))).toBe(true);
    expect(await verifySnsSignature({ ...signed(note), Message: '{"notificationType":"Bounce"}' })).toBe(false);
  });

  it("only trusts certificates from sns.<region>.amazonaws.com", async () => {
    for (const url of ["https://evil.test/cert.pem", "http://sns.us-east-1.amazonaws.com/c.pem", "https://sns.us-east-1.amazonaws.com.evil.test/c.pem", "https://sns.us-east-1.amazonaws.com/c.txt"]) {
      expect(await verifySnsSignature({ ...signed(note), SigningCertURL: url })).toBe(false);
    }
    expect(isSnsUrl("https://sns.cn-north-1.amazonaws.com.cn/x")).toBe(true);
  });

  it("treats an unreachable certificate as an invalid signature", async () => {
    __setCertFetcher(async () => {
      throw new Error("404");
    });
    expect(await verifySnsSignature({ ...signed(note), SigningCertURL: "https://sns.us-east-1.amazonaws.com/Other-cert.pem" })).toBe(false);
  });
});

describe("SES events", () => {
  let updates: [string, Partial<EmailRecipient>][];
  let counters: [string, string, number][];
  let suppressed: [string | null, string, string][];
  beforeEach(() => {
    updates = [];
    counters = [];
    suppressed = [];
    vi.spyOn(emailCampaignsRepository, "findRecipientByMessageId").mockResolvedValue(recipient());
    vi.spyOn(emailCampaignsRepository, "find").mockResolvedValue({ id: "c-1", userId: "tenant-1" } as never);
    vi.spyOn(emailCampaignsRepository, "updateRecipient").mockImplementation(async (id, p) => void updates.push([id, p]));
    vi.spyOn(emailCampaignsRepository, "increment").mockImplementation(async (id, f, by = 1) => void counters.push([id, f, by]));
    vi.spyOn(suppressionsRepository, "add").mockImplementation(async (u, e, r) => (suppressed.push([u, e, r]), true));
  });

  it("hard bounce: suppresses, marks the recipient bounced and moves it from delivered to failed", async () => {
    await handleSesEvent({ notificationType: "Bounce", mail: { messageId: "ses-msg-1" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "ada@x.test", diagnosticCode: "550 5.1.1 user unknown" }] } }, null);
    expect(suppressed).toEqual([["tenant-1", "ada@x.test", "bounce"]]);
    expect(updates[0][1]).toMatchObject({ status: "bounced", deliveredAt: null });
    expect(counters).toEqual([["c-1", "deliveredCount", -1], ["c-1", "failedCount", 1]]);
  });

  it("ignores transient bounces", async () => {
    expect(await handleSesEvent({ notificationType: "Bounce", mail: { messageId: "ses-msg-1" }, bounce: { bounceType: "Transient" } }, null)).toMatch(/transient/);
    expect(suppressed).toEqual([]);
  });

  it("complaint: suppresses and unsubscribes the contact", async () => {
    const contact = vi.spyOn(contactsRepository, "update").mockResolvedValue(undefined);
    await handleSesEvent({ eventType: "Complaint", mail: { messageId: "ses-msg-1" }, complaint: { complainedRecipients: [{ emailAddress: "ada@x.test" }], complaintFeedbackType: "abuse" } }, null);
    expect(suppressed).toEqual([["tenant-1", "ada@x.test", "complaint"]]);
    expect(contact).toHaveBeenCalledWith("ct-1", { status: "unsubscribed" });
  });
});

describe("SNS endpoint", () => {
  it("confirms the subscription, pins the topic, and refuses other topics or bad signatures", async () => {
    vi.spyOn(smtpRepository, "findById").mockResolvedValue(sesConfig());
    const setTopic = vi.spyOn(smtpRepository, "setTopic").mockResolvedValue();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<ConfirmSubscriptionResponse/>", { status: 200 }));
    const sub = signed({ Type: "SubscriptionConfirmation", MessageId: "m-2", TopicArn: TOPIC, Message: "confirm", Timestamp: "2026-10-07T10:00:00.000Z", Token: "t", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t" });
    expect(await handleSnsMessage("cfg-1", sub)).toMatchObject({ status: 200, result: "subscription confirmed" });
    expect(fetchSpy.mock.calls[0][0]).toBe(sub.SubscribeURL);
    expect(setTopic).toHaveBeenCalledWith("cfg-1", TOPIC);

    vi.spyOn(smtpRepository, "findById").mockResolvedValue(sesConfig({ snsTopicArn: TOPIC }));
    const other = signed({ Type: "Notification", MessageId: "m-3", TopicArn: "arn:aws:sns:us-east-1:999999999999:other", Message: "{}", Timestamp: "2026-10-07T10:00:00.000Z" });
    expect((await handleSnsMessage("cfg-1", other)).status).toBe(403);
    expect((await handleSnsMessage("cfg-1", { ...sub, Signature: "AAAA" })).status).toBe(403);
  });

  it("accepts SNS's text/plain POST over HTTP", async () => {
    mockDirectory([]);
    vi.spyOn(smtpRepository, "findById").mockResolvedValue(sesConfig({ snsTopicArn: TOPIC }));
    vi.spyOn(emailCampaignsRepository, "findRecipientByMessageId").mockResolvedValue(undefined);
    const body = signed({ Type: "Notification", MessageId: "m-4", TopicArn: TOPIC, Message: JSON.stringify({ notificationType: "Delivery", mail: { messageId: "unknown" } }), Timestamp: "2026-10-07T10:00:00.000Z" });
    const res = await request(createApp().app).post("/webhooks/ses/cfg-1").set("Content-Type", "text/plain; charset=UTF-8").send(JSON.stringify(body)).expect(200);
    expect(res.body.result).toBe("delivery recorded");
    await request(createApp().app).post("/webhooks/ses/cfg-1").set("Content-Type", "text/plain").send("not json").expect(400);
  });
});
