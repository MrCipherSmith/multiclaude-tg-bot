/**
 * tmux-watchdog — monitors active Claude Code sessions via tmux.
 *
 * Queries the DB every 5 s for sessions with status = 'active', finds their
 * corresponding tmux windows, and checks for four categories of problems:
 *
 *   1. Permission prompts  — external MCP tool permission dialogs in the terminal.
 *      Sends Telegram message with Yes/Always/No buttons; feeds response back
 *      via tmux send-keys. Reuses the perm: callback flow.
 *
 *   2. Stall              — session shows Claude spinner but last_active is stale
 *      (channel process hung, e.g. MCP transport deadlock).
 *      Alert threshold: spinner visible + last_active > STALL_THRESHOLD_MS.
 *
 *   3. Editor open        — vim/nano opened (usually by git commit without -m).
 *      Blocks the session until the editor is closed.
 *
 *   4. Credential prompt  — git/ssh asking for password or passphrase.
 *      Blocks the session indefinitely.
 *
 *   5. Crash / restart    — Claude Code exited with a non-zero code and
 *      run-cli.sh is restarting it.
 *
 * Only windows that have a live 'active' session in the DB are inspected;
 * idle or terminated sessions are skipped entirely.
 */

import type postgres from "postgres";
import { escapeHtml } from "../utils/html.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS   = 5_000;
const TMUX_SESSION       = "bots";
const TELEGRAM_API       = "https://api.telegram.org";

// last_active is renewed every 60 s by the channel lease; alert if 2.5× stale
const STALL_THRESHOLD_MS = 150_000; // 2.5 min

// Alert cooldowns — avoid spam for persistent conditions
const STALL_COOLDOWN_MS      = 10 * 60_000; // re-alert every 10 min
const EDITOR_COOLDOWN_MS     =  5 * 60_000;
const CREDENTIAL_COOLDOWN_MS =  5 * 60_000;
const CRASH_COOLDOWN_MS      =  3 * 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveSession {
  sessionId:   number;
  project:     string;       // tmux window name
  projectPath: string | null; // absolute path — used for pane matching in split-pane mode
  lastActive:  Date;
  chatId:      string | null;
  forumChatId: string | null;
  forumTopicId:number | null;
}

interface PendingPermEntry {
  requestId:    string;
  chatId:       string;
  telegramMsgId:number | null;
  startedAt:    number;
  resolvedAt?:  number;
}

type AlertKind = "stall" | "editor" | "credential" | "crash";

interface WindowState {
  sessionId:          number;
  pendingPermission?: PendingPermEntry;
  alerts:             Partial<Record<AlertKind, number>>;  // kind → last sent ms
}

// ---------------------------------------------------------------------------
// Tmux helpers
// ---------------------------------------------------------------------------

async function runShell(cmd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const out  = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch {
    return "";
  }
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

async function capturePane(windowName: string, numLines = 60): Promise<string[]> {
  const raw = await runShell(
    `tmux capture-pane -t "${TMUX_SESSION}:${windowName}" -p -S -${numLines} 2>/dev/null || true`,
  );
  return raw.split("\n").map(stripAnsi);
}

/**
 * Capture only the current visible screen — no scroll-back.
 * Used for interactive UI detection (permission prompts, editors, credentials).
 * If a dialog has scrolled into history it has already been answered, so detecting
 * it again from scroll-back would be a false positive.
 */
async function capturePaneVisible(windowName: string): Promise<string[]> {
  const raw = await runShell(
    `tmux capture-pane -t "${TMUX_SESSION}:${windowName}" -p 2>/dev/null || true`,
  );
  return raw.split("\n").map(stripAnsi);
}

/** List windows in the bots session: [{name, index}] */
async function listBotWindows(): Promise<Array<{ name: string; index: string }>> {
  const out = await runShell(
    `tmux list-windows -t ${TMUX_SESSION} -F "#{window_index} #{window_name}" 2>/dev/null || true`,
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sp = l.indexOf(" ");
      return { index: l.slice(0, sp), name: l.slice(sp + 1).trim() };
    });
}

