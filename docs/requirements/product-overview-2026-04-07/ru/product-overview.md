# PRD: Claude Bot — Обзор продукта

## 1. Обзор

Claude Bot — Telegram-бот для удалённого управления несколькими сессиями Claude Code CLI. Позволяет отправлять задачи голосом и текстом, получать уведомления о прогрессе, подтверждать разрешения инструментов и работать с долгосрочной памятью проектов — всё через Telegram с телефона или ноутбука.

## 2. Контекст

| Поле | Значение |
|------|---------|
| **Продукт** | Claude Bot (multiclaude-tg-bot) |
| **Версия** | v1.10.0 |
| **Модуль** | Весь продукт |
| **Роль пользователя** | Разработчик, управляющий AI-агентами удалённо |
| **Стек** | Bun · TypeScript · grammY · MCP SDK · PostgreSQL 16 + pgvector · Ollama · React + Tailwind · Docker |

## 3. Проблемы, которые решает продукт

### 3.1 Удалённое управление Claude Code
Claude Code работает только в терминале. Пользователь не может отправить задачу с телефона, не открывая SSH-сессию и не сидя за компьютером.

**Решение:** Telegram-бот принимает сообщения и доставляет их в нужный CLI-процесс через MCP-протокол.

### 3.2 Потеря контекста между сессиями
Когда Claude Code перезапускается, весь контекст диалога теряется. Нет способа сказать: "продолжай с того места, где остановился вчера".

**Решение:** Dual-layer память: короткий контекст (sliding window, PostgreSQL) + долгосрочная (pgvector embeddings через Ollama). При выходе из сессии автоматически создаётся AI-саммари, векторизируется и сохраняется в базу.

### 3.3 Управление несколькими проектами
У пользователя 3–10 активных проектов. Переключаться между ними в терминале неудобно: каждый раз нужно вспоминать контекст, что было сделано.

**Решение:** `/switch` показывает брифинг из последнего project_context саммари. При переключении системный контекст загружается автоматически.

### 3.4 Подтверждение разрешений без доступа к терминалу
Claude Code запрашивает разрешение на запись файлов, запуск команд. Без ответа — процесс висит.

**Решение:** Permission requests форвардятся в Telegram как inline-кнопки (Allow / Always / Deny) с превью файла и diff. Ответ синхронизируется обратно в терминал.

### 3.5 Накопление дублирующей памяти
При частом использовании `/remember` база накапливает устаревшие и дублирующие факты.

**Решение:** Smart Memory Reconciliation — перед сохранением ищет похожие факты через vector similarity, отдаёт решение Claude Haiku: ADD / UPDATE / DELETE / NOOP.

### 3.6 Голос и изображения в Claude Code
CLI не принимает голосовые сообщения и фото напрямую.

**Решение:** Бот транскрибирует голос через Groq (whisper-large-v3, ~200ms) и анализирует изображения через Claude API.

---

## 4. Цели

- Обеспечить полноценное управление несколькими Claude Code сессиями через Telegram
- Сохранять контекст проекта между сессиями с минимальной потерей информации
- Минимизировать дублирование в долгосрочной памяти через LLM-дедупликацию
- Предоставить web-дашборд для мониторинга статистики, логов и памяти
- Упростить onboarding через one-line installer и setup wizard

## 5. Не цели

- Не является заменой Claude Code CLI (расширяет, а не заменяет)
- Не поддерживает multi-user (несколько Telegram-пользователей с изоляцией) — в дорожной карте
- Не управляет файлами и кодом напрямую — только транспорт и память
- Не предоставляет собственный AI-движок — использует внешние провайдеры

---

## 6. Функциональные требования

### FR-1: MCP-сервер (HTTP, порт 3847)
Бот запускает HTTP MCP-сервер с инструментами: `remember`, `recall`, `forget`, `list_memories`, `reply`, `react`, `edit_message`, `list_sessions`, `session_info`, `set_session_name`, `search_project_context`. Claude Code подключается как MCP-клиент.

### FR-2: Channel Adapter (stdio)
`channel.ts` — stdio MCP-адаптер, запускаемый как `--channels "bun channel.ts"`. Регистрирует/усыновляет сессию в PostgreSQL, поллит `message_queue` (500ms + LISTEN/NOTIFY), форвардит сообщения через `notifications/claude/channel`.

### FR-3: Управление сессиями
- **Remote-сессии** (`source=remote`): одна постоянная на проект, не удаляется, статус `active|inactive`
- **Local-сессии** (`source=local`): временные, по одной на CLI-процесс, статус `terminated` при выходе
- **Таблица projects**: постоянный реестр проектов, добавляется через `/project_add`
- **Очистка**: ежечасная автоочистка stale-сессий, orphan-сессий, TTL-архивирование (30 дней по умолчанию)

### FR-4: Dual-Layer Memory
- **Короткая**: sliding window 20 сообщений, in-memory + PostgreSQL `messages`
- **Долгосрочная**: `memories` table с `embedding vector(768)`, HNSW-индекс, поиск по косинусной дистанции
- **Векторизация**: Ollama (`nomic-embed-text`, 768 dims), graceful degradation если недоступна

