// FR-C-10: human-in-the-loop approval for agent-created skills.
//
// Sends a Telegram message with [Save] / [Reject] / [Edit name…] inline
// keyboard. Called from `propose_skill` after a row is inserted as 'proposed'.
// The bot dispatcher (`bot/callbacks.ts`) routes the callback queries:
//   skill:save:<id>     → approveSkill(id) → status='active'
//   skill:reject:<id>   → rejectSkill(id) → status='rejected'
//   skill:editname:<id> → set pending state, wait for next text message

import { sendTelegramMessage } from "../channel/telegram.ts";

const TG_TEXT_MAX = 3500; // Telegram caps at 4096 chars; reserve room for header/buttons.

export interface SkillApprovalParams {
  skillId: number;
  name: string;
  description: string;
  body: string;
  warnings?: string[];
  chatId: string;
  topicId?: number;
}

function buildKeyboard(skillId: number) {
  return {
    inline_keyboard: [
      [
        { text: "💾 Save", callback_data: `skill:save:${skillId}` },
        { text: "❌ Reject", callback_data: `skill:reject:${skillId}` },
      ],
      [
        { text: "✏️ Edit name", callback_data: `skill:editname:${skillId}` },
      ],
    ],
  };
}

function buildMessage(params: SkillApprovalParams): string {
  const { name, description, body, warnings = [] } = params;
  const warningBlock = warnings.length > 0
    ? `\n\n⚠️ <b>Warnings:</b>\n${warnings.map((w) => `• ${w}`).join("\n")}`
    : "";
  // Truncate body preview — full skill is in postgres; this message is a
  // human review aid, not a content channel.
  const bodyPreview = body.length > TG_TEXT_MAX
    ? body.slice(0, TG_TEXT_MAX) + "\n…[truncated]"
    : body;
  return [
    `🧠 <b>New skill proposed: <code>${escapeHtml(name)}</code></b>`,
    "",
    `<i>${escapeHtml(description)}</i>`,
    warningBlock,
    "",
    "<pre>" + escapeHtml(bodyPreview) + "</pre>",
    "",
    "Choose an action:",
  ].filter(Boolean).join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendSkillApprovalMessage(
  params: SkillApprovalParams,
): Promise<{ ok: boolean; messageId: number | null }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[skill-approval] TELEGRAM_BOT_TOKEN not set — skipping notification");
    return { ok: false, messageId: null };
  }

  const text = buildMessage(params);
  const extra: Record<string, unknown> = {
    parse_mode: "HTML",
    reply_markup: buildKeyboard(params.skillId),
  };
  if (params.topicId !== undefined) {
    extra.message_thread_id = params.topicId;
  }

  const res = await sendTelegramMessage(token, params.chatId, text, extra);
  if (!res.ok) {
    console.warn("[skill-approval] sendMessage failed:", res.errorBody);
  }
  return { ok: res.ok, messageId: res.messageId };
}

export interface CuratorActionMessage {
  actionId: number;
  skillName: string;
  action: string;
  reason: string;
  chatId: string;
  topicId?: number;
}

export async function sendCuratorApprovalMessage(
  params: CuratorActionMessage,
): Promise<{ ok: boolean; messageId: number | null }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[curator-approval] TELEGRAM_BOT_TOKEN not set — skipping notification");
    return { ok: false, messageId: null };
  }

  const text = [
    `🔧 <b>Curator action: <code>${escapeHtml(params.skillName)}</code></b>`,
    `<i>Action:</i> ${escapeHtml(params.action)}`,
    `<i>Reason:</i> ${escapeHtml(params.reason)}`,
    "",
    "Approve or skip — auto-expires in 24h.",
  ].join("\n");

  const extra: Record<string, unknown> = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `cur:approve:${params.actionId}` },
        { text: "⏭ Skip", callback_data: `cur:skip:${params.actionId}` },
      ]],
    },
  };
  if (params.topicId !== undefined) {
    extra.message_thread_id = params.topicId;
  }

  const res = await sendTelegramMessage(token, params.chatId, text, extra);
  if (!res.ok) {
    console.warn("[curator-approval] sendMessage failed:", res.errorBody);
  }
  return { ok: res.ok, messageId: res.messageId };
}

export interface CuratorSummary {
  examined: number;
  pinned: number;
  archived: number;
  proposedConsolidate: number;
  proposedPatch: number;
  costUsd?: number;
  status: string;
  error?: string;
}

export async function sendCuratorSummary(
  summary: CuratorSummary,
  chatId: string,
  topicId?: number,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[curator-summary] TELEGRAM_BOT_TOKEN not set — skipping");
    return;
  }

  const lines = [
    `📋 <b>Curator run: ${escapeHtml(summary.status)}</b>`,
    `Examined: ${summary.examined}`,
    `Pinned: ${summary.pinned}, Archived: ${summary.archived}`,
    `Proposed consolidate: ${summary.proposedConsolidate}, patch: ${summary.proposedPatch}`,
  ];
  if (summary.costUsd !== undefined && summary.costUsd > 0) {
    lines.push(`Cost: $${summary.costUsd.toFixed(4)}`);
  }
  if (summary.error) {
    lines.push("", `⚠️ ${escapeHtml(summary.error)}`);
  }

  const extra: Record<string, unknown> = { parse_mode: "HTML" };
  if (topicId !== undefined) extra.message_thread_id = topicId;

  await sendTelegramMessage(token, chatId, lines.join("\n"), extra);
}
