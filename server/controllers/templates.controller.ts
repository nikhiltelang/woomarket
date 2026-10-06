import type { Request, Response } from "express";
import { templateSchema } from "@shared/validation";
import type { Template } from "@shared/schema";
import { parseBody } from "../lib/http";
import { notFound, unprocessable } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { countTemplateVariables, templatesRepository } from "../repositories/templates.repository";
import { activityRepository } from "../repositories/activity.repository";
import { channelsRepository } from "../repositories/channels.repository";
import { assertChannelAccess } from "../middlewares/tenant";
import { whatsappFactory, WhatsAppApiError } from "../services/whatsapp";

const log = childLogger("templates");

async function loadTemplate(req: Request): Promise<Template> {
  const t = await templatesRepository.findById(req.params.id);
  if (!t) throw notFound("Template");
  await assertChannelAccess(req.user!, t.channelId).catch(() => {
    throw notFound("Template");
  });
  return t;
}

export async function listTemplates(req: Request, res: Response) {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ data: await templatesRepository.listByChannel(req.channel!.id, status) });
}

export async function getTemplate(req: Request, res: Response) {
  res.json({ data: await loadTemplate(req) });
}

/** Submits a template to Meta; on rejection it stays a draft with the reason recorded. */
async function submit(template: Template): Promise<Template> {
  const channel = (await channelsRepository.findById(template.channelId))!;
  try {
    const result = await whatsappFactory.create(channel).submitTemplate(template);
    return (await templatesRepository.update(template.id, {
      whatsappTemplateId: result.id,
      status: result.status,
      rejectionReason: null,
    }))!;
  } catch (err) {
    const reason = err instanceof WhatsAppApiError ? err.message : "Submission failed";
    log.warn({ templateId: template.id, reason }, "Template submission failed");
    return (await templatesRepository.update(template.id, { status: "draft", rejectionReason: reason }))!;
  }
}

export async function createTemplate(req: Request, res: Response) {
  const input = parseBody(templateSchema, req);
  const template = await templatesRepository.create({
    channelId: req.channel!.id,
    createdBy: req.user!.id,
    name: input.name,
    category: input.category,
    language: input.language,
    header: input.header ?? null,
    headerType: input.header ? "text" : null,
    body: input.body,
    footer: input.footer ?? null,
    buttons: input.buttons ?? [],
    bodyVariables: countTemplateVariables(input.body),
    status: "draft",
  });
  const submitted = await submit(template);
  await activityRepository.record(req, req.user!.id, "template_created", { type: "template", id: template.id });
  res.status(201).json({ data: submitted });
}

export async function updateTemplate(req: Request, res: Response) {
  const template = await loadTemplate(req);
  if (!["draft", "rejected"].includes(template.status ?? "")) {
    throw unprocessable("Only draft or rejected templates can be edited. Create a new template instead.", "TEMPLATE_LOCKED");
  }
  const input = parseBody(templateSchema, req);
  const updated = await templatesRepository.update(template.id, {
    name: input.name,
    category: input.category,
    language: input.language,
    header: input.header ?? null,
    headerType: input.header ? "text" : null,
    body: input.body,
    footer: input.footer ?? null,
    buttons: input.buttons ?? [],
    bodyVariables: countTemplateVariables(input.body),
    whatsappTemplateId: null,
  });
  res.json({ data: await submit(updated!) });
}

export async function deleteTemplate(req: Request, res: Response) {
  const template = await loadTemplate(req);
  if (template.whatsappTemplateId) {
    const channel = await channelsRepository.findById(template.channelId);
    if (channel) {
      await whatsappFactory
        .create(channel)
        .deleteTemplate(template.name)
        .catch((err) => log.warn({ err: (err as Error).message }, "Remote template delete failed; removing locally"));
    }
  }
  await templatesRepository.delete(template.id);
  await activityRepository.record(req, req.user!.id, "template_deleted", { type: "template", id: template.id });
  res.json({ success: true });
}

/** Pulls templates from Meta and upserts them locally by WhatsApp template id. */
export async function syncTemplates(req: Request, res: Response) {
  const channel = req.channel!;
  let remote;
  try {
    remote = await whatsappFactory.create(channel).listTemplates();
  } catch (err) {
    throw unprocessable(`Could not fetch templates from WhatsApp: ${(err as Error).message}`, "SYNC_FAILED");
  }
  let created = 0;
  let updated = 0;
  for (const t of remote) {
    const existing = await templatesRepository.findByWhatsappId(channel.id, t.id);
    const values = {
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      header: t.header,
      headerType: t.header ? "text" : null,
      body: t.body,
      footer: t.footer,
      buttons: t.buttons,
      bodyVariables: countTemplateVariables(t.body),
      rejectionReason: t.rejectionReason,
    };
    if (existing) {
      await templatesRepository.update(existing.id, values);
      updated++;
    } else {
      await templatesRepository.create({ ...values, channelId: channel.id, whatsappTemplateId: t.id, createdBy: req.user!.id });
      created++;
    }
  }
  res.json({ success: true, total: remote.length, created, updated });
}
