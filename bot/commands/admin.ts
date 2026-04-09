import type { Context } from "grammy";
import { sessionManager } from "../../sessions/manager.ts";
import { sql } from "../../memory/db.ts";
import { getApiStats, getTranscriptionStats, getMessageStats, getSessionLogs } from "../../utils/stats.ts";
import { readSkills, readCommands, readHooks, toolIcon } from "../../utils/tools-reader.ts";

export async function handleStats(ctx: Context): Promise<void> {
  await ctx.replyWithChatAction("typing");

  const [api, transcription, msgs] = await Promise.all([
    getApiStats(),
    getTranscriptionStats(),
    getMessageStats(),
  ]);

  const lines: string[] = ["📊 Statistics\n"];

  // API stats
  for (const window of ["24h", "startup", "total"] as const) {
    const a = api[window];
    if (!a?.summary?.total) continue;

    lines.push(`— API (${window}) —`);
    lines.push(`Requests: ${a.summary.total} (✓${a.summary.success} ✗${a.summary.errors})`);
    if (a.summary.total_tokens > 0) {
      lines.push(`Tokens: ${a.summary.input_tokens}→ ${a.summary.output_tokens}← (${a.summary.total_tokens})`);
    }
    lines.push(`Avg latency: ${a.summary.avg_latency_ms}ms`);

    if (a.byProvider.length > 0) {
      lines.push("Providers:");
      for (const p of a.byProvider) {
        lines.push(`  ${p.provider}/${p.model}: ${p.requests} req, ${p.tokens} tok, ${p.avg_ms}ms`);
      }
    }

    if (a.bySession.length > 0) {
      lines.push("By session:");
      for (const s of a.bySession) {
        const name = s.session_name ?? `#${s.session_id}`;
        lines.push(`  ${name}: ${s.requests} req, ${s.tokens} tok, ${s.avg_ms}ms`);
      }
    }
    lines.push("");
  }

  // Transcription stats
  for (const window of ["24h", "startup", "total"] as const) {
    const t = transcription[window];
    if (!t?.summary?.total) continue;

    lines.push(`--- Transcription (${window}) ---`);
    lines.push(`Total: ${t.summary.total} (ok ${t.summary.success} err ${t.summary.errors})`);
    lines.push(`Avg latency: ${t.summary.avg_latency_ms}ms`);

    if (t.byProvider.length > 0) {
      for (const p of t.byProvider) {
        lines.push(`  ${p.provider}: ${p.requests} req (✓${p.success}), ${p.avg_ms}ms`);
      }
    }
    lines.push("");
  }

  // Message stats
  const msgWindow = msgs["total"];
  if (msgWindow?.bySession?.length > 0) {
    lines.push("— Messages (total) —");
    for (const s of msgWindow.bySession) {
      const name = s.session_name ?? `#${s.session_id}`;
      lines.push(`  ${name}: ${s.total} (👤${s.user_msgs} 🤖${s.assistant_msgs})`);
    }
    lines.push("");
  }

  const text = lines.join("\n").trim();
  // Telegram max 4096 chars
  if (text.length > 4000) {
    await ctx.reply(text.slice(0, 4000) + "\n\n... (truncated)");
  } else {
    await ctx.reply(text);
  }
}

