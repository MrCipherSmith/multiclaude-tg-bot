# PRD: Фаза C — Autonomous Skill Creator

## 1. Обзор

После успешной многошаговой задачи helyx предлагает (или автономно решает) дистиллировать workflow в переиспользуемый SKILL.md и сохранить как `agent-created` скилл. Метаданные скилла живут в postgres (`agent_created_skills`); body SKILL.md регенерируется по запросу для потребления Claude Code.

Зеркалит `tools/skill_manager_tool.py::skill_manage(action='create')` Hermes + autonomous learning loop, адаптировано под архитектуру helyx (Claude-Code-MCP).

## 2. Контекст

- **Продукт**: helyx (родительский PRD: `./overview.md`)
- **Модуль**: подсистема скиллов — новый postgres-backed реестр + aux-LLM distiller + Telegram approval flow
- **Роль пользователя**: потребитель скиллов, который тацитно создаёт скиллы через продуктивные сессии
- **Стек**: Postgres для реестра, Bun для оркестрации, OpenAI-совместимый aux-LLM (DeepSeek default, Ollama fallback)

**Триггеры**:
1. Граница сессии — агент сам детектит «это был полезный многошаговый успех» через эвристику
2. Явная команда пользователя — `/save-as-skill <name>`
3. Прямой MCP-call — агент вызывает `mcp__helyx__propose_skill` с summary

**Хранилище**:
- Метаданные скилла + body — в postgres (`agent_created_skills`)
- Файл SKILL.md генерируется на диске лениво, только когда Claude Code запрашивает через `skill_view` фазы A
- Файлы пишутся в `~/.claude/skills/agent-created/<name>/SKILL.md` (mode 0700)

**Дистилляция**:
- aux-LLM (DeepSeek default) видит transcript задачи + структурированный промпт
- Шаблон промпта в `prompts/skill-distillation.md`
- Validator проверяет frontmatter, name regex, лимиты длины, префикс "Use when"

## 3. Постановка проблемы

Сегодня, когда агент решает сложную проблему (debug postgres.js v3 jsonb cast или настройка forum topic routing), workflow исчезает вместе с разговором. В следующий раз тот же класс проблемы переоткрывается с нуля — потраченные токены, потраченное время пользователя.

Hermes решает это через `is_agent_created` скиллы + дистилляционный шаг. Адаптируем: helyx ведёт postgres-реестр agent-created скиллов, с Telegram approval flow как human-in-the-loop переходом из `proposed` в `active`.

## 4. Цели

- **G-C-1** — после многошагового успеха агент МОЖЕТ вызвать `propose_skill` MCP-tool с summary задачи
- **G-C-2** — пользователь МОЖЕТ approve через Telegram inline-кнопку ИЛИ через `/save-as-skill` команду
- **G-C-3** — auto-approval опционален для доверенных эвристик (≥3 tool-calls + чистые lint/tests + сигнал удовлетворённости пользователя)
- **G-C-4** — сохранённые скиллы queryable через `agent_created_skills` и видны в dashboard
- **G-C-5** — body сохранённых скиллов МОЖЕТ использовать токены inline-shell фазы A для динамического контекста

## 5. Чего НЕ делаем

- Автоматическое улучшение SKILL.md после создания — это фаза B (curator)
- Шаринг agent-created скиллов между пользователями — single installation в v1
- Frontmatter за пределами Hermes-spec subset (name, description, version, author, license, metadata.helyx.{tags,related_skills})
- Version-control скиллов через git внутри helyx — они живут только в postgres
- Полностью авто-создавать без user gate в v1 — heuristic auto-approval — пост-launch tuning

## 6. Функциональные требования

