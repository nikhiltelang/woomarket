/**
 * Minimal Anthropic Messages API client: one forced tool call returns structured JSON.
 */
import { AppError } from "../../lib/errors";

export const anthropicEndpoint = { url: "https://api.anthropic.com/v1/messages", version: "2023-06-01" };

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface StructuredResult<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
}

const FRIENDLY: Record<number, string> = {
  401: "The AI provider rejected the API key. Ask the platform administrator to check it.",
  403: "The AI API key doesn't have access to this model.",
  404: "The selected AI model isn't available. Ask the platform administrator to pick another.",
  429: "The AI provider is rate-limiting requests. Try again in a minute.",
  529: "The AI provider is overloaded. Try again shortly.",
};

/** Calls Claude and returns the arguments of the forced tool call. */
export async function structuredCall<T>(opts: { apiKey: string; model: string; system: string; user: string; tool: ToolSpec; maxTokens?: number; timeoutMs?: number }): Promise<StructuredResult<T>> {
  let res: Response;
  try {
    res = await fetch(anthropicEndpoint.url, {
      method: "POST",
      headers: { "x-api-key": opts.apiKey, "anthropic-version": anthropicEndpoint.version, "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1500,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        tools: [opts.tool],
        tool_choice: { type: "tool", name: opts.tool.name },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new AppError(502, (err as Error).name === "TimeoutError" ? "The AI took too long to answer. Try again." : "Couldn't reach the AI provider.", "AI_UNAVAILABLE");
  }
  const body = (await res.json().catch(() => ({}))) as {
    content?: { type: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok) throw new AppError(502, FRIENDLY[res.status] ?? `The AI provider returned an error: ${body.error?.message ?? res.status}`, "AI_ERROR");
  const call = body.content?.find((b) => b.type === "tool_use" && b.name === opts.tool.name);
  if (!call?.input) throw new AppError(502, "The AI returned an unexpected answer. Try again.", "AI_ERROR");
  return { data: call.input as T, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
}
