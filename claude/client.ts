import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config.ts";

export type MessageParam = { role: "user" | "assistant"; content: string };

// Provider detection: anthropic > openrouter > ollama
const provider = process.env.ANTHROPIC_API_KEY
  ? "anthropic"
  : process.env.OPENROUTER_API_KEY
    ? "openrouter"
    : "ollama";

const openRouterModel =
  process.env.OPENROUTER_MODEL ?? "qwen/qwen3-235b-a22b:free";
const openRouterUrl =
  process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
const ollamaModel = process.env.OLLAMA_CHAT_MODEL ?? "qwen3:8b";

const anthropic = provider === "anthropic" ? new Anthropic() : null;

console.log(`[client] provider: ${provider}${provider === "openrouter" ? ` (${openRouterModel})` : provider === "ollama" ? ` (${ollamaModel})` : ""}`);

// --- OpenAI-compatible API (OpenRouter) ---

async function* openaiStream(
  messages: MessageParam[],
  system: string,
): AsyncGenerator<string> {
  const res = await fetch(`${openRouterUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: openRouterModel,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
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
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {}
    }
  }
}

async function openaiGenerate(
  messages: MessageParam[],
  system: string,
): Promise<string> {
  const res = await fetch(`${openRouterUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: openRouterModel,
      messages: [{ role: "system", content: system }, ...messages],
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  let content = data.choices?.[0]?.message?.content ?? "";
  // Strip thinking blocks if present
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return content;
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
      messages: [{ role: "system", content: system }, ...messages],
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
): Promise<string> {
  const res = await fetch(`${CONFIG.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [{ role: "system", content: system }, ...messages],
      stream: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);

  const data = (await res.json()) as { message?: { content?: string } };
  let content = data.message?.content ?? "";
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return content;
}

// --- Public API ---

export async function* streamResponse(
  messages: MessageParam[],
  system: string,
): AsyncGenerator<string> {
  switch (provider) {
    case "openrouter":
      yield* openaiStream(messages, system);
      break;
    case "ollama":
      yield* ollamaStream(messages, system);
      break;
    case "anthropic":
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
      }
      break;
  }
}

export async function generateResponse(
  messages: MessageParam[],
  system: string,
): Promise<string> {
  switch (provider) {
    case "openrouter":
      return openaiGenerate(messages, system);
    case "ollama":
      return ollamaGenerate(messages, system);
    case "anthropic": {
      const response = await anthropic!.messages.create({
        model: CONFIG.CLAUDE_MODEL,
        max_tokens: CONFIG.MAX_TOKENS,
        system,
        messages,
      });
      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
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
        content: `Проанализируй этот диалог и верни JSON:
{
  "summary": "краткое описание диалога в 2-3 предложениях",
  "facts": ["факт 1 о пользователе или решениях", "факт 2", ...]
}

Диалог:
${formatted}`,
      },
    ],
    "Ты извлекаешь структурированную информацию из диалогов. Отвечай только валидным JSON, без markdown.",
  );

  try {
    return JSON.parse(response);
  } catch {
    return { summary: response, facts: [] };
  }
}
