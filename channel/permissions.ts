/**
 * PermissionHandler — handles MCP permission_request notifications.
 * Loads auto-approve rules, sends Telegram messages, polls for response.
 *
 * Forum mode: when forumChatId() + forumTopicId() are both set, all messages
 * (permission requests, previews) are sent to the project topic instead of the
 * DM chat resolved from chat_sessions.
 */

import type postgres from "postgres";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StatusManager } from "./status.ts";
import { sendTelegramMessage, deleteTelegramMessage, editTelegramMessage } from "./telegram.ts";
import { channelLogger } from "../logger.ts";

export interface PermissionContext {
  sql: postgres.Sql;
  mcp: Server;
  sessionId: () => number | null;
  projectPath: string;
  token: () => string | undefined;
  homeDir: string;
  /** Forum supergroup chat ID — overrides chat_sessions lookup when set. */
  forumChatId?: () => string | null;
  /** Forum topic (thread) ID for this project session. */
  forumTopicId?: () => number | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class PermissionHandler {
  private autoApprovePatterns = new Set<string>();

  constructor(
    private ctx: PermissionContext,
    private status: StatusManager,
  ) {}

  /** Resolve forum target if configured. */
  private getForumTarget(): { chatId: string; threadId: number; extra: Record<string, unknown> } | null {
    const chatId = this.ctx.forumChatId?.();
    const topicId = this.ctx.forumTopicId?.();
    if (chatId && topicId) {
      return { chatId, threadId: topicId, extra: { message_thread_id: topicId } };
    }
    return null;
  }

  async loadAutoApproveRules(): Promise<void> {
    const encodedPath = this.ctx.projectPath.replace(/\//g, "-");
    const paths = [
      `${this.ctx.homeDir}/.claude/projects/${encodedPath}/settings.local.json`,
      `${this.ctx.homeDir}/.claude/settings.local.json`,
    ];
    for (const p of paths) {
      try {
        const text = await Bun.file(p).text();
        const settings = JSON.parse(text);
        const patterns = settings?.permissions?.allow ?? [];
        for (const pat of patterns) this.autoApprovePatterns.add(pat);
      } catch {}
    }
    if (this.autoApprovePatterns.size > 0) {
      channelLogger.info({ patterns: [...this.autoApprovePatterns] }, "auto-approve patterns loaded");
    }
  }

  isAutoApproved(toolName: string): boolean {
    if (this.autoApprovePatterns.has(`${toolName}(*)`)) return true;
    if (this.autoApprovePatterns.has(toolName)) return true;
    return false;
  }

  async handle(params: any): Promise<void> {
    const { request_id, tool_name, description } = params;
    const input = this.parseInput(params);

    if (this.isAutoApproved(tool_name)) {
      channelLogger.info({ tool: tool_name }, "auto-approved");
      await this.ctx.mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id, behavior: "allow" },
      });
      return;
    }

    const sessionId = this.ctx.sessionId();
    if (!sessionId) return;

    const token = this.ctx.token();
    if (!token) return;

    // Resolve where to send the permission request
    const forum = this.getForumTarget();
    let chatId: string | null;

    if (forum) {
      chatId = forum.chatId;
    } else {
      const chatRows = await this.ctx.sql`
        SELECT chat_id FROM chat_sessions WHERE active_session_id = ${sessionId}
      `;
      chatId = chatRows.length > 0 ? chatRows[0].chat_id : null;
    }

    if (!chatId) {
      channelLogger.warn({ sessionId }, "no chat for session, auto-denying");
      return;
    }

    const forumExtra: Record<string, unknown> = forum?.extra ?? {};

    const { desc, descMain, descDiff } = this.buildDetail(tool_name, input, description);
    const previewContent = this.buildPreview(tool_name, input, params.input_preview ?? params.input ?? "");

    const shortDesc = tool_name === "Bash" ? `Running: ${String(input?.command ?? "").slice(0, 60)}`
      : tool_name === "Read" ? `Reading: ${String(input?.file_path ?? "").split("/").pop()}`
      : tool_name === "Edit" || tool_name === "Write" ? `Editing: ${String(input?.file_path ?? "").split("/").pop()}`
      : tool_name === "Grep" ? `Searching: ${String(input?.pattern ?? "").slice(0, 40)}`
      : `${tool_name}`;
    await this.status.updateStatus(chatId, shortDesc);

