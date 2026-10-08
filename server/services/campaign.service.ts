import type { Campaign, Channel, Contact } from "@shared/schema";
import { wakeWork } from "./queue/wake";
import { loadSegment, segmentCondition } from "./segments.service";
import type { CreateCampaignInput } from "@shared/validation";
import { campaignsRepository } from "../repositories/campaigns.repository";
import { contactsRepository } from "../repositories/contacts.repository";
import { templatesRepository } from "../repositories/templates.repository";
import { AppError, badRequest, conflict, notFound, unprocessable } from "../lib/errors";
import { childLogger } from "../lib/logger";
import { completeCampaignIfDone, queueRepository } from "./message-queue";
import { realtime } from "./realtime";
import { assertMessageQuota } from "./levels.service";
import { scheduleRecipients } from "./delivery.service";
import { saveAbState } from "./ab-test.service";
import { abAssignments, abStartState } from "./marketing.service";
import type { AbTestState } from "@shared/schema";
import { channelsRepository } from "../repositories/channels.repository";
import type { AuthUser } from "../types";

const log = childLogger("campaigns");

/** Resolves one template variable for a contact from its mapping ("field:name", "static:Hello", ...). */
export function resolveVariable(mapping: string | undefined, contact: Pick<Contact, "name" | "phone" | "email"> & { metadata?: Contact["metadata"] }): string {
  if (!mapping) return "";
  if (mapping.startsWith("static:")) return mapping.slice(7);
  if (mapping.startsWith("field:meta.")) return contact.metadata?.[mapping.slice(11)] ?? "";
  switch (mapping) {
    case "field:name":
      return contact.name;
    case "field:phone":
      return contact.phone;
    case "field:email":
      return contact.email ?? "";
    default:
      return "";
  }
}

export function buildParams(variableCount: number, mapping: Record<string, string>, contact: Contact): string[] {
  return Array.from({ length: variableCount }, (_, i) => resolveVariable(mapping[String(i + 1)], contact) || "-");
}

export async function createCampaign(user: AuthUser, channel: Channel, input: CreateCampaignInput): Promise<Campaign> {
  const template = await templatesRepository.findById(input.templateId);
  if (!template || template.channelId !== channel.id) throw notFound("Template");
  if (template.status !== "approved") throw unprocessable("Campaigns can only use approved templates", "TEMPLATE_NOT_APPROVED");
  const vars = template.bodyVariables ?? 0;
  if (input.abTest?.enabled) {
    const b = input.abTest.templateIdB ? await templatesRepository.findById(input.abTest.templateIdB) : undefined;
    if (!b || b.channelId !== channel.id || b.status !== "approved") throw unprocessable("Variant B needs an approved template on this number", "TEMPLATE_NOT_APPROVED");
    if (b.id === template.id) throw badRequest("Variant B must use a different template");
    if ((b.bodyVariables ?? 0) !== vars) throw badRequest("Both templates must have the same number of variables");
  }
  const segmentId = input.audienceType === "segment" ? (await loadSegment(channel.createdBy!, input.segmentId!)).id : null;
  for (let i = 1; i <= vars; i++) {
    if (!input.variableMapping[String(i)]) throw badRequest(`Map template variable {{${i}}} to a contact field or fixed text`);
  }
  const campaign = await campaignsRepository.create({
    channelId: channel.id,
    createdBy: user.id,
    name: input.name,
    description: input.description ?? null,
    campaignType: "whatsapp",
    type: "template",
    apiType: "cloud_api",
    templateId: template.id,
    templateName: template.name,
    templateLanguage: template.language ?? "en_US",
    variableMapping: input.variableMapping,
    contactGroups: input.contactGroups,
    audienceType: input.audienceType,
    segmentId,
    csvData: input.audienceType === "contacts" ? input.contactIds.map((contactId) => ({ contactId })) : [],
    status: input.scheduledAt ? "scheduled" : "draft",
    scheduledAt: input.scheduledAt ?? null,
    delivery: input.delivery ?? null,
    abTest: input.abTest?.enabled ? input.abTest : null,
  });
  log.info({ campaignId: campaign.id, scheduled: Boolean(input.scheduledAt) }, "Campaign created");
  return campaign;
}

/** Populates recipients and the send queue, then hands the campaign to the queue worker. */
/** A segment audience's condition; the segment belongs to the channel's tenant. */
async function segmentAudience(campaign: Campaign) {
  const owner = (await channelsRepository.findById(campaign.channelId!))?.createdBy;
  if (!owner || !campaign.segmentId) throw unprocessable("The campaign's segment no longer exists");
  return segmentCondition(owner, campaign.segmentId);
}