/**
 * List all panes across all windows in the bots session.
 * Returns [{target, currentPath}] where target is "windowIndex.paneIndex"
 * e.g. "0.1" for window 0, pane 1.
 * Used for split-pane mode where projects are panes, not windows.
 */
async function listBotPanes(): Promise<Array<{ target: string; currentPath: string }>> {
  const out = await runShell(
    `tmux list-panes -t ${TMUX_SESSION} -a -F "#{window_index}.#{pane_index} #{pane_current_path}" 2>/dev/null || true`,
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sp = l.indexOf(" ");
      return { target: l.slice(0, sp), currentPath: l.slice(sp + 1).trim() };
    });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const PERM_SIGNAL_RE  = /do you want to proceed\?/i;
const PERM_CHOICE_RE  = /❯\s*1[.)]\s*yes/i;
const SPINNER_RE      = /^[·✶✻]\s+.+/;
const VIM_RE          = /--\s*(INSERT|NORMAL|VISUAL|REPLACE)\s*--/;
const NANO_RE         = /\^G\s*(Get Help|Help)|\^X\s*(Exit|Close)/i;
const CREDENTIAL_RE   = /(password|passphrase|username for\s+['"]https?:|token).*:\s*$/i;
const CRASH_RE        = /\[run-cli\] Exited with code ([1-9]\d*)/;
// "development channels" startup warning — shown once per new Claude Code process.
// run-cli.sh already tries to auto-confirm, but this is a watchdog fallback for
// cases where the shell-side watcher times out or races with a window recreation.
const DEV_CHANNEL_SIGNAL_RE = /dangerously-load-development-channels/i;
const DEV_CHANNEL_CONFIRM_RE = /Enter to confirm/i;

/**
 * Detect the "development channels" startup warning that Claude Code shows when
 * launched with --dangerously-load-development-channels. Returns true if the
 * dialog is visible and waiting for Enter.
 * Only checks the visible screen (no scroll-back) — if it scrolled away, it was
 * already confirmed.
 */
function detectDevChannelPrompt(lines: string[]): boolean {
  const hasWarning = lines.some((l) => DEV_CHANNEL_SIGNAL_RE.test(l));
  const hasConfirm = lines.some((l) => DEV_CHANNEL_CONFIRM_RE.test(l));
  return hasWarning && hasConfirm;
}

function detectPermissionPrompt(
  lines: string[],
): { toolName: string; description: string } | null {
  let signalIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PERM_SIGNAL_RE.test(lines[i])) { signalIdx = i; break; }
  }
  if (signalIdx === -1) return null;

  const after = lines.slice(signalIdx, Math.min(lines.length, signalIdx + 6));
  if (!after.some((l) => PERM_CHOICE_RE.test(l))) return null;

  const ctx = lines.slice(Math.max(0, signalIdx - 25), signalIdx);
  let toolName = "";
  for (let i = ctx.length - 1; i >= 0; i--) {
    const line = ctx[i].trim();
    const m1 = line.match(/\b(mcp__[\w]+__[\w]+)\b/);
    if (m1) { toolName = m1[1]; break; }
    const m2 = line.match(/\b(\w+)\s*-\s*([\w_]+)\s*\(MCP\)/i);
    if (m2) { toolName = `mcp__${m2[1]}__${m2[2]}`; break; }
    const m3 = line.match(/(\w+)\s+wants\s+to\s+use\s+([\w_]+)/i);
    if (m3) { toolName = `mcp__${m3[1]}__${m3[2]}`; break; }
  }
  if (!toolName) toolName = "mcp:unknown";

  const description = ctx
    .map((l) => l.trim())
    .filter((l) => l && !/^[╭╰│─ ]+$/.test(l) && !/^[·✶✻●⎿]/.test(l))
    .slice(-4)
    .join("\n")
    .trim() || toolName;

  return { toolName, description };
}

/** True if the pane currently shows an active Claude spinner line */
function detectSpinner(lines: string[]): boolean {
  // Look at the last 10 lines (spinner is near the bottom)
  return lines.slice(-10).some((l) => SPINNER_RE.test(l.trim()));
}

