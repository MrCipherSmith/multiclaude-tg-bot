import type { CliAdapter, CliConfig, MessageMeta } from "./types.ts";
import { sql } from "../memory/db.ts";

const DEFAULT_PORT = 4096;
const REQUEST_TIMEOUT_MS = 30_000;

/** Validate and return base URL — prevents SSRF via user-controlled port */
function baseUrl(config: CliConfig): string {
  const port = Number(config.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid opencode port: ${port}`);
  }
  // Allow overriding host via env var for Docker deployments (OPENCODE_HOST=opencode)
  const host = process.env.OPENCODE_HOST ?? "localhost";
  return `http://${host}:${port}`;
}

/** Validate tmux session name — prevents command injection via user-controlled cliConfig */
function validateTmuxSession(name: string): string {
  if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(name)) {
    throw new Error(`Invalid tmuxSession value: "${name}"`);
  }
  return name;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const msg = (err as Error)?.message ?? String(err);
      const is5xx = /5\d\d/.test(msg);
      if (is5xx && attempt < retries - 1) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[opencode] ${label} retry ${attempt + 1}/${retries} after ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * OpencodeAdapter — communicates with `opencode serve` via HTTP REST API.
 *
 * Send path:  POST /session/:opencodeSessionId/prompt_async
 * Subscribe:  GET  /event  (SSE stream) — handled by subscribeToResponses()
 * Alive check: GET /session → 200 OK
 *
 * The opencode session ID is stored in cli_config.opencodeSessionId.
 * If not present, one is created via POST /session on first send.
 */
/** Normalize cli_config — handles broken states: JSONB string, array of strings, or object */
export function normalizeCLIConfig(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    // Broken state: array of JSON strings — merge them all
    const merged: Record<string, unknown> = {};
    for (const item of raw) {
      try {
        const parsed = typeof item === "string" ? JSON.parse(item) : item;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          Object.assign(merged, parsed);
        }
      } catch { /* skip */ }
    }
    return merged;
  }
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

export class OpencodeAdapter implements CliAdapter {
  readonly type = "opencode" as const;

  /**
   * Ensure an opencode session exists, creating one if needed.
   * Stores the opencode session ID in the sessions.cli_config column.
   * Uses read-merge-write to avoid JSONB || operator issues.
   */
  private async ensureOpencodeSession(
    sessionId: number,
    config: CliConfig,
  ): Promise<string> {
    const rows = await sql`SELECT cli_config FROM sessions WHERE id = ${sessionId}`;
    const cliConfig = normalizeCLIConfig(rows[0]?.cli_config);

    if (typeof cliConfig.opencodeSessionId === "string") {
      return cliConfig.opencodeSessionId;
    }

    // Create a new opencode session
    const res = await withRetry(
      () => fetchWithTimeout(`${baseUrl(config)}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      "create session",
    );

    if (!res.ok) {
      throw new Error(`opencode POST /session failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { id?: string };
    const opencodeSessionId = data.id;
    if (!opencodeSessionId) throw new Error("opencode session creation returned no ID");

    // Merge and write back as proper JSONB object
    const updated = { ...cliConfig, opencodeSessionId };
    await sql`
      UPDATE sessions SET cli_config = ${JSON.stringify(updated)}::jsonb
      WHERE id = ${sessionId}
    `;

    console.log(`[opencode] created session ${opencodeSessionId} for bot session #${sessionId}`);
    return opencodeSessionId;
  }

  async send(sessionId: number, text: string, meta: MessageMeta): Promise<void> {
    const config = await this.getConfig(sessionId);

    // Autostart if configured and process is not alive
    if (config.autostart && !(await this.isAlive(config))) {
      await this.autostart(config);
    }

    const opencodeSessionId = await this.ensureOpencodeSession(sessionId, config);

    // Throw inside withRetry so 5xx actually triggers retries
    await withRetry(
      async () => {
        const r = await fetchWithTimeout(
          `${baseUrl(config)}/session/${opencodeSessionId}/prompt_async`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: [{ type: "text", text }] }),
          },
        );
        if (!r.ok && r.status !== 204) {
          throw new Error(`opencode prompt_async failed: ${r.status}`);
        }
      },
      "send message",
    );