export async function startCampaign(campaignId: string): Promise<Campaign> {
  const started = await campaignsRepository.transition(campaignId, ["draft", "scheduled"], "running", {
    populationStartedAt: new Date(),
  });
  if (!started) {
    const current = await campaignsRepository.findById(campaignId);
    if (!current) throw notFound("Campaign");
    throw conflict(`Campaign is ${current.status}; only draft or scheduled campaigns can be started`);
  }
  const campaign = (await campaignsRepository.findById(campaignId))!;

  try {
    const template = campaign.templateId ? await templatesRepository.findById(campaign.templateId) : undefined;
    if (!template || template.status !== "approved") throw unprocessable("The campaign template is no longer approved");

    const audience =
      campaign.audienceType === "groups"
        ? { groupIds: campaign.contactGroups ?? [] }
        : campaign.audienceType === "contacts"
          ? { contactIds: (campaign.csvData ?? []).map((r) => r.contactId).filter(Boolean) }
          : campaign.audienceType === "segment"
            ? { where: await segmentAudience(campaign) }
            : {};
    const contacts = await contactsRepository.listAudience(campaign.channelId!, audience);
    const vars = template.bodyVariables ?? 0;
    const mapping = campaign.variableMapping ?? {};

    // Rows of a "contacts" audience may carry their own values ("1", "2", ...), e.g. from the public API.
    const perRecipient = new Map((campaign.csvData ?? []).filter((r) => r.contactId).map((r) => [r.contactId, r]));
    const seen = new Set<string>();
    const recipients = contacts
      .filter((c) => !seen.has(c.phone) && seen.add(c.phone))
      .map((c) => {
        const own = perRecipient.get(c.id);
        const params = buildParams(vars, mapping, c).map((p, i) => own?.[String(i + 1)] ?? p);
        return { contact: c, params };
      });
    const owner = (await channelsRepository.findById(campaign.channelId!))?.createdBy;
    if (owner) await assertMessageQuota(owner, recipients.length);
    const scheduledFor = owner ? await scheduleRecipients(owner, "whatsapp", campaign.delivery, recipients.map(({ contact }) => ({ contactId: contact.id, phone: contact.phone }))) : [];
    // A/B test: variant B uses another approved template with the same variables.
    const ab = campaign.abTest?.enabled ? (campaign.abTest as AbTestState & { testPercent: number; templateIdB?: string | null }) : null;
    const templateB = ab?.templateIdB ? await templatesRepository.findById(ab.templateIdB) : undefined;
    if (ab && (!templateB || templateB.status !== "approved" || templateB.channelId !== campaign.channelId)) throw unprocessable("Variant B's template isn't approved on this number");
    if (ab && (templateB!.bodyVariables ?? 0) !== vars) throw unprocessable("Both A/B templates must have the same number of variables");
    const variants = abAssignments(recipients.length, ab);

    await campaignsRepository.insertRecipients(
      recipients.map(({ contact, params }, i) => ({
        campaignId: campaign.id,
        contactId: contact.id,
        phone: contact.phone,
        name: contact.name,
        status: variants[i] === "held" ? "held" : "pending",
        variant: variants[i] === "held" ? null : variants[i],
        templateParams: Object.fromEntries(params.map((p, i) => [String(i + 1), p])),
      })),
    );
    await queueRepository.enqueue(
      recipients
        .map(({ contact, params }, i) => ({ contact, params, i }))
        .filter(({ i }) => variants[i] !== "held")
        .map(({ contact, params, i }) => {
          const t = variants[i] === "B" ? templateB! : template;
          return {
            scheduledFor: scheduledFor[i] ?? null,
            campaignId: campaign.id,
            channelId: campaign.channelId,
            recipientPhone: contact.phone,
            templateName: t.name,
            templateLanguage: t.language ?? "en_US",
            templateParams: params,
            messageType: "template",
            status: "queued",
          };
        }),
    );
    if (ab) await saveAbState("whatsapp", campaign.id, abStartState(ab, variants));
    await campaignsRepository.update(campaign.id, { recipientCount: recipients.length });
    await templatesRepository.incrementUsage(template.id, recipients.length);
    log.info({ campaignId, recipients: recipients.length }, "Campaign started");
    if (recipients.length === 0) await completeCampaignIfDone(campaign.id);
  } catch (err) {
    // A quota refusal isn't a failure of the campaign itself: return it to draft so it can be resent later.
    const quota = err instanceof AppError && err.code === "LEVEL_LIMIT";
    await campaignsRepository.update(campaign.id, { status: quota ? "draft" : "failed", populationStartedAt: quota ? null : campaign.populationStartedAt });
    throw err;
  }

  wakeWork("whatsapp");
  const fresh = (await campaignsRepository.findById(campaign.id))!;
  realtime.toChannel(fresh.channelId, "campaign_updated", { campaign: fresh });
  return fresh;
}

export async function changeCampaignStatus(campaign: Campaign, to: "paused" | "running" | "cancelled"): Promise<Campaign> {
  let ok = false;
  if (to === "paused") {
    ok = await campaignsRepository.transition(campaign.id, ["running"], "paused");
    if (ok) await queueRepository.setStatusForCampaign(campaign.id, ["queued"], "paused");
  } else if (to === "running") {
    ok = await campaignsRepository.transition(campaign.id, ["paused"], "running");
    if (ok) await queueRepository.setStatusForCampaign(campaign.id, ["paused"], "queued");
  } else {
    ok = await campaignsRepository.transition(campaign.id, ["draft", "scheduled", "running", "paused"], "cancelled", {
      completedAt: new Date(),
    });
    if (ok) {
      await queueRepository.setStatusForCampaign(campaign.id, ["queued", "paused"], "cancelled");
      await campaignsRepository.cancelHeld(campaign.id);
    }
  }
  if (!ok) throw conflict(`Cannot change a ${campaign.status} campaign to ${to}`);
  const fresh = (await campaignsRepository.findById(campaign.id))!;
  realtime.toChannel(fresh.channelId, "campaign_updated", { campaign: fresh });
  return fresh;
}

/** Cron: starts scheduled campaigns whose time has come. */
export async function startDueCampaigns(now = new Date()): Promise<number> {
  const due = await campaignsRepository.dueScheduled(now);
  for (const c of due) {
    try {
      await startCampaign(c.id);
    } catch (err) {
      log.error({ campaignId: c.id, err: (err as Error).message }, "Failed to start scheduled campaign");
    }
  }
  return due.length;
}