function detectEditor(lines: string[]): "vim" | "nano" | null {
  for (const l of lines.slice(-20)) {
    if (VIM_RE.test(l))  return "vim";
    if (NANO_RE.test(l)) return "nano";
  }
  return null;
}

function detectCredential(lines: string[]): string | null {
  for (const l of lines.slice(-5)) {
    const m = l.trim().match(CREDENTIAL_RE);
    if (m) return m[0].trim();
  }
  return null;
}

function detectCrash(lines: string[]): number | null {
  for (const l of lines.slice(-10)) {
    const m = l.match(CRASH_RE);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alert cooldown
// ---------------------------------------------------------------------------

function canAlert(state: WindowState, kind: AlertKind, cooldownMs: number): boolean {
  const last = state.alerts[kind];
  return !last || Date.now() - last > cooldownMs;
}

function markAlerted(state: WindowState, kind: AlertKind): void {
  state.alerts[kind] = Date.now();
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

function resolveChat(
  session: ActiveSession,
): { chatId: string; forumExtra: Record<string, unknown> } | null {
  if (session.forumChatId && session.forumTopicId) {
    return { chatId: session.forumChatId, forumExtra: { message_thread_id: session.forumTopicId } };
  }
  if (session.chatId) {
    return { chatId: session.chatId, forumExtra: {} };
  }
  return null;
}

async function telegramPost(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown }> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { ok: boolean; result?: unknown };
    return data;
  } catch {
    return { ok: false };
  }
}

async function sendAlert(
  token: string,
  chatId: string,
  text: string,
  forumExtra: Record<string, unknown> = {},
  buttons?: Array<{ text: string; callback_data: string }>,
): Promise<void> {
  const reply_markup = buttons?.length
    ? { inline_keyboard: [buttons] }
    : undefined;
  await telegramPost(token, "sendMessage", {
    chat_id: Number(chatId),
    text,
    parse_mode: "HTML",
    ...(reply_markup ? { reply_markup } : {}),
    ...forumExtra,
  });
}

async function sendPermissionMessage(
  token: string,
  chatId: string,
  requestId: string,
  toolName: string,
  description: string,
  forumExtra: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: number | null }> {
  const text =
    `🔐 Allow? (terminal)\n\n` +
    `<b>${escapeHtml(toolName)}</b>\n` +
    `<i>${escapeHtml(description.slice(0, 300))}</i>`;
  const res = await telegramPost(token, "sendMessage", {
    chat_id: Number(chatId),
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Yes",    callback_data: `perm:allow:${requestId}`  },
        { text: "✅ Always", callback_data: `perm:always:${requestId}` },
        { text: "❌ No",     callback_data: `perm:deny:${requestId}`   },
      ]],
    },
    ...forumExtra,
  });
  const msgId = (res.result as { message_id?: number } | undefined)?.message_id ?? null;
  return { ok: res.ok, messageId: msgId };
}

async function editTelegramMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  await telegramPost(token, "editMessageText", {
    chat_id: Number(chatId),
    message_id: messageId,
    text,
    parse_mode: "HTML",
  });
}

// ---------------------------------------------------------------------------
// Permission prompt handling
// ---------------------------------------------------------------------------

