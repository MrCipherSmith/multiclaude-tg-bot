/**
 * /task <id> [subcommand] — single-task management.
 *
 * Subcommands:
 *   /task <id>                            view (default)
 *   /task <id> assign <agent_name>        reassign to a different agent_instance
 *   /task <id> sub <subtask title>        add a child task under this task
 *   /task <id> decompose [profile_name]   LLM auto-split into subtasks
 *   /task <id> <status>                   set status (pending|in_progress|blocked|review|done|cancelled|failed)
 *
 * Wraps Orchestrator (Phase 7 Wave 1, Phase 9 Wave 1). The plural /tasks command
 * is the read-only list (P4-09); this /task is per-id CRUD.
 */
import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";
import { orchestrator, type TaskStatus } from "../../agents/orchestrator.ts";
import { agentManager } from "../../agents/agent-manager.ts";
import { escapeHtml } from "../format.ts";

const VALID_STATUSES: TaskStatus[] = [
  "pending", "in_progress", "blocked", "review", "done", "cancelled", "failed",
];

const STATUS_EMOJI: Record<string, string> = {
  pending: "⏳", in_progress: "🔧", blocked: "🚧", review: "👀",
  done: "✅", cancelled: "🚫", failed: "❌",
};

export async function handleTask(ctx: Context): Promise<void> {
  const arg = ((ctx.match as string) ?? "").trim();
  if (!arg) {
    await ctx.reply(
      "Usage: <code>/task &lt;id&gt; [subcommand]</code>\n\n" +
      "Subcommands:\n" +
      "  <code>/task &lt;id&gt;</code> — view task with hierarchy\n" +
      "  <code>/task &lt;id&gt; assign &lt;agent&gt;</code> — reassign\n" +
      "  <code>/task &lt;id&gt; sub &lt;title&gt;</code> — add subtask\n" +
      "  <code>/task &lt;id&gt; decompose [profile_name]</code> — LLM auto-split into subtasks\n" +
      "  <code>/task &lt;id&gt; &lt;status&gt;</code> — set status (pending|in_progress|done|...)",
      { parse_mode: "HTML" },
    );
    return;
  }

  // Parse: first token is id, second is optional subcommand, rest are args
  const tokens = arg.split(/\s+/);
  const idStr = tokens[0];
  const taskId = parseInt(idStr, 10);
  if (!Number.isFinite(taskId) || String(taskId) !== idStr) {
    await ctx.reply(`Invalid task id: <code>${escapeHtml(idStr)}</code>`, { parse_mode: "HTML" });
    return;
  }

  const subcommand = tokens[1]?.toLowerCase();
  const subArgs = tokens.slice(2).join(" ");

  // Default: view
  if (!subcommand) {
    await viewTask(ctx, taskId);
    return;
  }

  // Reassignment
  if (subcommand === "assign") {
    if (!subArgs) {
      await ctx.reply(
        "Usage: <code>/task &lt;id&gt; assign &lt;agent_name&gt;</code>",
        { parse_mode: "HTML" },
      );
      return;
    }
    await assignTaskCommand(ctx, taskId, subArgs);
    return;
  }

  // Add subtask
  if (subcommand === "sub") {
    if (!subArgs) {
      await ctx.reply(
        "Usage: <code>/task &lt;id&gt; sub &lt;subtask title&gt;</code>",
        { parse_mode: "HTML" },
      );
      return;
    }
    await addSubtaskCommand(ctx, taskId, subArgs);
    return;
  }

  // LLM decomposition
  if (subcommand === "decompose") {
    await decomposeTaskCommand(ctx, taskId, subArgs);
    return;
  }

  // Status change
  if (VALID_STATUSES.includes(subcommand as TaskStatus)) {
    await setStatusCommand(ctx, taskId, subcommand as TaskStatus, subArgs || undefined);
    return;
  }

  await ctx.reply(
    `Unknown subcommand: <code>${escapeHtml(subcommand)}</code>\n` +
    `Valid: assign, sub, decompose, ${VALID_STATUSES.join(", ")}`,
    { parse_mode: "HTML" },
  );
}