### FR-5: Smart Memory Reconciliation
`rememberSmart()` — перед вставкой:
1. Embed нового контента
2. Найти top-K похожих (по `project_path` или `chat_id`, тот же тип)
3. Если distance ≤ threshold (0.35): передать список + новый контент в Claude Haiku
4. Исполнить решение: ADD / UPDATE id / DELETE id + ADD / NOOP
5. Fallback при недоступности Ollama или Claude API → обычный `remember()`

### FR-6: Work Summary on Exit
При выходе `channel.ts` вызывает `/api/sessions/:id/summarize-work`. Суммаризатор:
- Берёт последние N сообщений сессии
- Формирует структурированный summary: `[DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]`
- Сохраняет как `type='project_context'` в `memories` (через `rememberSmart`)
- Архивирует сообщения: `archived_at = now()`

### FR-7: Session Switch Briefing
`/switch [id]` показывает:
- Последний project_context из memories для проекта
- Последние 5 сообщений сессии
- Инжектирует контекст в системный промпт следующего сообщения

### FR-8: Standalone Mode
Без активной CLI-сессии: бот сам отвечает через LLM (Anthropic / Google AI / OpenRouter / Ollama). Стриминг с периодическими правками сообщения. Auto-summarization после 15 мин простоя.

### FR-9: Telegram UX
- Markdown → Telegram HTML рендеринг с syntax highlighting
- Голосовые сообщения: Groq whisper-large-v3 (~200ms), fallback на локальный Whisper
- Изображения: Claude API (CLI-режим) / Anthropic API (standalone)
- Permission requests: inline-кнопки Allow / Always / Deny с diff-превью
- Auto-approve: паттерны в `settings.local.json` (e.g. `"Edit(*)"`) пропускают Telegram-шаг
- Live status: real-time прогресс от CLI через tmux-мониторинг

### FR-10: Web Dashboard
React + Tailwind SPA, доступна через порт 3847:
- **Overview**: аптайм, статус DB, активные сессии, токены за 24ч
- **Sessions**: список сессий с фильтрами, rename, delete
- **Stats**: токены/запросы по провайдеру, проекту, операции, графики за 30 дней
- **Logs**: per-session логи с поиском
- **Memory**: hot context (топ-10 последних), tag cloud с удалением по тегу, индикатор Indexing...

### FR-11: CLI-утилита (`claude-bot`)
Установка, setup wizard, управление tmux-сессиями, backup, мониторинг. Команды: `setup`, `connect`, `up`, `down`, `ps`, `add`, `remove`, `backup`, `logs`, `status`.

---

## 7. Нефункциональные требования

| NFR | Требование |
|-----|-----------|
| NFR-1 | Поллинг message_queue: задержка ≤ 500ms (LISTEN/NOTIFY снижает до ~0ms) |
| NFR-2 | Smart reconciliation: полный цикл ≤ 5 секунд |
| NFR-3 | Embedding Ollama: ≤ 2 секунды с 2 retry и exponential backoff |
| NFR-4 | Dashboard API: ответ ≤ 500ms |
| NFR-5 | Graceful degradation: Ollama недоступен → remember() без векторов |
| NFR-6 | Session heartbeat: channel.ts обновляет last_active каждые 5 минут |
| NFR-7 | Cleanup: stale-сессии не удаляются при старте бота (защита от race condition при рестарте) |
| NFR-8 | Docker-first: весь стек поднимается через `docker compose up -d` |

---

## 8. Ограничения

- **Один пользователь**: `ALLOWED_USERS` — whitelist Telegram ID, нет ролей
- **Один Ollama**: embeddings только с одного хоста
- **PostgreSQL**: база данных не шардируется, вертикальное масштабирование
- **grammY polling/webhook**: один бот-инстанс, не горизонтально масштабируется без перехода на webhook + балансировщик
- **MCP protocol**: только Claude Code CLI как MCP-клиент (совместим со спецификацией, но тестировался только с Claude Code)

---

## 9. Граничные случаи

- **Ollama недоступен при remember()**: `embedSafe()` возвращает null, память сохраняется без вектора (поиск по ней не работает, но данные не теряются)
- **Claude API недоступен при reconcile**: fallback на `remember()` без дедупликации
- **Рестарт бота**: startup cleanup пропускает markStale, channel.ts переподключается и обновляет last_active
- **SIGKILL на channel.ts**: сессия остаётся `active` в БД — heartbeat через 5 мин не придёт, через 10 мин markStale пометит как stale
- **Два channel.ts для одного проекта**: advisory lock предотвращает конкуренцию за session
- **Длинный ответ CLI**: chunking на 4096 символов с сохранением форматирования
- **Параллельные remember()**: счётчик `_indexingCount` корректно отображает `indexing: true` пока активен хоть один вызов

---

## 10. Дорожная карта

