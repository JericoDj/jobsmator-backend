import { env } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Thin client for OpenRouter's chat completions endpoint. Provider-neutral:
 * the model is whatever `OPENROUTER_MODEL` says, and images ride along as
 * `image_url` parts (a data: URL), which every vision model there accepts.
 */

export type LlmTextPart = { type: "text"; text: string };
export type LlmImagePart = { type: "image_url"; image_url: { url: string } };
export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | (LlmTextPart | LlmImagePart)[] }
  | { role: "assistant"; content: string };

export type LlmUsage = { inputTokens: number; outputTokens: number };
export type LlmResult = { text: string; model: string; usage: LlmUsage };

type ChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object back; the caller still parses it. */
  json?: boolean;
  timeoutMs?: number;
};

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export async function chatCompletion(messages: LlmMessage[], opts: ChatOptions = {}): Promise<LlmResult> {
  if (!env.OPENROUTER_API_KEY) throw new ApiError("engine_unavailable", "The assistant isn't configured yet.");
  const model = opts.model ?? env.OPENROUTER_MODEL;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.API_PUBLIC_URL,
      "X-Title": "JobsMator",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 1500,
      temperature: opts.temperature ?? 0.4,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  }).catch((err) => {
    logger.warn({ err, model }, "openrouter unreachable");
    throw new ApiError("engine_unavailable", "The assistant is slow right now. Try again in a moment.");
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: body.slice(0, 500), model }, "openrouter error");
    throw new ApiError("engine_unavailable", "The assistant is slow right now. Try again in a moment.");
  }

  const data = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = data.choices?.[0]?.message?.content;
  const text = typeof raw === "string" ? raw : (raw ?? []).map((p) => p.text ?? "").join("");
  if (!text.trim()) throw new ApiError("engine_unavailable", "The assistant didn't answer. Try again.");

  return {
    text: text.trim(),
    model: data.model ?? model,
    usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
  };
}

/** Pulls the first `{...}` out of a reply, tolerating code fences and chatter around it. */
export function parseJsonReply<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
