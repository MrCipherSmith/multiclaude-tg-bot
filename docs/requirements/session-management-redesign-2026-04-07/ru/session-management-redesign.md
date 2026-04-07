# PRD: Переработка управления сессиями

## 1. Обзор

Переработка системы сессий: введение постоянных проектов, двух типов сессий (remote/local) с разными жизненными циклами, автоматической суммаризации рабочего контекста при завершении сессии, векторного хранения долгосрочного контекста, семантического поиска и контекстного брифинга при переключении сессий.

## 2. Контекст

- **Продукт:** claude-bot — Telegram-бот, управляющий Claude Code сессиями
- **Модуль:** sessions, memory, mcp/tools, bot/commands
- **Стек:** Bun, grammY, PostgreSQL, pgvector, Ollama (nomic-embed-text), MCP stdio
- **Текущая версия схемы БД:** v5

## 3. Постановка проблемы

Сессии эфемерны, нет разделения на постоянные (remote) и временные (local). Нет таблицы проектов. При завершении сессии рабочий контекст теряется. При переключении между сессиями пользователь не получает брифинг — нет быстрого восстановления контекста. Отсутствует семантический поиск по накопленному контексту проекта.

## 4. Цели

- Ввести таблицу `projects` как постоянный реестр проектов
- Разделить сессии на remote (постоянные, одна на проект) и local (временные, множественные)
- При завершении сессии генерировать AI-оптимизированное структурированное саммари, векторизовать, хранить
- Управлять краткосрочной памятью remote-сессий с периодической суммаризацией
- При переключении сессий показывать пользователю саммари целевой сессии, хранить в краткосрочной памяти
- Предоставить семантический поиск по контексту проекта через MCP tool и команду бота

## 5. Не входит в scope (текущая итерация)

- Изменение механизма подключения channel.ts к Claude Code (MCP stdio остаётся)
- Настройка моделей per-task (запланировано на будущее, только структура `config` в `projects`)
- Автоматическое создание tmux-сессий (остаётся через admin-daemon)

## 5а. Запланировано на следующую итерацию

- UI дашборда для управления сессиями и проектами (просмотр статусов, история саммари, поиск по контексту)

## 6. Функциональные требования

### FR-1: Таблица проектов
Создать таблицу `projects`: `id`, `name`, `path` (уникальный), `tmux_session_name`, `config` (jsonb, расширяемый), `created_at`. Команда `/project_add` сохраняет проект в эту таблицу.

### FR-2: Remote-сессия
Одна remote-сессия на проект (`source='remote'`, `status='active'|'inactive'`). Создаётся при первом запуске проекта. Не удаляется никогда — только меняет статус. Запускается из Telegram (`/projects` → Start) или из терминала (`claude-bot start --project <name>`). Подключение = attach к tmux-сессии `bots`.

### FR-3: Local-сессия
Множество local-сессий на проект (`source='local'`). Создаётся при запуске Claude Code в терминале. Живёт пока жив процесс Claude. При завершении — `status='terminated'`. Запись хранится N дней для аудита, затем удаляется по TTL.

### FR-4: Саммари при завершении сессии
При выходе (SIGINT/SIGTERM/stdin.close) `channel.ts` вызывает `/api/sessions/:id/summarize-work`. Эндпоинт:
1. Собирает `messages` (диалог) и `permission_requests` (tool calls) для сессии
2. Отправляет в Claude API с AI-оптимизированным промтом (FR-5)
3. Векторизует через Ollama
4. Сохраняет в `memories` (`type='project_context'`, `session_id=NULL`, `project_path=X`)
5. Помечает `messages` для архивации (удаляются через N дней — настраивается, дефолт 30 дней)
6. Помечает `permission_requests` для архивации (тот же TTL)
7. Обновляет `sessions SET status='terminated'`

### FR-5: Формат и промт саммари
Формат вывода — **AI-оптимизированный структурированный текст**: машиночитаемые секции с чёткими метками, пригодные для последующей трансформации в человекочитаемый markdown. Приоритет — точность и плотность информации, не читаемость.

Промт извлекает (только при наличии контента):
```
[DECISIONS]
<decision>: <rationale>
...

[FILES]
<path>: <what_changed> | <why>
...

[PROBLEMS]
<problem>: <solution>
...

[PENDING]
<task_or_issue>
...

[CONTEXT]
<non_obvious_fact>
...
```

Правила: без вводных фраз, без дублирования очевидного, max 2000 токенов.

### FR-6: Управление памятью remote-сессии
Remote-сессия накапливает `messages` в краткосрочной памяти (ограниченное окно). Суммаризация по:
- Idle timeout (настраивается, дефолт `CONFIG.IDLE_TIMEOUT_MS`)
- Ручная команда `/summarize` в боте
- Overflow (при превышении `SHORT_TERM_WINDOW * 2`)

После суммаризации: summary сохраняется в `memories` (`type='summary'`, `project_path`), старые сообщения помечаются для архивации (TTL), сессия продолжает работать.

### FR-7: Брифинг при переключении сессий
При переключении пользователя на сессию (`/switch`, инлайн-кнопка):
1. Бот запрашивает последнее саммари целевой сессии из `memories` (по `project_path`, тип `project_context` или `summary`)
2. Выводит его пользователю в чат как брифинг перед первым сообщением
3. Сохраняет саммари в **краткосрочный in-memory кэш** (`Map<chatId, SwitchContext>`) — живёт до следующего переключения или 60 минут
4. При следующем сообщении пользователя в standalone-режиме кэш используется как системный контекст
5. При следующем переключении кэш для этого `chatId` очищается и перезаписывается

