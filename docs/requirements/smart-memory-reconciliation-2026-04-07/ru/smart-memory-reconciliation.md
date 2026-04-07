# PRD: Умная сверка памяти (Smart Memory Reconciliation)

## 1. Обзор

Вместо того чтобы всегда добавлять новую память через INSERT, система сначала ищет похожие существующие записи через vector similarity, затем вызывает Claude API для принятия решения: ADD / UPDATE / DELETE / NOOP. Подход взят из архитектуры mem0, реализован самостоятельно поверх существующего стека.

## 2. Контекст

- **Продукт:** claude-bot — Telegram-бот, управляющий Claude Code сессиями
- **Модуль:** memory (long-term.ts), bot/commands/memory.ts, mcp/tools.ts, memory/summarizer.ts
- **Стек:** Bun, TypeScript, PostgreSQL + pgvector, Ollama (nomic-embed-text), Claude API
- **Текущая версия схемы БД:** v8

## 3. Постановка проблемы

Текущий `remember()` всегда делает INSERT. Это приводит к:
- Дубликатам: "я использую Linux" и "пользователь работает на Linux" — две записи об одном
- Устаревшим фактам: "PostgreSQL 14" остаётся рядом с "переехали на PostgreSQL 16"
- Росту `memories` без ценности: каждый `summarizeWork` добавляет новый `project_context` не обновляя старый

## 4. Цели

- Реализовать `rememberSmart()` с LLM-сверкой перед сохранением
- Устранить дубликаты и устаревшие факты в `memories`
- Улучшить качество project_context: накапливать знания, а не дублировать их
- Сообщать пользователю что произошло (добавлено / обновлено / уже известно)

## 5. Не входит в scope

- Изменение схемы БД (UPDATE делается в-месте, новых таблиц нет)
- Пакетная дедупликация существующих записей (будущее)
- Граф связей между памятями (как в mem0 с Neo4j)
- Изменение `recall()` и `listMemories()` — только запись

## 6. Функциональные требования

### FR-1: Функция `rememberSmart()`

В `memory/long-term.ts` добавить функцию `rememberSmart(memory: Memory): Promise<ReconcileResult>`.

**Алгоритм:**
1. Embed нового контента через Ollama
2. Поиск top-5 похожих из `memories` (scope по `project_path` или `chat_id`)
3. Если похожих нет или ближайший distance > `CONFIG.MEMORY_SIMILARITY_THRESHOLD` (default `0.35`) — вызвать `remember()` напрямую, вернуть `{ action: 'added', id, content }`
4. Иначе — вызвать `reconcileWithExisting(newContent, similarMemories)` → LLM принимает решение
5. Выполнить решение (см. FR-2)

**Возвращаемый тип:**
```typescript
interface ReconcileResult {
  action: 'added' | 'updated' | 'noop';
  id: number;
  content: string;
  replacedId?: number; // если DELETE+ADD
}
```

### FR-2: LLM-решение (reconcileWithExisting)

Вызов Claude API (модель `claude-haiku-4-5-20251001`) с коротким промтом.

**Промт:**
```
You are a memory manager. Decide how to integrate new information with existing memories.

Existing memories:
[id=1] user works on Linux
[id=2] project uses PostgreSQL 14
[id=3] user prefers Vim

New information: "migrated database to PostgreSQL 16"

Rules:
- ADD: new info is distinct from all existing memories
- UPDATE id=X content="merged text": new info updates or extends memory X
- DELETE id=X: memory X is contradicted; new info replaces it (you must then ADD)
- NOOP: new info is already captured in existing memories

Reply with exactly one line. No explanation.
Examples: ADD | UPDATE id=2 content="project uses PostgreSQL 16" | DELETE id=2 | NOOP
```

**Выполнение решения:**
- `ADD` → вызвать `remember(memory)`, вернуть `{ action: 'added' }`
- `UPDATE id=X content="..."` → `UPDATE memories SET content=..., updated_at=now()`, перегенерировать embedding, вернуть `{ action: 'updated', id: X }`
- `DELETE id=X` → удалить X, вызвать `remember(memory)`, вернуть `{ action: 'added', replacedId: X }`
- `NOOP` → вернуть `{ action: 'noop', id: X, content: existing.content }`

### FR-3: Fallback при ошибках

- Ollama недоступен → embedding = null → пропустить similarity search → вызвать `remember()` напрямую (без LLM-сверки), залогировать `[memory] ollama unavailable, skipping reconciliation`
- Claude API упал → залогировать `[memory] reconcile failed: <err>, falling back to remember()` → вызвать `remember()` напрямую
- LLM вернул неразборчивый ответ → то же: fallback к `remember()`

### FR-4: Интеграция в точки вызова

**`handleRemember` (bot/commands/memory.ts):**
- Заменить `remember(...)` на `rememberSmart(...)`
- Ответ пользователю по action:
  - `added` → `Saved (#N): ...`
  - `updated` → `Updated #N: ...`
  - `noop` → `Already known (#N): ...`

**MCP tool `remember` (mcp/tools.ts):**
- Заменить `remember(...)` на `rememberSmart(...)`
- В ответ включить `action` для Claude Code