async function handlePermissionPrompt(
  sql: postgres.Sql,
  token: string,
  windowName: string,
  state: WindowState,
  session: ActiveSession,
  detected: { toolName: string; description: string },
): Promise<void> {
  const chat = resolveChat(session);
  if (!chat) {
    console.warn(`[watchdog] no chat for ${windowName} — skipping permission`);
    return;
  }

  const requestId = `tmux-${crypto.randomUUID()}`;
  const sendResult = await sendPermissionMessage(
    token, chat.chatId, requestId,
    detected.toolName, detected.description, chat.forumExtra,
  );
  if (!sendResult.ok) {
    console.warn(`[watchdog] failed to send permission msg for ${windowName}`);
    return;
  }

  await sql`
    INSERT INTO permission_requests
      (id, session_id, chat_id, tool_name, description, message_id, tmux_target)
    VALUES
      (${requestId}, ${session.sessionId}, ${chat.chatId}, ${detected.toolName},
       ${detected.description.slice(0, 1000)}, ${sendResult.messageId},
       ${"bots:" + windowName})
    ON CONFLICT (id) DO NOTHING
  `.catch((e) => console.error("[watchdog] perm insert:", e.message));

  const entry: PendingPermEntry = {
    requestId,
    chatId: chat.chatId,
    telegramMsgId: sendResult.messageId,
    startedAt: Date.now(),
  };
  state.pendingPermission = entry;

  console.log(`[watchdog] permission prompt in ${windowName}, id=${requestId}`);
  pollPermissionResponse(sql, token, windowName, state, entry).catch((e) =>
    console.error("[watchdog] perm poll:", e.message),
  );
}

async function pollPermissionResponse(
  sql: postgres.Sql,
  token: string,
  windowName: string,
  state: WindowState,
  entry: PendingPermEntry,
): Promise<void> {
  const deadline = entry.startedAt + 600_000;

  // Give the terminal a moment to render before the first check.
  // Without this, a very fast auto-approval or key-press could make the dialog
  // disappear before we even get to check, causing an immediate false
  // "Resolved in terminal" on the very first iteration.
  await Bun.sleep(1_000);

  while (Date.now() < deadline) {
    // User responded via Telegram
    const rows = await sql`
      SELECT response FROM permission_requests
      WHERE id = ${entry.requestId} AND response IS NOT NULL
    `.catch(() => [] as any[]);

    if (rows.length > 0) {
      const behavior = rows[0].response as string;
      const key = behavior === "deny" ? "3" : behavior === "always" ? "2" : "1";
      await runShell(`tmux send-keys -t "${TMUX_SESSION}:${windowName}" "${key}" Enter`);
      console.log(`[watchdog] ${entry.requestId}: ${behavior} → key ${key}`);
      entry.resolvedAt = Date.now();
      await sql`UPDATE permission_requests SET archived_at = NOW() WHERE id = ${entry.requestId}`.catch(() => {});
      state.pendingPermission = undefined;
      return;
    }

    // Prompt disappeared — user answered in terminal.
    // Use visible-only capture: same as detection, so we don't say "gone" just
    // because the dialog scrolled into history while still being active.
    const paneLines = await capturePaneVisible(windowName);
    const stillActive = paneLines.some(
      (l) => PERM_SIGNAL_RE.test(l) || PERM_CHOICE_RE.test(l),
    );
    if (!stillActive) {
      console.log(`[watchdog] ${entry.requestId}: prompt gone (answered locally)`);
      entry.resolvedAt = Date.now();
      if (entry.telegramMsgId) {
        await editTelegramMessage(token, entry.chatId, entry.telegramMsgId, `⚡ Resolved in terminal`);
      }
      await sql`UPDATE permission_requests SET archived_at = NOW() WHERE id = ${entry.requestId}`.catch(() => {});
      state.pendingPermission = undefined;
      return;
    }

    await Bun.sleep(500);
  }

  // Timeout
  console.warn(`[watchdog] ${entry.requestId}: timeout, auto-denying`);
  await runShell(`tmux send-keys -t "${TMUX_SESSION}:${windowName}" "3" Enter`);
  entry.resolvedAt = Date.now();
  if (entry.telegramMsgId) {
    await editTelegramMessage(token, entry.chatId, entry.telegramMsgId, `⏰ Timeout — denied`);
  }
  await sql`UPDATE permission_requests SET archived_at = NOW() WHERE id = ${entry.requestId}`.catch(() => {});
  state.pendingPermission = undefined;
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

async function fetchActiveSessions(sql: postgres.Sql): Promise<ActiveSession[]> {
  const rows = await sql`
    SELECT
      s.id           AS session_id,
      s.project,
      s.project_path,
      s.last_active,
      cs.chat_id,
      p.forum_topic_id,
      bc.value       AS forum_chat_id
    FROM sessions s
    LEFT JOIN chat_sessions cs  ON cs.active_session_id = s.id
    LEFT JOIN projects p        ON p.name = s.project
    LEFT JOIN bot_config bc     ON bc.key = 'forum_chat_id'
    WHERE s.status = 'active'
      AND s.project IS NOT NULL
      AND s.id != 0
  `.catch(() => [] as any[]);

  return rows.map((r: any) => ({
    sessionId:    r.session_id   as number,
    project:      r.project      as string,
    projectPath:  r.project_path as string | null,
    lastActive:   new Date(r.last_active),
    chatId:       r.chat_id      as string | null,
    forumChatId:  (r.forum_chat_id as string) || null,
    forumTopicId: r.forum_topic_id as number | null,
  }));
}

// Chars to filter from pane snapshot (spinner frames, box-drawing, etc.)
const NOISE_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏○◐◑◒◓●▸▹►▻◆◇■□▪▫─│╭╮╰╯┌┐└┘├┤┬┴┼\s]*$/;