    let previewMsgId: number | null = null;
    if (previewContent) {
      const lang = tool_name === "Edit" ? "diff" : "";
      const filePath = String(input?.file_path ?? input?.command ?? "").split("/").slice(-2).join("/");
      const header = filePath ? `${filePath}:\n` : "";
      const result = await sendTelegramMessage(token, chatId,
        `${escapeHtml(header)}<pre><code class="language-${lang}">${escapeHtml(previewContent)}</code></pre>`,
        { parse_mode: "HTML", ...forumExtra },
      );
      if (result.ok) previewMsgId = result.messageId;
    }

    const showDiffInline = descDiff && !previewContent;
    const msgText = showDiffInline
      ? `🔐 Allow?\n\n${escapeHtml(descMain)}\n\n<pre><code class="language-diff">${escapeHtml(descDiff)}</code></pre>`
      : `🔐 Allow?\n\n${escapeHtml(descMain)}`;
    const sendResult = await sendTelegramMessage(token, chatId, msgText, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Yes", callback_data: `perm:allow:${request_id}` },
          { text: "✅ Always", callback_data: `perm:always:${request_id}` },
          { text: "❌ No", callback_data: `perm:deny:${request_id}` },
        ]],
      },
      ...forumExtra,
    });

    if (sendResult.ok && sendResult.messageId) {
      await this.ctx.sql`
        INSERT INTO permission_requests (id, session_id, chat_id, tool_name, description, message_id)
        VALUES (${request_id}, ${sessionId}, ${chatId}, ${tool_name ?? "unknown"}, ${desc}, ${sendResult.messageId})
        ON CONFLICT (id) DO NOTHING
      `;
    }

    await this.pollForResponse(request_id, chatId, token, previewMsgId, sendResult.messageId, desc, 600_000, forumExtra);
  }

  private parseInput(params: any): Record<string, any> {
    const rawPreview = params.input_preview ?? params.input ?? "";
    const previewStr = typeof rawPreview === "string" ? rawPreview : JSON.stringify(rawPreview);
    let input: Record<string, any> = {};
    try {
      input = JSON.parse(previewStr);
    } catch {
      const fileMatch = previewStr.match(/"file_path"\s*:\s*"([^"]+)"/);
      const cmdMatch = previewStr.match(/"command"\s*:\s*"([^"]+)"/);
      const patternMatch = previewStr.match(/"pattern"\s*:\s*"([^"]+)"/);
      if (fileMatch) input.file_path = fileMatch[1];
      if (cmdMatch) input.command = cmdMatch[1];
      if (patternMatch) input.pattern = patternMatch[1];
      const oldMatch = previewStr.match(/"old_string"\s*:\s*"([\s\S]*?)(?:","new_string"|"$)/);
      const newMatch = previewStr.match(/"new_string"\s*:\s*"([\s\S]*?)(?:","replace_all"|","file_path"|"$|\s*\}?\s*$)/);
      if (oldMatch) input.old_string = oldMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      if (newMatch) input.new_string = newMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      const contentMatch = previewStr.match(/"content"\s*:\s*"([\s\S]*?)(?:"$|\s*\}?\s*$)/);
      if (contentMatch) input.content = contentMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    return input;
  }

  private buildDetail(
    tool_name: string,
    input: Record<string, any>,
    description: string | undefined,
  ): { desc: string; descMain: string; descDiff: string } {
    let detail = "";
    if (tool_name === "Bash" && input.command) detail = `$ ${input.command}`;
    else if (tool_name === "Read" && input.file_path) detail = input.file_path;
    else if ((tool_name === "Edit" || tool_name === "Write") && input.file_path) {
      detail = input.file_path;
      if (input.old_string != null && input.new_string != null) {
        const oldLines = String(input.old_string).split("\n").map((l: string) => `- ${l}`);
        const newLines = String(input.new_string).split("\n").map((l: string) => `+ ${l}`);
        detail += `\n\n${[...oldLines, ...newLines].join("\n").slice(0, 1500)}`;
      } else if (input.content) {
        detail += `\n\n${String(input.content).slice(0, 1500)}`;
      }
    } else if (tool_name === "Grep" && input.pattern) detail = `grep "${input.pattern}"`;
    else if (input._raw) detail = input._raw;
    else detail = JSON.stringify(input).slice(0, 200);

    if (description && detail && !detail.includes("\n\n")) detail += `\n${description}`;
    else if (description && !detail) detail = description;

    let descMain = tool_name;
    let descDiff = "";
    if (detail.includes("\n\n")) {
      const idx = detail.indexOf("\n\n");
      descMain += `\n${detail.slice(0, idx)}`;
      descDiff = detail.slice(idx + 2);
    } else {
      descMain += `\n${detail}`;
    }
    descMain = descMain.trim();
    return { desc: descMain, descMain, descDiff };
  }

  private buildPreview(tool_name: string, input: Record<string, any>, rawPreview: unknown): string {
    const previewStr = typeof rawPreview === "string" ? rawPreview : JSON.stringify(rawPreview);
    if ((tool_name === "Edit" || tool_name === "Write" || tool_name === "Bash") && previewStr.length > 10) {
      if (tool_name === "Edit" && input.old_string != null && input.new_string != null) {
        const oldLines = String(input.old_string).split("\n").map((l: string) => `- ${l}`);
        const newLines = String(input.new_string).split("\n").map((l: string) => `+ ${l}`);
        return [...oldLines, ...newLines].join("\n").slice(0, 3000);
      } else if (tool_name === "Write" && input.content) {
        return String(input.content).slice(0, 3000);
      } else if (tool_name === "Bash" && input.command && input.command.length > 80) {
        return input.command.slice(0, 3000);
      }
    }
    return "";
  }

  private async pollForResponse(
    request_id: string,
    chatId: string,
    token: string,
    previewMsgId: number | null,
    telegramMsgId: number | null,
    desc: string,
    timeoutMs = 600_000,
    forumExtra: Record<string, unknown> = {},
  ): Promise<void> {
    const startTime = Date.now();
    let resolved = false;
    let lastReminderAt = startTime;
    let reminderMsgId: number | null = null;
    const REMINDER_INTERVAL_MS = 60_000;

    while (Date.now() - startTime < timeoutMs) {
      const rows = await this.ctx.sql`
        SELECT response FROM permission_requests WHERE id = ${request_id} AND response IS NOT NULL
      `;
      if (rows.length > 0) {
        const behavior = rows[0].response;
        await this.ctx.mcp.notification({
          method: "notifications/claude/channel/permission",
          params: { request_id, behavior },
        });
        channelLogger.info({ requestId: request_id, behavior }, "permission resolved via telegram");
        if (previewMsgId) deleteTelegramMessage(token, chatId, previewMsgId);
        if (reminderMsgId) deleteTelegramMessage(token, chatId, reminderMsgId);
        await this.status.updateStatus(chatId, "Processing...");
        this.loadAutoApproveRules().catch(() => {});
        resolved = true;
        break;
      }

      const exists = await this.ctx.sql`SELECT 1 FROM permission_requests WHERE id = ${request_id} AND archived_at IS NULL`;
      if (exists.length === 0) {
        channelLogger.info({ requestId: request_id }, "permission resolved externally");
        if (previewMsgId) deleteTelegramMessage(token, chatId, previewMsgId);
        if (reminderMsgId) deleteTelegramMessage(token, chatId, reminderMsgId);
        if (telegramMsgId) {
          await editTelegramMessage(token, chatId, telegramMsgId, `⚡ Resolved in terminal\n\n${desc}`);
        }
        await this.status.updateStatus(chatId, "Processing...");
        resolved = true;
        break;
      }

      // Send reminder every 60s
      if (Date.now() - lastReminderAt >= REMINDER_INTERVAL_MS) {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const remainingSec = Math.round((timeoutMs - (Date.now() - startTime)) / 1000);
        const reminderText = `🔔 Pending permission (${elapsedSec}s elapsed, ${remainingSec}s left):\n<code>${escapeHtml(desc.slice(0, 200))}</code>`;
        if (reminderMsgId) deleteTelegramMessage(token, chatId, reminderMsgId);
        const result = await sendTelegramMessage(token, chatId, reminderText, { parse_mode: "HTML", ...forumExtra });
        if (result.ok && result.messageId) reminderMsgId = result.messageId;
        lastReminderAt = Date.now();
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (reminderMsgId) deleteTelegramMessage(token, chatId, reminderMsgId);

    if (!resolved) {
      channelLogger.warn({ requestId: request_id }, "permission timeout, denying");
      await this.ctx.sql`UPDATE permission_requests SET status = 'expired' WHERE id = ${request_id} AND status = 'pending'`;
      await this.ctx.mcp.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id, behavior: "deny" },
      });
      if (previewMsgId) deleteTelegramMessage(token, chatId, previewMsgId);
      if (telegramMsgId) {
        await editTelegramMessage(token, chatId, telegramMsgId, `⏰ Timeout\n\n${desc}`);
      }
    }

    await this.ctx.sql`UPDATE permission_requests SET archived_at = NOW() WHERE id = ${request_id}`;
  }
}