**`summarizeWork` (memory/summarizer.ts):**
- Заменить `remember(...)` на `rememberSmart(...)` при сохранении `project_context`
- При `updated` или `noop` — не создавать дубль, обновлять существующую запись

### FR-5: Конфигурация

Добавить в `config.ts`:
```typescript
MEMORY_SIMILARITY_THRESHOLD: Number(process.env.MEMORY_SIMILARITY_THRESHOLD ?? "0.35") || 0.35,
MEMORY_RECONCILE_TOP_K: Number(process.env.MEMORY_RECONCILE_TOP_K ?? "5") || 5,
```

## 7. Нефункциональные требования

- **NFR-1:** LLM-вызов для reconciliation ≤ 5 сек (haiku, короткий промт)
- **NFR-2:** Fallback не теряет данные — при любой ошибке память сохраняется через обычный `remember()`
- **NFR-3:** Нет блокировки основного потока — `summarizeWork` уже async, `handleRemember` await-ит
- **NFR-4:** Нет новых зависимостей и миграций

## 8. Ограничения

- Модель reconciliation: `claude-haiku-4-5-20251001` (дешёвая и быстрая, достаточно для однострочного решения)
- Scope поиска похожих: `project_path` если есть, иначе `chat_id`, иначе глобально
- `UPDATE` делает re-embed нового контента через Ollama (те же 768 dims)
- Нет транзакций для DELETE+ADD (приемлемо: потеря нового факта при крэше маловероятна и не критична)

## 9. Граничные случаи

- **Несколько похожих с равным distance:** LLM сам выбирает наиболее релевантную для UPDATE/NOOP
- **LLM предлагает UPDATE несуществующего ID:** fallback к ADD, лог ошибки
- **project_context type:** reconcile только в рамках того же `project_path`
- **Тип `fact` vs `note` vs `project_context`:** reconcile не смешивает типы (фильтр по `type` в similarity search)
- **Пустая summary (0 messages):** `summarizeWork` не вызывает `rememberSmart` (без изменений)
- **Два одновременных `rememberSmart` с одинаковым контентом:** race condition маловероятен, оба попадут через fallback

## 10. Критерии приёмки (Gherkin)

```gherkin
Feature: Smart Memory Reconciliation

  Scenario: Дубликат — NOOP
    Given в memories есть запись id=5 "пользователь работает на Linux"
    When /remember "я работаю на Linux"
    Then LLM возвращает NOOP
    And новая запись не создаётся
    And бот отвечает "Already known (#5): ..."

  Scenario: Обновление факта — UPDATE
    Given в memories есть запись id=3 "проект использует PostgreSQL 14"
    When /remember "переехали на PostgreSQL 16"
    Then LLM возвращает UPDATE id=3 content="проект использует PostgreSQL 16"
    And content и embedding записи #3 обновляются
    And бот отвечает "Updated #3: ..."

  Scenario: Замена устаревшего факта — DELETE+ADD
    Given в memories есть запись id=7 "пользователь использует Vim"
    When /remember "перешёл на Neovim"
    Then LLM возвращает DELETE id=7
    And запись #7 удаляется
    And создаётся новая запись
    And бот отвечает "Saved (#8): ..."

  Scenario: Новый уникальный факт — ADD без LLM
    Given нет похожих записей (distance > threshold)
    When /remember "деплой на Ubuntu 22.04"
    Then LLM не вызывается
    And новая запись создаётся
    And бот отвечает "Saved (#N): ..."

  Scenario: Ollama недоступен — fallback
    Given Ollama недоступен
    When /remember "любой факт"
    Then запись сохраняется через обычный remember()
    And в лог пишется "[memory] ollama unavailable, skipping reconciliation"

  Scenario: Claude API упал — fallback
    Given Claude API недоступен
    And есть похожие записи в memories
    When /remember "обновлённый факт"
    Then запись сохраняется через обычный remember()
    And в лог пишется "[memory] reconcile failed: ..., falling back to remember()"

  Scenario: summarizeWork не дублирует project_context
    Given в memories есть project_context id=10 для проекта 'claude-bot'
    When сессия завершается и генерируется новый project_context
    Then rememberSmart обновляет запись #10
    And дубль не создаётся
```

## 11. Верификация

### Тестирование
- Юнит: `parseReconcileDecision()` — все форматы ответа LLM (ADD, UPDATE, DELETE, NOOP, garbage)
- Юнит: `rememberSmart()` с замоканным LLM и DB — все пути (fallback, update, noop)
- Интеграция: `/remember` дубль → NOOP → `/memories` показывает одну запись
- Интеграция: `/remember` обновление → UPDATE → `updated_at` изменился, embedding пересчитан
- Ручное: запустить 5 связанных `/remember` подряд, убедиться что `/memories` не растёт бесконтрольно

### Наблюдаемость
- `[memory] reconcile: added #N` / `updated #N` / `noop #N` / `replaced #X → added #N`
- `[memory] ollama unavailable, skipping reconciliation`
- `[memory] reconcile failed: <err>, falling back to remember()`
- `[memory] reconcile: LLM returned unknown decision "<raw>", falling back`

### Без миграций
- Схема БД не меняется (v8 остаётся актуальной)
- `UPDATE memories SET content=..., embedding=...` — стандартный SQL
