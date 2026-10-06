import type { Channel } from "@shared/schema";
import { config } from "../../config";
import { MetaCloudClient } from "./meta-client";
import { SimulatorClient } from "./simulator-client";
import type { WhatsAppClient } from "./types";

export * from "./types";

/** Picks the provider for a channel: simulator channels (or WHATSAPP_SIMULATE=true) never call Meta. */
export function getWhatsAppClient(channel: Channel): WhatsAppClient {
  if (channel.connectionMethod === "simulator" || config.WHATSAPP_SIMULATE) return new SimulatorClient(channel);
  return new MetaCloudClient(channel);
}

/** Overridable in tests. */
export const whatsappFactory = { create: getWhatsAppClient };