- **FR-C-1** — MCP-tool `propose_skill` ПРИНИМАЕТ `{ name, description, body, source_session_id }` и возвращает `{ success: bool, skill_id, errors? }`
- **FR-C-2** — MCP-tool `save_skill` ПРИНИМАЕТ `{ skill_id, approved: bool }` и финализирует (status='active') или отклоняет (status='rejected')
- **FR-C-3** — MCP-tool `list_agent_skills` ВОЗВРАЩАЕТ `Array<{ name, description, status, use_count, last_used_at, created_at }>`
- **FR-C-4** — Validator ПРИНУЖДАЕТ: name regex `^[a-z][a-z0-9-]{0,63}$`, description ≤1024 chars, body ≤100000 chars, frontmatter parseable как YAML mapping
- **FR-C-5** — Validator ПРИНУЖДАЕТ description начинается с "Use when" (соответствие goodai-base / Hermes конвенции)
- **FR-C-6** — На первом `skill_view` для agent-created скилла helyx ПИШЕТ body в `~/.claude/skills/agent-created/<name>/SKILL.md` чтобы Claude Code мог загружать нативно
- **FR-C-7** — Unique constraint `(name)` ПРЕДОТВРАЩАЕТ дубликаты; коллизия возвращает `{ success: false, errors: ['name already exists'] }`
- **FR-C-8** — Distillation aux-LLM call ЛОГИРУЕТСЯ в `aux_llm_invocations`: model, tokens_in, tokens_out, cost_usd, duration_ms, purpose='skill_distillation'
- **FR-C-9** — Telegram approval message СОДЕРЖИТ inline keyboard: [Save] [Reject] [Edit name…] (callbacks через `bot/callbacks.ts`)
- **FR-C-10** — Каждый state transition (proposed → active / rejected / archived) ПРОСТАВЛЯЕТ timestamp в `agent_created_skills`

## 7. Нефункциональные требования

| ID | Требование |
|---|---|
| NFR-C-1 | Distillation aux-LLM call ЗАВЕРШАЕТСЯ за 30s p95 для transcript ≤16 KB; длиннее — обрезается до последних 16 KB |
| NFR-C-2 | Стоимость дистилляции на скилл <$0.01 (DeepSeek pricing × max prompt size) |
| NFR-C-3 | Таблица `agent_created_skills` ПОДДЕРЖИВАЕТ 10000 строк без замедления запросов (индексы на name, status, last_used_at) |
| NFR-C-4 | On-demand on-disk write НЕ ИМЕЕТ race conditions: file write = `mkdir -p` + atomic temp+rename |
| NFR-C-5 | Dashboard view agent-created скиллов РЕНДЕРИТСЯ <500мс для 1000 строк |

## 8. Ограничения

**Технические**:
- aux-LLM client использует OpenAI-совместимый API (работает для DeepSeek, Ollama, OpenRouter)
- Выбор модели через env: `HELYX_AUX_LLM_PROVIDER ∈ {deepseek, ollama, openrouter}`, `HELYX_AUX_LLM_MODEL`
- Default: deepseek + deepseek-chat (уже в helyx `.env`: `CUSTOM_OPENAI_BASE_URL=https://api.deepseek.com`)

**Архитектурные**:
- Body SKILL.md живёт в postgres TEXT column, не в git — генерируется на диске только когда Claude Code читает
- Agent-created скиллы ЖИВУТ под `~/.claude/skills/agent-created/<name>/` чтобы нативный loader Claude Code их находил
- Директория создаётся с mode 0700 чтобы не утечь workflow patterns

**Дизайн**:
- Имя скилла предлагает aux-LLM, но пользователь может override до approval
- Approval flow МОЖЕТ быть пропущен через эвристический auto-approval, но эвристика консервативна в v1
- Rejected скиллы хранятся 7 дней потом hard-delete (откат при изменении мнения)

## 9. Edge cases

- **aux-LLM галлюцинирует duplicate name**: validator ловит через unique constraint, retry с диагностикой; aux-LLM в следующем промпте получает список существующих имён
- **aux-LLM производит malformed frontmatter**: validator отклоняет, retry один раз с parser error в промпте; если всё равно плохо — fail с user-visible диагностикой
- **Пользователь хочет переименовать до approval**: callback `Edit name…` открывает inline-reply; бот ждёт `<new-name>`, валидирует, обновляет запись
- **Коллизия имени после переименования**: validator репортит конфликт; suggest суффикс (`-2`, `-v2`)
- **Слишком длинный transcript (>16 KB)**: обрезаем до последних 16 KB с marker `[…earlier truncated…]`
- **Сессия без явного "success" маркера**: агент не триггерит propose; пользователь может вызвать `/save-as-skill` явно
- **Пользователь продолжает approve низкокачественные скиллы**: out of scope для C; куратор (B) стейл их архивирует со временем
- **Filesystem write fails (диск полный, permissions)**: запись скилла остаётся в postgres со status='active' но без файла; следующий `skill_view` retries; warning лог