### Реализовано ✅
- Multi-session MCP server
- Channel Adapter (stdio bridge)
- Dual-layer memory (short-term + pgvector)
- Smart Memory Reconciliation (LLM-дедупликация)
- Persistent projects + remote/local session lifecycle
- Work summary on exit + session switch briefing
- Semantic search (`search_project_context`)
- Permission forwarding с inline-кнопками
- Voice transcription (Groq) + image analysis
- Standalone mode (4 провайдера)
- Web Dashboard (Overview, Sessions, Stats, Logs, Memory)
- Skills / Commands / Hooks интеграция
- Session heartbeat + startup cleanup fix
- Visual Memory Map (hot context + tag cloud)
- Embeddings indexing indicator

### Запланировано ⬜
- **Dashboard: управление проектами** — создание/запуск/остановка проектов из web-интерфейса (сейчас только Telegram)
- **Multi-user** — изолированные сессии и память для нескольких Telegram-пользователей
- **Inline mode** — ответы в любом Telegram-чате через `@bot query`
- **Webhook hardening** — горизонтальное масштабирование через webhook + балансировщик (сейчас polling работает с одним инстансом)
- **Memory TTL per type** — разные TTL для разных типов воспоминаний (fact vs summary)
- **Dashboard notifications** — push-уведомления в браузере о состоянии сессий

---

## 11. Критерии приёмки (Gherkin)

```gherkin
Feature: Удалённое управление Claude Code через Telegram

  Scenario: Отправка задачи в активную CLI-сессию
    Given пользователь подключён к Telegram-боту
    And есть активная local-сессия для проекта "my-app"
    When пользователь отправляет сообщение "добавь тесты для AuthService"
    Then бот показывает статус "Thinking..."
    And channel.ts получает сообщение через message_queue
    And Claude Code CLI получает notification/claude/channel
    And Claude Code отвечает через MCP tool reply()
    And бот доставляет ответ в Telegram с HTML-форматированием

  Scenario: Permission request из CLI
    Given Claude Code пытается выполнить Bash-команду
    And команда не в auto-approve списке
    When channel.ts получает permission_request notification
    Then бот отправляет сообщение с inline-кнопками Allow / Always / Deny
    And показывает preview команды или diff файла
    When пользователь нажимает "Allow"
    Then permission_request обновляется в БД
    And Claude Code получает подтверждение и продолжает

  Scenario: Smart Memory Reconciliation
    Given в памяти проекта есть факт "используется PostgreSQL 15"
    When пользователь вызывает /remember "обновились до PostgreSQL 16"
    Then rememberSmart() находит похожий факт с distance ≤ 0.35
    And отправляет оба в Claude Haiku для решения
    And Haiku отвечает UPDATE id=X content="используется PostgreSQL 16"
    And в БД обновляется существующая запись
    And бот отвечает "Updated #X"

  Scenario: Work Summary при выходе из сессии
    Given активна local-сессия для проекта "my-app"
    When channel.ts получает SIGTERM или stdin.close
    Then вызывается /api/sessions/:id/summarize-work
    And суммаризатор берёт последние сообщения сессии
    And генерирует structured summary с секциями [DECISIONS][FILES][PROBLEMS][PENDING][CONTEXT]
    And сохраняет как type='project_context' через rememberSmart()
    And архивирует сообщения сессии (archived_at = now())

  Scenario: Session Switch с брифингом
    Given пользователь в сессии "project-a"
    And для "project-b" есть сохранённый project_context
    When пользователь вызывает /switch на сессию "project-b"
    Then бот показывает последний project_context саммари
    And показывает последние 5 сообщений сессии
    And следующее сообщение пользователя получает системный контекст из саммари

  Scenario: Graceful degradation при недоступности Ollama
    Given Ollama недоступен (connection refused)
    When пользователь вызывает /remember "новый факт"
    Then embedSafe() возвращает null без исключения
    And факт сохраняется в БД без embedding-вектора
    And бот отвечает "Saved (#N)" без ошибок

  Scenario: Heartbeat защищает долгую сессию
    Given active local-сессия существует в БД
    And Claude Code выполняет долгую автономную задачу (>10 мин без MCP-вызовов)
    Then channel.ts каждые 5 мин обновляет last_active в БД
    And cleanup-таймер не помечает сессию как stale
```

---

## 12. Верификация

### Ручное тестирование
- `claude-bot connect . --tmux` → сессия появляется в `/sessions`
- Отправить сообщение → Claude Code получает, отвечает через `reply`
- Голосовое сообщение → транскрипция → ответ CLI
- `/remember "факт"` → повторный `/remember "тот же факт"` → ответ "Already known"
- `/switch` → показывает брифинг

### Автоматическая проверка
- `GET /health` → `{"status":"ok"}`
- `GET /api/overview` → `{sessions, tokens24h, indexing}`
- `GET /api/memories/tags` → массив `{tag, count}`
- Docker: `docker compose ps` → все контейнеры running

### Наблюдаемость
- Логи бота: `docker logs claude-bot-bot-1 -f`
- Dashboard: `http://localhost:3847`
- `/status` в Telegram → DB, Ollama, сессии
- `/stats` → токены, стоимость по провайдеру