Граничный случай: если `messages` уже удалены (TTL), саммари берётся из `memories` — именно поэтому оно не привязано к `session_id`.

### FR-8: Семантический поиск по контексту проекта
**MCP tool** `search_project_context(query, project_path?)` — доступен Claude Code. Cosine similarity search по `memories WHERE type IN ('project_context', 'summary')`, возвращает топ-K с score.

**Команда бота** `/search_context <query>` — поиск по проекту активной сессии, выводит в чат.

### FR-9: Отображение сессий в боте
`/sessions` и `/projects` показывают remote-сессии со статусом (🟢 active / ⚪ inactive). Local-сессии показываются под проектом пока активны.

## 7. Нефункциональные требования

- **NFR-1:** Саммари завершается до 30 сек (timeout Claude API при выходе)
- **NFR-2:** Векторизация через Ollama — не блокирует основной поток бота
- **NFR-3:** TTL архивации `messages` и `permission_requests` — настраиваемый (дефолт 30 дней)
- **NFR-4:** Семантический поиск — latency < 500ms для базы до 10K записей
- **NFR-5:** Миграции БД — backward compatible, без даунтайма
- **NFR-6:** In-memory кэш брифинга — не персистируется, теряется при рестарте бота (приемлемо)

## 8. Ограничения

- pgvector уже установлен, размерность эмбеддингов фиксирована `CONFIG.VECTOR_DIMENSIONS`
- Ollama: graceful degradation — сохранить текст без вектора, retry при следующем старте
- `channel.ts` — отдельный процесс, читает env напрямую (без доступа к `CONFIG`)
- Одна remote-сессия на проект — unique index на уровне БД

## 9. Граничные случаи

- **Remote + Local одновременно:** сосуществуют независимо, пишут в свои `messages`
- **Ollama недоступен при выходе:** текст без эмбеддинга, retry при старте
- **SIGKILL:** `markStale()` переводит в terminated без саммари — потеря контекста сессии
- **Переключение на сессию без саммари в memories:** брифинг не показывается, кэш не заполняется
- **Переключение на сессию с удалёнными messages:** саммари берётся из `memories` (работает штатно)
- **Пустая сессия (0 сообщений):** саммари не генерируется, TTL не выставляется

## 10. Критерии приёмки (Gherkin)

```gherkin
Feature: Persistent Projects
  Scenario: Add new project
    Given бот запущен и БД доступна
    When пользователь вызывает /project_add claude-bot /home/user/bots/claude-bot
    Then в таблице projects появляется запись
    And tmux_session_name генерируется автоматически

Feature: Remote Session Lifecycle
  Scenario: Start remote session
    Given проект существует, remote-сессия inactive
    When пользователь нажимает Start в /projects
    Then admin_commands получает proj_start
    And статус меняется на 'active'

  Scenario: Remote session survives disconnect
    Given remote-сессия активна
    When channel.ts завершается (SIGTERM)
    Then запись в sessions НЕ удаляется
    And status = 'inactive'

Feature: Session Summary on Exit
  Scenario: Successful work summary
    Given local-сессия с 10+ сообщениями и 5+ tool calls
    When Claude Code завершается
    Then memories содержит запись type='project_context', session_id=NULL
    And messages помечены archived_at=now()
    And sessions.status = 'terminated'

  Scenario: Ollama недоступен
    Given local-сессия завершается, Ollama недоступен
    Then memories содержит запись с embedding=NULL
    And процесс завершается без ошибки

Feature: Session Switch Briefing
  Scenario: Переключение с существующим саммари
    Given memories содержит project_context для проекта 'claude-bot'
    When пользователь переключается на сессию этого проекта
    Then бот отправляет саммари в чат перед подтверждением переключения
    And SwitchContext кэш обновлён для chatId

  Scenario: Переключение без саммари
    Given memories не содержит записей для проекта
    When пользователь переключается на сессию
    Then бот переключается без брифинга

Feature: Semantic Search
  Scenario: MCP tool
    Given 20 memories записей для проекта
    When search_project_context("session architecture", limit=5)
    Then возвращается 5 результатов, отсортированных по similarity

  Scenario: Bot command
    Given пользователь переключён на сессию проекта
    When /search_context как работает саммаризация
    Then бот возвращает релевантные фрагменты
```

## 11. Верификация

### Тестирование
- Юнит: промт саммари — валидация структуры `[DECISIONS]`, `[FILES]` и т.д.
- Интеграция: цикл local-сессии (старт → сообщения → выход → memories → TTL-метки)
- Интеграция: переключение сессий → брифинг → кэш → следующее переключение → кэш очищен
- Ручное: remote-сессия через `/projects`, проверка статусов

### Наблюдаемость
- `[summarizer] session #X: summary saved id=Y, messages ttl-marked N rows`
- `[summarizer] ollama unavailable, saved without embedding id=Y`
- `[switch] session #X: briefing loaded from memories id=Y`
- `[switch] session #X: no briefing available`
- `/status` показывает counts в `memories` по типам

### Миграции
- **v6:** таблица `projects`
- **v7:** `archived_at` в `messages` и `permission_requests`; `project_id FK` в `sessions`; unique index remote per project
- **v8:** индекс `memories(type, project_path)`; статусы `terminated` / `inactive`