## 10. Критерии приёмки (Gherkin)

```gherkin
Функция: Фаза C — Autonomous Skill Creator

  Сценарий: Агент предлагает скилл после многошаговой задачи
    Допустим фаза A в production
    И user request триггернул ≥3 tool-call'а с успешными тестами
    Когда агент вызывает mcp__helyx__propose_skill с валидными name/description/body
    Тогда вставляется строка в agent_created_skills со status='proposed'
    И отправляется Telegram-сообщение с inline-кнопками [Save] [Reject] [Edit name…]
    И в aux_llm_invocations появляется строка с purpose='skill_distillation'

  Сценарий: Пользователь approve proposed скилл
    Допустим строка в agent_created_skills со status='proposed'
    Когда пользователь жмёт [Save] в Telegram
    Тогда status становится 'active'
    И ~/.claude/skills/agent-created/<name>/SKILL.md существует с body
    И последующий mcp__helyx__skill_view({ name }) возвращает body

  Сценарий: Пользователь reject proposed скилл
    Допустим строка со status='proposed'
    Когда пользователь жмёт [Reject]
    Тогда status становится 'rejected'
    И файл не записан
    И follow-up cron удаляет rejected строки через 7 дней

  Сценарий: Validator отклоняет плохой frontmatter
    Допустим агент вызывает propose_skill с body без валидного YAML frontmatter
    Когда validator запускается
    Тогда response = { success: false, errors: ['frontmatter parse error: <details>'] }
    И строка не вставляется
    И aux_llm_invocations НЕ ЛОГИРУЕТСЯ (validation предшествует API)

  Сценарий: Коллизия имени отклоняется
    Допустим существующий active скилл "git-state"
    Когда агент вызывает propose_skill с name="git-state"
    Тогда response = { success: false, errors: ['name already exists'] }

  Сценарий: Description должен начинаться с "Use when"
    Допустим body с description "git status helper"
    Когда validator запускается
    Тогда errors включает 'description must start with "Use when"'

  Сценарий: Lazy on-disk write на первом skill_view
    Допустим active agent-created скилл без файла в ~/.claude/skills/agent-created/<name>/SKILL.md
    Когда mcp__helyx__skill_view({ name }) вызван
    Тогда файл создан с body content
    И последующие вызовы не перезаписывают (timestamp не меняется)

  Сценарий: Сохранённый скилл может использовать inline-shell фазы A
    Допустим body agent-created скилла содержит "!`date`"
    Когда mcp__helyx__skill_view вызван
    Тогда отрисованный body содержит сегодняшнюю дату (применён препроцессор фазы A)
```

## 11. Верификация

**Unit-тесты** (`tests/unit/skill-distiller.test.ts`, `tests/unit/skill-validator.test.ts`):
- Validator: валидный frontmatter принимается
- Validator: name regex принуждается
- Validator: description ≤1024 принуждается
- Validator: body ≤100k принуждается
- Validator: префикс "Use when" принуждается

**Store-тесты** (`tests/unit/agent-skill-store.test.ts`):
- Insert: status='proposed' на первом call
- Transition: proposed → active на `save_skill(approved=true)`
- Transition: proposed → rejected на `save_skill(approved=false)`
- Unique constraint на name
- Lazy file write на первом read

**Aux-LLM client тесты** (`tests/unit/aux-llm-client.test.ts`, mocked):
- DeepSeek call возвращает response
- Ollama call возвращает response
- Cost tracking вставляет строку в `aux_llm_invocations`

