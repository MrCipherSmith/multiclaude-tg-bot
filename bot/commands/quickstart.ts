import type { Context } from "grammy";
import { replyInThread } from "../format.ts";

const QUICKSTART_TEXT = `🚀 <b>Быстрый старт</b>

<b>Шаг 1 — Создай форум-группу</b>
Создай Telegram Supergroup → включи Topics (настройки группы → Topics) → добавь бота администратором.

<b>Шаг 2 — Настрой форум</b>
В группе: /forum_setup

<b>Шаг 3 — Добавь проекты</b>
В личных сообщениях с ботом: /project_add
(бот создаст топик для каждого проекта в форуме)

<b>Шаг 4 — Синхронизируй топики</b>
В группе: /forum_sync

<b>Шаг 5 — Запусти Claude Code в проекте</b>
<code>claude</code> — в директории проекта.
Бот автоматически подключит сессию к нужному топику.

<b>Шаг 6 — Настрой супервизор (опционально)</b>
Создай отдельный топик "Supervisor" в форуме → скопируй его ID → добавь в <code>.env</code>:
<code>SUPERVISOR_TOPIC_ID=&lt;id топика&gt;</code>
Супервизор будет слать туда алерты и отвечать на вопросы о состоянии системы.
Запусти: <code>bun scripts/admin-daemon.ts</code>

✅ <b>Готово.</b> В каждом топике — своя сессия Claude Code.

<i>Используй /help для полного списка команд.</i>`;

export async function handleQuickstart(ctx: Context): Promise<void> {
  await replyInThread(ctx, QUICKSTART_TEXT, { parse_mode: "HTML" });
}
