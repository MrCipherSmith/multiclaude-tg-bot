# PRD: UX Improvements — Forum Topics, Error Messages, Onboarding

**Date:** 2026-04-10  
**Status:** Draft  
**Priority:** P1 — Next sprint  
**Scope:** Silent failures, error messages, queue feedback, onboarding, dashboard notifications

---

## 1. Context

A UX review identified 5 friction points ranging from silent data loss (voice message sent to disconnected topic with no user feedback) to confusing error messages that block new users. This PRD covers all non-security improvements found in the review.

---

## 2. Issues

### 2.1 [High] Voice Message Sent to Disconnected Topic — Silent Failure

**What:** When a user sends a voice message to a forum topic whose CLI session is disconnected, the bot transcribes it (Whisper API call, ~5-20s, costs money) and then silently discards it. `media.ts:292` logs `"no handler for mode=disconnected"` but the user receives nothing.

**User experience:** User sends voice, sees "🎤 downloading..." then "🎤 Transcribed: ..." then — silence. They don't know if the message was lost, queued, or why the bot stopped responding.

**Fix — `bot/media.ts`:** After transcription, check route mode before processing. If disconnected, send a clear error:

```typescript
} else {
  // disconnected
  appendLog(route.sessionId, chatId, "voice", `no handler for mode=${route.mode}`, "warn");
  await bot.api.editMessageText(
    ctx.chat!.id, statusMsg.message_id,
    `🎤 Transcribed: ${text}\n\n⚠️ Нет активной сессии. Сообщение не отправлено.\n` +
    `/sessions — список сессий | /switch 0 — standalone режим`
  );
}
```

**Additional improvement:** Skip transcription entirely for disconnected topics — show the error before the Whisper API call:

```typescript
if (route.mode === "disconnected") {
  await ctx.reply(
    `⚠️ Нет активной CLI-сессии для этого проекта.\n` +
    `Голосовое сообщение не обработано.\n\n` +
    `/sessions | /switch 0 — standalone`
  );
  return;
}
// ... then transcribe
```

---

### 2.2 [High] "Session is not active" Error — Unhelpful Message

**What:** When a text message arrives for a disconnected session:

```typescript
await replyInThread(ctx,
  `⚠️ Session <b>${route.sessionName ?? `#${route.sessionId}`}</b> is not active.\n\n` +
  `/switch 0 — standalone mode\n/sessions — list all sessions`,
  { parse_mode: "HTML" },
);
```

The message lists generic commands but gives no context: why did it disconnect? How do I reconnect THIS project specifically?

**Fix — `bot/text-handler.ts`:** Provide project-specific guidance:

```typescript
const sessionLabel = route.sessionName ?? `#${route.sessionId}`;
const projectHint = route.projectPath
  ? `\n📁 Проект: <code>${route.projectPath}</code>`
  : "";
await replyInThread(ctx,
  `⚠️ Сессия <b>${sessionLabel}</b> не активна.${projectHint}\n\n` +
  `Если Claude Code запущен — сессия подключится автоматически при следующем запуске.\n` +
  `Или:\n` +
  `/switch 0 — перейти в standalone (без Claude Code)\n` +
  `/sessions — все сессии`,
  { parse_mode: "HTML" },
);
```

---

### 2.3 [Medium] No Feedback During Queue Wait in Forum

**What:** After the per-topic queue was added (commit `0c30f7a`), messages in standalone mode are queued. If topic A is processing a long LLM response and topic B sends a message, topic B's user sees nothing until topic A finishes — could be 30-60 seconds.

**User experience:** Looks like the bot is broken or frozen.

**Fix — `bot/topic-queue.ts`:** Add a queue depth counter per key and return queue position:

```typescript
const queueDepth = new Map<string, number>();

export function enqueueForTopic(
  key: string,
  task: () => Promise<void>,
  onQueued?: (position: number) => void,
): void {
  const depth = (queueDepth.get(key) ?? 0) + 1;
  queueDepth.set(key, depth);
  if (depth > 1 && onQueued) onQueued(depth - 1); // position in queue

  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev
    .then(task)
    .catch((err) => logger.error({ err, key }, "topic queue task failed"))
    .finally(() => {
      const d = (queueDepth.get(key) ?? 1) - 1;
      if (d <= 0) queueDepth.delete(key);
      else queueDepth.set(key, d);
    });
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
}
```

In `bot/text-handler.ts`, pass the callback:

```typescript
enqueueForTopic(queueKey, async () => { /* ... */ }, async (position) => {
  await replyInThread(ctx, `⏳ В очереди (#${position}). Предыдущий запрос обрабатывается...`);
});
```

---

### 2.4 [Medium] Typing Indicator Not Refreshed During Long Responses

**What:** `ctx.replyWithChatAction("typing")` is sent once at the start of processing. Telegram clears the typing indicator after ~5 seconds. For responses that take 30-60 seconds (complex code generation), the user sees no activity for most of the wait.

**Fix — `bot/streaming.ts`:** Add a periodic typing indicator refresher during streaming:

```typescript
// Before streaming starts:
const typingInterval = setInterval(() => {
  bot.api.sendChatAction(chatId, "typing").catch(() => {});
}, 4000);

