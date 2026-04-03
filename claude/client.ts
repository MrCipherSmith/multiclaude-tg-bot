import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config.ts";

const anthropic = new Anthropic();

export type MessageParam = Anthropic.MessageParam;

export async function* streamResponse(
  messages: MessageParam[],
  system: string,
): AsyncGenerator<string> {
  const stream = anthropic.messages.stream({
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
}

export async function generateResponse(
  messages: MessageParam[],
  system: string,
): Promise<string> {
  const response = await anthropic.messages.create({
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
