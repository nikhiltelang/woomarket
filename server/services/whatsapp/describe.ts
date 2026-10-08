/** Text shown in the inbox for an incoming (or history / echoed) WhatsApp message. */
export interface InboundMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  context?: { id?: string };
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string; sha256?: string };
  video?: { id?: string; mime_type?: string; caption?: string; sha256?: string };
  audio?: { id?: string; mime_type?: string; sha256?: string };
  document?: { id?: string; mime_type?: string; caption?: string; filename?: string; sha256?: string };
  sticker?: { id?: string; mime_type?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  button?: { text?: string; payload?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
  reaction?: { emoji?: string; message_id?: string };
}

export function describe(msg: InboundMessage): { content: string; media?: { id?: string; mime?: string; sha?: string }; buttonId?: string } {
  switch (msg.type) {
    case "text":
      return { content: msg.text?.body ?? "" };
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const m = (msg as any)[msg.type] ?? {};
      return {
        content: m.caption || m.filename || `[${msg.type}]`,
        media: { id: m.id, mime: m.mime_type, sha: m.sha256 },
      };
    }
    case "location":
      return { content: `📍 ${msg.location?.name ?? ""} ${msg.location?.latitude},${msg.location?.longitude}`.trim() };
    case "button":
      return { content: msg.button?.text ?? "[button]", buttonId: msg.button?.payload };
    case "interactive": {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      return { content: reply?.title ?? "[interactive]", buttonId: reply?.id };
    }
    case "reaction":
      return { content: `Reacted ${msg.reaction?.emoji ?? ""}` };
    default:
      return { content: `[${msg.type}]` };
  }
}
