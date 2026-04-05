import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config.ts";
import { recordApiRequest } from "../utils/stats.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type MessageParam = { role: "user" | "assistant"; content: string | ContentBlock[] };

/** Extract text content from a message for non-Anthropic providers */
function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

/** Convert messages to plain text for OpenAI/Ollama */
function toTextMessages(messages: MessageParam[]): { role: string; content: string }[] {
  return messages.map((m) => ({ role: m.role, content: contentToString(m.content) }));
}

// Provider detection: anthropic > openai-compatible (openrouter etc) > ollama
const openaiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const openaiUrl = process.env.OPENROUTER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1";
const openaiModel = process.env.OPENROUTER_MODEL ?? process.env.OPENAI_MODEL ?? "qwen/qwen3-235b-a22b:free";
const ollamaModel = process.env.OLLAMA_CHAT_MODEL ?? "qwen3:8b";

const provider = process.env.ANTHROPIC_API_KEY
  ? "anthropic"
  : openaiKey
    ? "openai"
    : "ollama";

const anthropic = provider === "anthropic" ? new Anthropic() : null;

export function getProviderInfo() {
  const model = provider === "anthropic" ? CONFIG.CLAUDE_MODEL
    : provider === "openai" ? openaiModel
    : ollamaModel;
  return { provider, model };
}

console.log(`[client] provider: ${provider}${provider === "openai" ? ` (${openaiModel} @ ${openaiUrl})` : provider === "ollama" ? ` (${ollamaModel})` : ""}`);

// --- OpenAI-compatible API (OpenRouter) ---

// Shared usage from last streaming chunk
let _lastStreamUsage: { input?: number; output?: number } = {};
export function getLastStreamUsage() { return _lastStreamUsage; }

async function* openaiStream(
  messages: MessageParam[],
  system: string,
): AsyncGenerator<string> {
  _lastStreamUsage = {};

  const res = await fetch(`${openaiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: openaiModel,
      messages: [{ role: "system", content: system }, ...toTextMessages(messages)],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter failed: ${res.status} ${await res.text()}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        // Capture usage from final chunk
        if (parsed.usage) {
          _lastStreamUsage = {
            input: parsed.usage.prompt_tokens,
            output: parsed.usage.completion_tokens,
          };
        }
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {}
    }
  }
}

interface GenerateResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
}

async function openaiGenerate(
  messages: MessageParam[],
  system: string,
): Promise<GenerateResult> {
  const res = await fetch(`${openaiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: openaiModel,
      messages: [{ role: "system", content: system }, ...toTextMessages(messages)],
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  let content = data.choices?.[0]?.message?.content ?? "";
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return {
    content,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

// --- Ollama chat API ---

async function* ollamaStream(
  messages: MessageParam[],
  system: string,
): AsyncGenerator<string> {
  const res = await fetch(`${CONFIG.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: "system", content: system }, ...toTextMessages(messages)],
      stream: true,
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let thinkingDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const content = data.message?.content ?? "";
        if (content) {
          if (!thinkingDone) {
            if (content.includes("</think>")) {
              thinkingDone = true;
              const after = content.split("</think>").pop() ?? "";
              if (after) yield after;
            }
            continue;
          }
          yield content;
        }
      } catch {}
    }
  }
}

async function ollamaGenerate(
  messages: MessageParam[],
  system: string,
): Promise<GenerateResult> {
  const res = await fetch(`${CONFIG.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: "system", content: system }, ...toTextMessages(messages)],
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);

  const data = (await res.json()) as any;
  let content = data.message?.content ?? "";
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return {
    content,
    inputTokens: data.prompt_eval_count,
    outputTokens: data.eval_count,
  };
}

// --- Public API ---

export interface StreamContext {
  sessionId?: number | null;
  chatId?: string | null;
  operation?: string;
}

export async function* streamResponse(
  messages: MessageParam[],
  system: string,
  ctx?: StreamContext,
): AsyncGenerator<string> {
  const { provider: p, model: m } = getProviderInfo();
  const start = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let error: string | undefined;

  try {
    switch (provider) {
      case "openai":
        yield* openaiStream(messages, system);
        // Capture usage from last SSE chunk
        { const u = getLastStreamUsage(); inputTokens = u.input; outputTokens = u.output; }
        break;
      case "ollama":
        yield* ollamaStream(messages, system);
        break;
      case "anthropic": {
        const stream = anthropic!.messages.stream({
          model: CONFIG.CLAUDE_MODEL,
          max_tokens: CONFIG.MAX_TOKENS,
          system,
          messages,
        });
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield event.delta.text;
          }
          if (event.type === "message_delta" && (event as any).usage) {
            outputTokens = (event as any).usage.output_tokens;
          }
        }
        const final = await stream.finalMessage();
        inputTokens = final.usage?.input_tokens;
        outputTokens = final.usage?.output_tokens;
        break;
      }
    }
  } catch (err: any) {
    error = err?.message ?? String(err);
    throw err;
  } finally {
    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: p,
      model: m,
      operation: ctx?.operation ?? "chat",
      durationMs: Date.now() - start,
      status: error ? "error" : "success",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens && outputTokens ? inputTokens + outputTokens : null,
      errorMessage: error,
    });
  }
}

export async function generateResponse(
  messages: MessageParam[],
  system: string,
  ctx?: StreamContext,
): Promise<string> {
  const { provider: p, model: m } = getProviderInfo();
  const start = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    let result: string;
    switch (provider) {
      case "openai": {
        const r = await openaiGenerate(messages, system);
        result = r.content;
        inputTokens = r.inputTokens;
        outputTokens = r.outputTokens;
        break;
      }
      case "ollama": {
        const r = await ollamaGenerate(messages, system);
        result = r.content;
        inputTokens = r.inputTokens;
        outputTokens = r.outputTokens;
        break;
      }
      case "anthropic": {
        const response = await anthropic!.messages.create({
          model: CONFIG.CLAUDE_MODEL,
          max_tokens: CONFIG.MAX_TOKENS,
          system,
          messages,
        });
        inputTokens = response.usage?.input_tokens;
        outputTokens = response.usage?.output_tokens;
        result = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        break;
      }
    }

    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: p,
      model: m,
      operation: ctx?.operation ?? "generate",
      durationMs: Date.now() - start,
      status: "success",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens && outputTokens ? inputTokens + outputTokens : null,
    });

    return result;
  } catch (err: any) {
    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: p,
      model: m,
      operation: ctx?.operation ?? "generate",
      durationMs: Date.now() - start,
      status: "error",
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

export async function summarizeConversation(
  messages: { role: string; content: string }[],
): Promise<{ summary: string; facts: string[] }> {
  const formatted = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const response = await generateResponse(
    [
      {
        role: "user",
        content: `Analyze this conversation and return JSON:
{
  "summary": "brief description of the conversation in 2-3 sentences",
  "facts": ["fact 1 about the user or decisions", "fact 2", ...]
}

Conversation:
${formatted}`,
      },
    ],
    "You extract structured information from conversations. Reply only with valid JSON, no markdown.",
  );

  try {
    return JSON.parse(response);
  } catch {
    return { summary: response, facts: [] };
  }
}
