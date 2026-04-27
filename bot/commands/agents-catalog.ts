/**
 * /agents_catalog — list all available agent_definitions (templates).
 *
 * Complements /agents (lists running instances) by showing what ROLES
 * are available to instantiate. Useful entry point for /agent_create —
 * operators can discover the seeded skill-based templates from
 * goodai-base (issue-analyzer, brainstorm, prd-creator, etc.) without
 * grep'ing the DB.
 */

import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";

export async function handleAgentsCatalog(ctx: Context): Promise<void> {
  const rows = (await sql`
    SELECT name, description, runtime_type, capabilities, enabled,
           (system_prompt IS NOT NULL AND length(system_prompt) > 0) AS has_prompt
    FROM agent_definitions
    ORDER BY enabled DESC, runtime_type, name
  `) as Array<{
    name: string;
    description: string | null;
    runtime_type: string;
    capabilities: string[];
    enabled: boolean;
    has_prompt: boolean;
  }>;

  if (rows.length === 0) {
    await ctx.reply("No agent_definitions configured. Run <code>bun memory/db.ts</code>.", {
      parse_mode: "HTML",
    });
    return;
  }

  const lines: string[] = ["<b>Agent definitions (templates)</b>:\n"];

  // Group by runtime_type so the operator sees the structure at a glance.
  const byRuntime = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byRuntime.has(r.runtime_type)) byRuntime.set(r.runtime_type, []);
    byRuntime.get(r.runtime_type)!.push(r);
  }

  for (const [runtime, defs] of byRuntime) {
    lines.push(`<b>━━ ${escapeHtml(runtime)} ━━</b>`);
    for (const d of defs) {
      const status = d.enabled ? "" : " <i>(disabled)</i>";
      const promptIcon = d.has_prompt ? "🧠" : "▫️";
      const caps = d.capabilities.length > 0
        ? ` <code>[${d.capabilities.map(escapeHtml).join(",")}]</code>`
        : "";
      const desc = d.description ? `\n     <i>${escapeHtml(d.description)}</i>` : "";
      lines.push(`${promptIcon} <code>${escapeHtml(d.name)}</code>${caps}${status}${desc}`);
    }
    lines.push("");
  }

  lines.push("");
  lines.push(
    "🧠 <i>has system prompt</i>   ▫️ <i>uses default prompt</i>\n\n" +
      "<b>Spawn one</b>: <code>/agent_create &lt;name&gt; &lt;definition&gt; [project]</code>\n" +
      "Example: <code>/agent_create helyx:planner issue-analyzer helyx</code>",
  );

  // Telegram messages cap at 4096 chars; long catalogs may need chunking.
  const msg = lines.join("\n");
  if (msg.length <= 4000) {
    await ctx.reply(msg, { parse_mode: "HTML" });
    return;
  }
  // Fallback: split on the runtime_type separators.
  const chunks: string[] = [];
  let buf = "";
  for (const line of lines) {
    if (buf.length + line.length + 1 > 3500) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) chunks.push(buf);
  for (const c of chunks) {
    await ctx.reply(c, { parse_mode: "HTML" });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