export async function handleLogs(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/logs\s*/, "").trim();
  const chatId = String(ctx.chat!.id);

  await ctx.replyWithChatAction("typing");

  let logs;
  let header: string;

  if (arg && !isNaN(Number(arg))) {
    // /logs <sessionId>
    const sessionId = Number(arg);
    const session = await sessionManager.get(sessionId);
    if (!session) {
      await ctx.reply("Session not found.");
      return;
    }
    header = `📋 Logs: ${session.name ?? `#${sessionId}`}`;
    logs = await getSessionLogs(sessionId, 30);
  } else {
    // /logs — current session
    const activeId = await sessionManager.getActiveSession(chatId);
    const session = await sessionManager.get(activeId);
    header = `📋 Logs: ${session?.name ?? `#${activeId}`}`;
    logs = await getSessionLogs(activeId, 30);
  }

  if (logs.length === 0) {
    await ctx.reply(`${header}\n\nNo logs.`);
    return;
  }

  const lines = [header, ""];
  for (const log of logs.reverse()) {
    const time = new Date(log.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const levelIcon = log.level === "error" ? "[ERR]" : log.level === "warn" ? "[WARN]" : "[OK]";
    lines.push(`${levelIcon} ${time} [${log.stage}] ${log.message}`);
  }

  const output = lines.join("\n");
  if (output.length > 4000) {
    await ctx.reply(output.slice(0, 4000) + "\n\n... (truncated)");
  } else {
    await ctx.reply(output);
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  // DB check
  let dbOk = false;
  try {
    await sql`SELECT 1`;
    dbOk = true;
  } catch {}

  // Ollama check
  let ollamaOk = false;
  try {
    const res = await fetch(`${process.env.OLLAMA_URL ?? "http://localhost:11434"}/api/tags`);
    ollamaOk = res.ok;
  } catch {}

  // Counts
  const [{ count: sessionCount }] = await sql`SELECT count(*) FROM sessions WHERE status = 'active'`;
  const [{ count: memoryCount }] = await sql`SELECT count(*) FROM memories`;
  const [{ count: messageCount }] = await sql`SELECT count(*) FROM messages`;

  const apiKey = process.env.ANTHROPIC_API_KEY ? "configured" : "not set";

  const lines = [
    `PostgreSQL: ${dbOk ? "OK" : "ERROR"}`,
    `Ollama: ${ollamaOk ? "OK" : "ERROR"}`,
    `API key: ${apiKey}`,
    `Active sessions: ${sessionCount}`,
    `Memories: ${memoryCount}`,
    `Messages: ${messageCount}`,
    `MCP port: ${process.env.PORT ?? 3847}`,
  ];

  await ctx.reply("Status:\n\n" + lines.join("\n"));
}

export async function handlePending(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const rows = await sql`
    SELECT id, tool_name, description, created_at
    FROM permission_requests
    WHERE chat_id = ${chatId} AND response IS NULL
    ORDER BY created_at DESC
    LIMIT 10
  `;

  if (rows.length === 0) {
    await ctx.reply("No pending permissions.");
    return;
  }

  const lines = rows.map((r) => {
    const ago = Math.round((Date.now() - new Date(r.created_at).getTime()) / 1000);
    return `${r.tool_name}: ${r.description.slice(0, 80)} (${ago}s ago)`;
  });

  await ctx.reply(`Pending permissions (${rows.length}):\n\n` + lines.join("\n\n"));
}

export async function handlePermissionStats(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/permission_stats\s*/, "").trim();
  const days = Math.min(Number(arg) || 30, 365);

  const [summary, topTools] = await Promise.all([
    sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE response = 'allow')::int AS allowed,
        count(*) FILTER (WHERE response = 'deny')::int AS denied,
        count(*) FILTER (WHERE response = 'always')::int AS always_allowed,
        count(*) FILTER (WHERE response IS NULL)::int AS pending
      FROM permission_requests
      WHERE created_at >= now() - make_interval(days => ${days})
    `,
    sql`
      SELECT
        tool_name,
        count(*)::int AS total,
        count(*) FILTER (WHERE response = 'allow')::int AS allowed,
        count(*) FILTER (WHERE response = 'deny')::int AS denied,
        count(*) FILTER (WHERE response = 'always')::int AS always_allowed
      FROM permission_requests
      WHERE created_at >= now() - make_interval(days => ${days})
      GROUP BY tool_name
      ORDER BY total DESC
      LIMIT 10
    `,
  ]);

  const s = summary[0];
  if (!s || s.total === 0) {
    await ctx.reply(`No permission requests in the last ${days} days.`);
    return;
  }

  const pct = (n: number) => s.total > 0 ? `${Math.round((n / s.total) * 100)}%` : "0%";

  const lines: string[] = [
    `Permission Stats (${days}d)\n`,
    `Total: ${s.total}`,
    `✅ Allowed: ${s.allowed} (${pct(s.allowed)})`,
    `🔵 Always: ${s.always_allowed} (${pct(s.always_allowed)})`,
    `❌ Denied: ${s.denied} (${pct(s.denied)})`,
    ...(s.pending > 0 ? [`⏳ Pending: ${s.pending}`] : []),
    "",
    "Top tools:",
  ];

  for (const t of topTools) {
    const bar = "█".repeat(Math.round((t.total / (topTools[0]?.total || 1)) * 8)).padEnd(8, "░");
    lines.push(`${bar} ${t.tool_name} (${t.total})`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: undefined });
}

export async function handleTools(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat!.id);
  const activeId = await sessionManager.getActiveSession(chatId);
  const session = await sessionManager.get(activeId);

  const httpTools = [
    "remember — save to long-term memory",
    "recall — semantic memory search",
    "forget — delete memory",
    "list_memories — list memories",
    "reply — reply to chat",
    "react — add reaction",
    "edit_message — edit message",
    "list_sessions — list sessions",
    "session_info — session info",
    "set_session_name — set session name",
  ];

  const channelTools = [
    "reply — reply to chat (HTML)",
    "update_status — update status in Telegram",
    "remember, recall, forget, list_memories — memory",
  ];

  const lines = [
    `Session: ${session?.name ?? "standalone"}\n`,
    "HTTP MCP (available to all sessions):",
    ...httpTools.map((t) => `  ${t}`),
    "",
    "Channel (available to CLI sessions):",
    ...channelTools.map((t) => `  ${t}`),
  ];

  await ctx.reply(lines.join("\n"));
}

function buildButtons(
  items: { name: string; description: string }[],
  prefix: "skill" | "cmd",
): { text: string; callback_data: string }[][] {
  return items.map((item) => {
    const icon = toolIcon(item.name);
    const desc = item.description.split(/[.·]/)[0].trim().slice(0, 38);
    const label = desc ? `${icon} ${item.name}  ·  ${desc}` : `${icon} ${item.name}`;
    return [{ text: label, callback_data: `${prefix}:${item.name}`.slice(0, 64) }];
  });
}

export async function handleSkills(ctx: Context): Promise<void> {
  await ctx.replyWithChatAction("typing");

  const skills = await readSkills();
  if (skills.length === 0) {
    await ctx.reply("No skills found in ~/.claude/skills/");
    return;
  }

  const buttons = buildButtons(skills, "skill");
  await ctx.reply(`⚡ <b>Skills</b> (${skills.length})`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

export async function handleCommands(ctx: Context): Promise<void> {
  await ctx.replyWithChatAction("typing");

  const commands = await readCommands();
  if (commands.length === 0) {
    await ctx.reply("No commands found in ~/.claude/commands/");
    return;
  }

  const buttons = buildButtons(commands, "cmd");
  await ctx.reply(`🛠 <b>Commands</b> (${commands.length})`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

export async function handleHooks(ctx: Context): Promise<void> {
  await ctx.replyWithChatAction("typing");

  const hooks = await readHooks();
  if (hooks.length === 0) {
    await ctx.reply("No hooks configured in ~/.claude/settings.json");
    return;
  }

  const byEvent = new Map<string, string[]>();
  for (const h of hooks) {
    if (!byEvent.has(h.event)) byEvent.set(h.event, []);
    const short = h.command.split(" ").pop()?.split("/").pop() ?? h.command;
    byEvent.get(h.event)!.push(h.matcher ? `${h.matcher} → ${short}` : short);
  }

  const lines = ["🪝 <b>Hooks</b>\n"];
  for (const [event, entries] of byEvent) {
    lines.push(`<b>${event}</b>`);
    for (const e of entries) lines.push(`  ${e}`);
    lines.push("");
  }

  await ctx.reply(lines.join("\n").trim(), { parse_mode: "HTML" });
}

export async function handleRules(ctx: Context): Promise<void> {
  const KNOWLEDGE_BASE = process.env.KNOWLEDGE_BASE;
  if (!KNOWLEDGE_BASE) {
    await ctx.reply("KNOWLEDGE_BASE not configured. Set the path in .env.");
    return;
  }
  try {
    const agents = await Bun.file(`${KNOWLEDGE_BASE}/AGENTS.md`).text();

    const rulesMatch = agents.match(/## 📖 Core Rule Catalog[\s\S]*?(?=\n---|\n## [^#])/);
    if (!rulesMatch) {
      await ctx.reply("Rules catalog not found.");
      return;
    }

    const lines: string[] = ["<b>Core Rules</b>\n"];
    const categoryRegex = /\*\*(.+?):\*\*/g;
    const ruleRegex = /-\s*`core\/([\w-]+)\.mdc`:\s*(.+)/g;

    const categories: { name: string; pos: number }[] = [];
    let catMatch;
    while ((catMatch = categoryRegex.exec(rulesMatch[0])) !== null) {
      categories.push({ name: catMatch[1], pos: catMatch.index });
    }

    let match;
    while ((match = ruleRegex.exec(rulesMatch[0])) !== null) {
      const cat = categories.filter((c) => c.pos < match!.index).pop();
      if (cat && !lines.some((l) => l.includes(cat.name))) {
        lines.push(`\n<b>${cat.name}</b>`);
      }
      lines.push(`  <code>${match[1]}</code> — ${match[2]}`);
    }

    if (lines.length === 1) {
      await ctx.reply("No rules found in catalog.");
      return;
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch {
    await ctx.reply(`Failed to read knowledge base (${KNOWLEDGE_BASE})`);
  }
}

export async function handleSessionExport(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/session_export\s*/, "").trim();
  const chatId = String(ctx.chat!.id);

  await ctx.replyWithChatAction("upload_document");

  let sessionId: number;
  let session: any;

  if (arg && !isNaN(Number(arg))) {
    sessionId = Number(arg);
    session = await sessionManager.get(sessionId);
    if (!session) {
      await ctx.reply("Session not found.");
      return;
    }
  } else {
    sessionId = await sessionManager.getActiveSession(chatId);
    session = await sessionManager.get(sessionId);
  }

  // Fetch messages
  const messages = await sql`
    SELECT role, content, created_at
    FROM messages
    WHERE session_id = ${sessionId} AND archived_at IS NULL
    ORDER BY created_at ASC
  `;

  // Fetch tool calls
  const tools = await sql`
    SELECT tool_name, description, response, created_at
    FROM permission_requests
    WHERE session_id = ${sessionId} AND archived_at IS NULL
    ORDER BY created_at ASC
  `;

  const msgCount = messages.length;
  const toolCount = tools.length;
  const exportedAt = new Date().toISOString();
  const sessionName = session?.name ?? `#${sessionId}`;
  const projectPath = session?.project_path ?? "—";

  // Merge chronologically
  type MsgRow = { kind: "message"; role: string; content: string; created_at: string };
  type ToolRow = { kind: "tool"; tool_name: string; description: string; response: string | null; created_at: string };
  const merged: (MsgRow | ToolRow)[] = [
    ...messages.map((m: any) => ({ kind: "message" as const, ...m })),
    ...tools.map((t: any) => ({ kind: "tool" as const, ...t })),
  ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const lines: string[] = [
    `# Session Transcript: ${sessionName}`,
    `Project: ${projectPath}`,
    `Exported: ${exportedAt}`,
    `Messages: ${msgCount} | Tool calls: ${toolCount}`,
    "",
    "---",
    "",
  ];

  for (const item of merged) {
    const time = new Date(item.created_at).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    if (item.kind === "message") {
      lines.push(`[${time}] ${item.role.toUpperCase()}`);
      lines.push(item.content);
    } else {
      lines.push(`[${time}] 🔧 TOOL: ${item.tool_name}`);
      if (item.description) lines.push(`Command: ${item.description}`);
      lines.push(`Response: ${item.response ?? "pending"}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const markdown = lines.join("\n");
  const filename = `session-${sessionId}-${new Date().toISOString().slice(0, 10)}.md`;

  await ctx.replyWithDocument(
    { source: Buffer.from(markdown, "utf8"), filename },
    { caption: `Session transcript: ${sessionName}\n${msgCount} messages · ${toolCount} tool calls` },
  );
}