/** Write last N meaningful lines of the pane to sessions.pane_snapshot. */
async function writePaneSnapshot(sql: postgres.Sql, sessionId: number, lines: string[]): Promise<void> {
  const meaningful = lines
    .map(l => l.trim())
    .filter(l => l.length > 0 && !NOISE_RE.test(l))
    .slice(-6);
  if (meaningful.length === 0) return;
  const snapshot = meaningful.join("\n");
  await sql`
    UPDATE sessions SET pane_snapshot = ${snapshot}, pane_snapshot_at = NOW()
    WHERE id = ${sessionId}
  `.catch(() => {});
}

async function pollWindows(
  sql: postgres.Sql,
  token: string,
  states: Map<string, WindowState>,
): Promise<void> {
  const activeSessions = await fetchActiveSessions(sql);
  if (activeSessions.length === 0) return;

  // Build a lookup: project name → session
  const sessionByProject = new Map<string, ActiveSession>();
  for (const s of activeSessions) sessionByProject.set(s.project, s);

  // Prune states for sessions that are no longer active
  for (const name of states.keys()) {
    if (!sessionByProject.has(name)) states.delete(name);
  }

  // List actual tmux windows and panes to match sessions
  const [windows, panes] = await Promise.all([listBotWindows(), listBotPanes()]);
  const windowByName = new Map(windows.map((w) => [w.name, w.index]));

  for (const session of activeSessions) {
    const winName = session.project;

    // Primary: match by window name (dedicated-window mode)
    let tmuxTarget = windowByName.get(winName);

    // Fallback: match by project_path prefix among panes (split-pane mode)
    if (!tmuxTarget && session.projectPath) {
      const projPath = session.projectPath.replace(/\/$/, ""); // strip trailing slash
      const matched = panes.find(
        (p) => p.currentPath === projPath || p.currentPath.startsWith(projPath + "/"),
      );
      if (matched) tmuxTarget = matched.target;
    }

    if (!tmuxTarget) continue; // no tmux target for this project right now

    if (!states.has(winName)) {
      states.set(winName, { sessionId: session.sessionId, alerts: {} });
    }
    const state = states.get(winName)!;

    // Skip windows already handling a permission prompt
    if (state.pendingPermission && !state.pendingPermission.resolvedAt) continue;

    const lines = await capturePane(tmuxTarget);
    const chat  = resolveChat(session);

    // Write last meaningful lines as pane_snapshot for live status display in Telegram
    await writePaneSnapshot(sql, session.sessionId, lines);

    // 0. "Development channels" startup warning — auto-confirm silently.
    //    run-cli.sh already handles this, but the watchdog acts as a fallback
    //    if the shell-side watcher races or times out (e.g. slow Claude startup,
    //    window recreation via proj_start). No Telegram message needed.
    const visibleLines = await capturePaneVisible(tmuxTarget);
    if (detectDevChannelPrompt(visibleLines)) {
      console.log(`[watchdog] dev-channel prompt in ${winName} — auto-confirming`);
      await runShell(`tmux send-keys -t "${TMUX_SESSION}:${tmuxTarget}" "" Enter`);
      continue;
    }

    // 1. Permission prompt (highest priority — needs immediate interaction).
    //    Use visible-only capture: dialogs in scroll-back are already answered.
    const perm = detectPermissionPrompt(visibleLines);
    if (perm) {
      await handlePermissionPrompt(sql, token, tmuxTarget, state, session, perm);
      continue; // don't process other detectors in the same tick
    }

    if (!chat) continue; // no chat to send alerts to — nothing else to do

    // 2. Stall detection — spinner visible but last_active is stale
    const staleness = Date.now() - session.lastActive.getTime();
    if (detectSpinner(lines) && staleness > STALL_THRESHOLD_MS) {
      if (canAlert(state, "stall", STALL_COOLDOWN_MS)) {
        const staleMin = Math.round(staleness / 60_000);
        console.warn(`[watchdog] stall in ${winName} (${staleMin} min since last_active)`);
        await sendAlert(
          token, chat.chatId,
          `⚠️ <b>${escapeHtml(winName)}</b>: session may be stuck\n` +
          `Last MCP activity: <b>${staleMin} min ago</b> — Claude is showing spinner but channel is not responding.`,
          chat.forumExtra,
          [{ text: "⚡ Interrupt", callback_data: `tmux:esc:${winName}` }],
        );
        markAlerted(state, "stall");
      }
    } else if (staleness < STALL_THRESHOLD_MS) {
      // Activity resumed — reset stall alert so next stall alerts again promptly
      state.alerts.stall = undefined;
    }

    // 3. Editor open (vim / nano)
    const editor = detectEditor(lines);
    if (editor) {
      if (canAlert(state, "editor", EDITOR_COOLDOWN_MS)) {
        console.warn(`[watchdog] editor open in ${winName}: ${editor}`);
        await sendAlert(
          token, chat.chatId,
          `📝 <b>${escapeHtml(winName)}</b>: ${editor} opened in terminal\n` +
          `Session is blocked until the editor is closed.`,
          chat.forumExtra,
          [{ text: "📝 Force close (`:q!`)", callback_data: `tmux:close_editor:${winName}` }],
        );
        markAlerted(state, "editor");
      }
    } else {
      state.alerts.editor = undefined; // reset when editor closes
    }

    // 4. Credential prompt
    const credPrompt = detectCredential(lines);
    if (credPrompt) {
      if (canAlert(state, "credential", CREDENTIAL_COOLDOWN_MS)) {
        console.warn(`[watchdog] credential prompt in ${winName}: ${credPrompt}`);
        await sendAlert(
          token, chat.chatId,
          `🔑 <b>${escapeHtml(winName)}</b>: credential prompt in terminal\n` +
          `<code>${escapeHtml(credPrompt)}</code>\n` +
          `Session is blocked — run-cli.sh is waiting for input.`,
          chat.forumExtra,
        );
        markAlerted(state, "credential");
      }
    } else {
      state.alerts.credential = undefined;
    }

    // 5. Crash / restart
    const exitCode = detectCrash(lines);
    if (exitCode !== null) {
      if (canAlert(state, "crash", CRASH_COOLDOWN_MS)) {
        console.warn(`[watchdog] crash in ${winName}: exit code ${exitCode}`);
        await sendAlert(
          token, chat.chatId,
          `💥 <b>${escapeHtml(winName)}</b>: Claude Code exited (code ${exitCode})\n` +
          `run-cli.sh is restarting automatically.`,
          chat.forumExtra,
        );
        markAlerted(state, "crash");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start the watchdog. Returns immediately; runs the poll loop as a background task. */
export function startTmuxWatchdog(sql: postgres.Sql, token: string): void {
  const states = new Map<string, WindowState>();
  console.log("[watchdog] started (poll interval: 5 s)");

  const loop = async () => {
    while (true) {
      try {
        await pollWindows(sql, token, states);
      } catch (err: any) {
        console.error("[watchdog] poll error:", err?.message);
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  };

  loop().catch((err) => console.error("[watchdog] fatal:", err?.message));
}
