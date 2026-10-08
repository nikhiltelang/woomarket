import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { login, makeUser, mockDirectory } from "./helpers";
import * as uploads from "../lib/uploads";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const admin = makeUser({ username: "img_admin" });
let app: Express;

beforeEach(() => {
  mockDirectory([admin]);
  app = createApp().app;
});
afterEach(() => vi.restoreAllMocks());

describe("email builder images", () => {
  it("stores an uploaded image under the tenant and returns an absolute URL", async () => {
    const save = vi.spyOn(uploads, "saveImage").mockResolvedValue(`/uploads/email/${admin.id}/abc.png`);
    const { agent, csrf } = await login(app, "img_admin");
    const res = await agent.post("/api/email-marketing/images").set("X-CSRF-Token", csrf).attach("image", PNG, "banner.png").expect(201);
    expect(res.body.data.url).toMatch(new RegExp(`^https?://[^/]+/uploads/email/${admin.id}/abc\\.png$`));
    expect(save.mock.calls[0][1]).toBe(`email/${admin.id}`);
  });

  it("refuses files that aren't images (e.g. SVG renamed to .png)", async () => {
    const { agent, csrf } = await login(app, "img_admin");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await agent.post("/api/email-marketing/images").set("X-CSRF-Token", csrf).attach("image", svg, "x.png").expect(400);
    expect(res.body.message).toMatch(/PNG, JPG/);
    await agent.post("/api/email-marketing/images").set("X-CSRF-Token", csrf).expect(400);
  });
});