    // Persist message to short-term memory (same as Claude path)
    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id, delivered)
      VALUES (${sessionId}, ${meta.chatId}, ${meta.fromUser}, ${text}, ${meta.messageId ?? ""}, true)
      ON CONFLICT DO NOTHING
    `;
  }

  async isAlive(config: CliConfig): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${baseUrl(config)}/session`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async getConfig(sessionId: number): Promise<CliConfig> {
    const rows = await sql`SELECT cli_config FROM sessions WHERE id = ${sessionId}`;
    return normalizeCLIConfig(rows[0]?.cli_config) as CliConfig;
  }

  private async autostart(config: CliConfig): Promise<void> {
    const port = config.port ?? DEFAULT_PORT;
    console.log(`[opencode] autostart: spawning opencode serve --port ${port}`);

    if (config.tmuxSession) {
      // Spawn in tmux window — validate session name against strict pattern
      const tmuxTarget = validateTmuxSession(config.tmuxSession);
      Bun.spawn([
        "tmux", "new-window", "-t", tmuxTarget,
        "-n", "opencode",
        "opencode", "serve", "--port", String(port),
      ]);
    } else {
      // Background process
      Bun.spawn(["opencode", "serve", "--port", String(port)], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }

    // Wait for server to be ready (max 10s)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.isAlive(config)) {
        console.log(`[opencode] server ready after ${i + 1}s`);
        return;
      }
    }
    throw new Error(`opencode serve did not start within 10s on port ${port}`);
  }

  /**
   * Subscribe to opencode SSE event stream and forward response chunks to Telegram.
   * Returns an unsubscribe function.
   *
   * @param sessionId  Bot session ID
   * @param onChunk    Called with each text chunk from opencode
   * @param onDone     Called when the response is complete
   * @param onError    Called on SSE connection error
   */
  async subscribeToResponses(
    sessionId: number,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): Promise<() => void> {
    const config = await this.getConfig(sessionId);
    const url = `${baseUrl(config)}/event`;

    // Get the opencode session ID to filter SSE events
    const rows = await sql`SELECT cli_config FROM sessions WHERE id = ${sessionId}`;
    const opencodeSessionId = normalizeCLIConfig(rows[0]?.cli_config).opencodeSessionId as string | undefined;

    let stopped = false;
    let doneCalled = false;
    const controller = new AbortController();

    // Guard against double-fire of onDone (multiple completion signals in SSE)
    const safeDone = () => {
      if (doneCalled) return;
      doneCalled = true;
      onDone();
    };

    const run = async () => {
      try {
        const res = await fetch(url, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`opencode SSE stream failed: ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No SSE response body");

        const decoder = new TextDecoder();
        let buffer = "";

        // Track which message IDs are assistant messages, and accumulated text per part
        const assistantMessageIds = new Set<string>();
        const partTexts = new Map<string, string>(); // partId → accumulated text so far

        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") { safeDone(); return; }
            try {
              const event = JSON.parse(data) as Record<string, any>;
              const props = event.properties ?? {};
              const evSessionId = props.sessionID;

              // Only process events for our opencode session
              if (evSessionId && evSessionId !== opencodeSessionId) continue;

              if (event.type === "message.updated") {
                // Track which message IDs belong to assistant
                if (props.info?.role === "assistant" && props.info?.id) {
                  assistantMessageIds.add(props.info.id);
                }
              } else if (event.type === "message.part.updated") {
                const part = props.part ?? {};
                // Only stream text parts from assistant messages
                if (part.type === "text" && assistantMessageIds.has(part.messageID)) {
                  const fullText: string = part.text ?? "";
                  const prev = partTexts.get(part.id) ?? "";
                  const delta = fullText.slice(prev.length);
                  if (delta) {
                    partTexts.set(part.id, fullText);
                    onChunk(delta);
                  }
                }
              } else if (event.type === "session.status") {
                // session.status {type:"idle"} signals response is complete
                if (props.status?.type === "idle") {
                  safeDone();
                  return;
                }
              }
            } catch {
              // ignore parse errors
            }
          }
        }
        safeDone();
      } catch (err: unknown) {
        if (!stopped) onError(err as Error);
      }
    };

    run();

    return () => {
      stopped = true;
      controller.abort();
    };
  }

  /**
   * List available models from opencode.
   * Returns array of model IDs.
   */
  async listModels(config: CliConfig): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(`${baseUrl(config)}/model`, { method: "GET" });
      if (!res.ok) return [];
      const data = await res.json() as unknown;
      if (Array.isArray(data)) {
        return (data as Array<{ id?: string }>).map((m) => m.id ?? String(m)).filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * List configured provider connections from opencode.
   */
  async listProviders(config: CliConfig): Promise<Array<{ id: string; name: string; configured: boolean }>> {
    try {
      const res = await fetchWithTimeout(`${baseUrl(config)}/provider`, { method: "GET" });
      if (!res.ok) return [];
      const data = await res.json() as unknown;
      if (Array.isArray(data)) return data as Array<{ id: string; name: string; configured: boolean }>;
      return [];
    } catch {
      return [];
    }
  }
}

export const opencodeAdapter = new OpencodeAdapter();