async function viewTask(ctx: Context, taskId: number): Promise<void> {
  const tree = await orchestrator.getTaskTree(taskId);
  if (!tree) {
    await ctx.reply(`Task <code>#${taskId}</code> not found.`, { parse_mode: "HTML" });
    return;
  }

  // Resolve linked agent_instance name (if any)
  let agentLabel = "<i>(unassigned)</i>";
  if (tree.agentInstanceId) {
    const inst = await agentManager.getInstance(tree.agentInstanceId);
    if (inst) agentLabel = `<b>${escapeHtml(inst.name)}</b>`;
  }

  // Recent events for this task
  const events = await sql`
    SELECT event_type, from_state, to_state, message, created_at
    FROM agent_events
    WHERE task_id = ${taskId}
    ORDER BY id DESC
    LIMIT 5
  ` as any[];

  const lines: string[] = [];
  const emoji = STATUS_EMOJI[tree.status] ?? "❓";
  lines.push(`${emoji} <b>Task #${tree.id}</b> — <code>${tree.status}</code>`);
  lines.push(`<b>Title:</b> ${escapeHtml(tree.title)}`);
  if (tree.description) {
    const trunc = tree.description.length > 500
      ? tree.description.slice(0, 500) + "…"
      : tree.description;
    lines.push(`<b>Description:</b> ${escapeHtml(trunc)}`);
  }
  lines.push(`<b>Agent:</b> ${agentLabel}`);
  if (tree.parentTaskId) lines.push(`<b>Parent:</b> /task ${tree.parentTaskId}`);
  if (tree.priority !== 0) lines.push(`<b>Priority:</b> ${tree.priority}`);
  lines.push(`<b>Created:</b> ${formatDate(tree.createdAt)}`);
  if (tree.startedAt) lines.push(`<b>Started:</b> ${formatDate(tree.startedAt)}`);
  if (tree.completedAt) lines.push(`<b>Completed:</b> ${formatDate(tree.completedAt)}`);
  if (tree.result) {
    const resultStr = JSON.stringify(tree.result).slice(0, 200);
    lines.push(`<b>Result:</b> <code>${escapeHtml(resultStr)}</code>`);
  }

  if (tree.children.length > 0) {
    lines.push("");
    lines.push(`<b>Subtasks (${tree.children.length}):</b>`);
    for (const child of tree.children) {
      const ce = STATUS_EMOJI[child.status] ?? "❓";
      lines.push(
        `  ${ce} #${child.id} — ${escapeHtml(child.title)} <code>(${child.status})</code>`,
      );
    }
  }

  if (events.length > 0) {
    lines.push("");
    lines.push(`<b>Recent events:</b>`);
    for (const e of events) {
      const transition = e.from_state && e.to_state
        ? ` ${e.from_state}→${e.to_state}`
        : "";
      const msg = e.message
        ? `: ${escapeHtml(String(e.message).slice(0, 80))}`
        : "";
      lines.push(`  • <code>${e.event_type}</code>${transition}${msg}`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function assignTaskCommand(
  ctx: Context,
  taskId: number,
  agentName: string,
): Promise<void> {
  // Find agent_instance by name (case-sensitive). Cross-project search since /task
  // doesn't carry project context.
  const all = await agentManager.listInstances();
  const matches = all.filter((a) => a.name === agentName);
  if (matches.length === 0) {
    await ctx.reply(
      `Agent <b>${escapeHtml(agentName)}</b> not found.\n` +
      `Use /agents to list available agents.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => `#${m.id}`).join(", ");
    await ctx.reply(
      `Multiple agents named <b>${escapeHtml(agentName)}</b> found (${ids}).\n` +
      `Reassignment by name is ambiguous — please rename one of them or assign by ID via the API.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  const target = matches[0];

  try {
    await orchestrator.assignTask(taskId, target.id);
    await ctx.reply(
      `✓ Task <code>#${taskId}</code> reassigned to <b>${escapeHtml(target.name)}</b>.`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    await ctx.reply(`Error: ${escapeHtml(String(err).slice(0, 200))}`, { parse_mode: "HTML" });
  }
}

async function addSubtaskCommand(
  ctx: Context,
  parentTaskId: number,
  title: string,
): Promise<void> {
  const parent = await orchestrator.getTask(parentTaskId);
  if (!parent) {
    await ctx.reply(`Parent task <code>#${parentTaskId}</code> not found.`, { parse_mode: "HTML" });
    return;
  }

  // Inherit assignment from parent if any
  const sub = await orchestrator.createTask({
    title: title.slice(0, 200),
    parentTaskId,
    agentInstanceId: parent.agentInstanceId ?? undefined,
    payload: { source: "telegram /task sub", parent_task_id: parentTaskId },
  });
  await ctx.reply(
    `✓ Created subtask <code>#${sub.id}</code> under <code>#${parentTaskId}</code>:\n` +
    `   ${escapeHtml(sub.title)}`,
    { parse_mode: "HTML" },
  );
}

async function decomposeTaskCommand(
  ctx: Context,
  taskId: number,
  optionalProfile: string,
): Promise<void> {
  const parent = await orchestrator.getTask(taskId);
  if (!parent) {
    await ctx.reply(`Task <code>#${taskId}</code> not found.`, { parse_mode: "HTML" });
    return;
  }

  // Send "thinking" indicator
  const pending = await ctx.reply(
    `🔮 Decomposing task <code>#${taskId}</code> via LLM...\n` +
    `<i>This may take a few seconds.</i>`,
    { parse_mode: "HTML" },
  );

  try {
    const opts: { modelProfileName?: string } = {};
    if (optionalProfile) opts.modelProfileName = optionalProfile.trim();

    const result = await orchestrator.decomposeTask(taskId, opts);

    const lines: string[] = [];
    lines.push(`✅ Task <code>#${taskId}</code> decomposed into <b>${result.subtasks.length}</b> subtasks`);
    lines.push(`<i>(${result.attempts} LLM attempt${result.attempts === 1 ? "" : "s"})</i>`);
    lines.push("");
    for (const sub of result.subtasks) {
      const assignedHint = sub.agentInstanceId ? `→ agent #${sub.agentInstanceId}` : "<i>unassigned</i>";
      lines.push(`  📌 #${sub.id} <b>${escapeHtml(sub.title)}</b> ${assignedHint}`);
    }
    lines.push("");
    lines.push(`Use /task ${taskId} to view the tree.`);

    await ctx.api.editMessageText(
      pending.chat.id,
      pending.message_id,
      lines.join("\n"),
      { parse_mode: "HTML" },
    ).catch(() => {});
  } catch (err) {
    const errMsg = String(err);
    const truncated = errMsg.length > 800 ? errMsg.slice(0, 800) + "..." : errMsg;
    await ctx.api.editMessageText(
      pending.chat.id,
      pending.message_id,
      `❌ Decompose failed for task <code>#${taskId}</code>:\n\n<code>${escapeHtml(truncated)}</code>`,
      { parse_mode: "HTML" },
    ).catch(() => {});
  }
}

async function setStatusCommand(
  ctx: Context,
  taskId: number,
  status: TaskStatus,
  message?: string,
): Promise<void> {
  try {
    const updated = await orchestrator.setStatus(taskId, status, message);
    const emoji = STATUS_EMOJI[updated.status] ?? "❓";
    const note = message ? `\n   <i>${escapeHtml(message)}</i>` : "";
    await ctx.reply(
      `${emoji} Task <code>#${taskId}</code> → <code>${updated.status}</code>${note}`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    await ctx.reply(`Error: ${escapeHtml(String(err).slice(0, 200))}`, { parse_mode: "HTML" });
  }
}

function formatDate(d: Date): string {
  return new Date(d).toISOString().replace("T", " ").slice(0, 19);
}