**Telegram smoke**:
- Триггернуть многошаговую задачу, проверить что приходит proposal-сообщение, нажать [Save], проверить скилл появляется в `list_agent_skills`

**goodai-base регрессия**:
- Ни один goodai-base скилл не трогается; загрузить 3 reference скилла, byte-identical output

**Rollback тест**:
- `git revert` PR + redeploy → MCP tools `propose_skill`/`save_skill`/`list_agent_skills` исчезают, таблица удаляется через migration down

## 12. Эскиз реализации

**Файлы для создания**:
- `utils/llm-clients/openai-compatible.ts` (~200 LOC)
- `utils/skill-distiller.ts` (~250 LOC, prompt building + LLM call orchestration)
- `utils/skill-validator.ts` (~120 LOC, frontmatter + body checks)
- `mcp/agent-skill-tools.ts` (~150 LOC, propose/save/list handlers)
- `prompts/skill-distillation.md` (~60 lines, system prompt для aux-LLM)
- `migrations/v40_create_agent_created_skills.sql` (~40 LOC)
- `migrations/v41_create_aux_llm_invocations.sql` (~25 LOC)
- `tests/unit/skill-distiller.test.ts` (~250 LOC, 8 cases)
- `tests/unit/agent-skill-store.test.ts` (~200 LOC, 10 cases)
- `tests/unit/aux-llm-client.test.ts` (~180 LOC, 6 cases)

**Файлы для модификации**:
- `mcp/server.ts` — регистрация propose_skill, save_skill, list_agent_skills
- `mcp/tools.ts` — добавление в tool list
- `channel/tools.ts` — dispatch cases
- `bot/callbacks.ts` — обработчики Save/Reject/Edit-name inline-кнопок
- `dashboard/api` — новый endpoint `/api/agent-skills` (GET list)
- `dashboard/webapp` — новая страница или таблица для agent-created скиллов
- `memory/db.ts` — регистрация миграций v40, v41
- `CHANGELOG.md` — запись под v1.34.0
- `package.json` — bump до 1.34.0
- `.env.example` — `HELYX_AUX_LLM_PROVIDER`, `HELYX_AUX_LLM_MODEL`

**Postgres-схема**:

```sql
-- v40_create_agent_created_skills.sql
CREATE TABLE agent_created_skills (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | active | rejected | archived
  source_session_id BIGINT,
  source_chat_id TEXT,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  related_skills TEXT[] DEFAULT ARRAY[]::TEXT[],
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  pinned BOOLEAN NOT NULL DEFAULT false,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);
CREATE INDEX agent_created_skills_status_used_at_idx
  ON agent_created_skills (status, last_used_at DESC);
CREATE INDEX agent_created_skills_source_session_idx
  ON agent_created_skills (source_session_id);

-- v41_create_aux_llm_invocations.sql
CREATE TABLE aux_llm_invocations (
  id BIGSERIAL PRIMARY KEY,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd NUMERIC(10,6),
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  related_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX aux_llm_invocations_purpose_created_idx
  ON aux_llm_invocations (purpose, created_at DESC);
```

**Скелет дистилляционного промпта** (`prompts/skill-distillation.md`):

```markdown
You are skill-distillation aux. Given a session transcript ending with a successful
multi-step task, produce a SKILL.md that captures the workflow as a reusable
procedure. Required output schema:

---
name: <kebab-case, ≤64 chars, regex ^[a-z][a-z0-9-]{0,63}$>
description: "Use when <one-line trigger>. <one-line behavior>."  # ≤1024 chars
version: 1.0.0
author: helyx
license: MIT
metadata:
  helyx:
    tags: [<tag1>, <tag2>]
    related_skills: []
---

# <Title>

## Overview
<2-3 sentences>

## When to Use
- <trigger 1>

## Steps
1. <action; use !`cmd` for dynamic context>

## Common Pitfalls
- <pitfall>: <fix>

## Verification Checklist
- [ ] <check>

Constraints:
- description MUST start with "Use when"
- body ≤100000 chars
- Use !`cmd` syntax for any dynamic git / fs / env state
- Generic enough for similar future tasks, specific enough to be useful
```