try {
  // ... existing streaming code
} finally {
  clearInterval(typingInterval);
}
```

---

### 2.5 [Low] No `/quickstart` Command — Onboarding Scattered

**What:** New users face 20+ commands in `/help` with no guided path for the main workflow:
1. Create forum supergroup
2. Run `/forum_setup`
3. Add projects
4. Connect CLI sessions

**Fix — `bot/commands/session.ts` (or new `bot/commands/quickstart.ts`):**

Add `/quickstart` that sends a step-by-step guide:

```
🚀 Быстрый старт

Шаг 1 — Создай форум-группу
Создай Telegram Supergroup → включи Topics → добавь бота администратором

Шаг 2 — Настрой форум
В группе: /forum_setup

Шаг 3 — Добавь проекты
В DM: /project_add

Шаг 4 — Синхронизируй топики
В группе: /forum_sync

Шаг 5 — Запусти Claude Code в проекте
Бот автоматически подключит сессию к нужному топику.

Готово. В каждом топике — своя сессия Claude Code.
```

---

### 2.6 [Low] Dashboard Doesn't Notify Telegram on Session Crash

**What:** When a CLI session crashes (status changes to `terminated` or `error`), the user only finds out when they next send a message and get the "session not active" error. The dashboard shows the correct status, but doesn't push a notification.

**Fix — `mcp/server.ts` or a new session watcher:**

When `session.status` changes to `terminated` unexpectedly (not via user /cleanup command), send a Telegram notification to the associated forum topic:

```typescript
// In sessionManager — hook into status changes:
async function notifySessionTerminated(sessionId: number): Promise<void> {
  const session = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
  if (!session.length) return;
  const { forum_topic_id, chat_id, name, project_path } = session[0];
  if (!forum_topic_id || !chat_id) return;

  const bot = getBotRef();
  await bot.api.sendMessage(chat_id,
    `⚠️ Сессия <b>${name ?? `#${sessionId}`}</b> завершилась.\n` +
    (project_path ? `📁 ${project_path}\n` : "") +
    `\nЗапусти Claude Code заново — бот подключится автоматически.`,
    { parse_mode: "HTML", message_thread_id: forum_topic_id }
  );
}
```

---

## 3. Implementation Plan

### Phase 1 — Quick wins (no rebuild needed after restart)

These are pure code changes; deploy by rebuilding the Docker image.

| Priority | Issue | File | Effort |
|----------|-------|------|--------|
| **High** | Voice silent failure — early exit | `bot/media.ts` | 15 min |
| **High** | Disconnected session message — better text | `bot/text-handler.ts` | 10 min |
| **Medium** | Typing indicator refresh | `bot/streaming.ts` | 15 min |
| **Medium** | Queue depth feedback | `bot/topic-queue.ts` + `bot/text-handler.ts` | 30 min |

### Phase 2 — New features

| Priority | Feature | Files | Effort |
|----------|---------|-------|--------|
| **Low** | `/quickstart` command | `bot/commands/quickstart.ts` + `bot/handlers.ts` | 30 min |
| **Low** | Session crash notifications | `sessions/manager.ts` + `mcp/server.ts` | 45 min |

### Deployment order

```bash
# After code changes:
cd ~/bots/claude-bot

# 1. Run tests
bun test tests/unit/

# 2. Rebuild image
docker compose build bot

# 3. Restart (< 10s downtime)
docker compose restart bot

# 4. Verify health
curl http://localhost:3847/health
```

No database migrations required. No config changes required.

---

## 4. Acceptance Criteria

- [ ] Voice message to disconnected topic → immediate error shown, transcription skipped
- [ ] Text message to disconnected topic → shows project path + actionable recovery steps
- [ ] Typing indicator visible throughout long LLM responses (refreshed every 4s)
- [ ] Second message in same topic while first is processing → shows "⏳ В очереди (#1)"
- [ ] `/quickstart` command works in both DM and forum (shows only if bot is admin in forum)
- [ ] Session crash → notification sent to forum topic within 30 seconds
- [ ] `bun test tests/unit/` — all 77 tests pass

---

## 5. What Does NOT Change

- Forum routing logic (`sessions/router.ts`) — already correct
- Per-topic queue mechanics (just added in `0c30f7a`) — only extends with depth counter
- Memory/summarization flow — unchanged
- Access control — unchanged
