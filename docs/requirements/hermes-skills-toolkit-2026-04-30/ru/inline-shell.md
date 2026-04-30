# PRD: Фаза A — Inline Shell Expansion

## 1. Обзор

Добавляем helyx-side препроцессинг, который раскрывает токены `` !`cmd` `` в теле SKILL.md в stdout выполненной команды до того, как отрисованный текст уйдёт в LLM. Зеркалит `agent/skill_preprocessing.py::expand_inline_shell` из Hermes-Agent.

## 2. Контекст

- **Продукт**: helyx (родительский PRD: `./overview.md`)
- **Модуль**: подсистема скиллов — новый helyx-side препроцессор + MCP-tool
- **Роль пользователя**: автор скилла (пишет SKILL.md), потребитель скилла (LLM через Claude Code)
- **Стек**: Bun spawn для shell-execution, MCP SDK для tool-exposure, Postgres для invocation log

**Путь поставки**:
- Новый модуль `utils/skill-preprocessor.ts` делает regex match + spawn + replace
- Новый MCP-tool `mcp__helyx__skill_view` возвращает body после препроцессинга
- Claude Code вызывает этот tool, когда хочет загрузить скилл (заменяя нативный filesystem read)

Нативный loader Claude Code НЕ модифицируется — мы экспонируем параллельный путь через MCP. Скиллы без `` !`cmd` `` ведут себя одинаково независимо от того, через нативный loader или через этот tool.

## 3. Постановка проблемы

Скиллы сегодня инжектят только статичный markdown. Любой динамический контекст — git status, состояние environment, листинг файлов — требует от LLM tool-call (`Bash`, `Read`, `Grep`). Это лишний round-trip: ~150 токенов на сам call + ~500мс задержки на каждую зависимость.

Hermes решает это запуском shell-команд во время загрузки скилла и встраиванием их вывода прямо в отрисованный body. Скилл `/git-state` вместо «скажи LLM запустить git status» становится «вот git status, делай выводы».

## 4. Цели

- **G-A-1** — скиллы МОГУТ встраивать токены `` !`cmd` ``; helyx-препроцессор разрешает их в stdout до доставки
- **G-A-2** — скиллы БЕЗ токенов `` !`cmd` `` загружаются идентично сегодняшним (ноль изменений в поведении)
- **G-A-3** — препроцессор добавляет ≤200мс медианной задержки для скиллов без shell-токенов
- **G-A-4** — выполнение shell-команд изолировано: per-cmd timeout, output cap, non-root user

## 5. Чего НЕ делаем

- Поддержка template-vars Hermes (`${HERMES_SKILL_DIR}` / `${HERMES_SESSION_ID}`) — отдельный тикет если/когда понадобится
- Перехват нативной загрузки скиллов Claude Code — добавляем параллельный MCP tool, нативный loader не трогаем
- Запуск команд под кем-то кроме `bun` user'а helyx-контейнера
- Поддержка многострочных shell-команд — только однострочные, как regex Hermes

## 6. Функциональные требования

- **FR-A-1** — Препроцессор СОПОСТАВЛЯЕТ regex `` !`([^`\n]+)` `` (single-line, в backticks). Идентичен `_INLINE_SHELL_RE` Hermes.
- **FR-A-2** — Для каждого совпадения препроцессор ВЫПОЛНЯЕТ захваченную команду через `Bun.spawn(['bash', '-c', cmd])` с `cwd=skillDir`, `timeout=5000ms` (настраивается env), `stdout=pipe`, `stderr=pipe`.
- **FR-A-3** — stdout ЗАМЕНЯЕТ весь токен `` !`...` `` в отрисованном body.
- **FR-A-4** — Если команда завершилась non-zero, replacement = `[inline-shell error: <stderr first 500 chars>]`.
- **FR-A-5** — Если команда превысила timeout, replacement = `[inline-shell timeout after Ns: <command>]`.
- **FR-A-6** — stdout УСЕКАЕТСЯ до 4096 chars + суффикс `…[truncated]`.
- **FR-A-7** — Препроцессор ВЫПОЛНЯЕТ команды последовательно (без параллелизма) для детерминированного поведения.
- **FR-A-8** — Скиллы БЕЗ токенов `` !`cmd` `` ОБХОДЯТ spawn — fast path = unchanged content.
- **FR-A-9** — MCP tool `skill_view` ПРИНИМАЕТ `{ name: string }` и возвращает `{ name, description, body, frontmatter }` — body после препроцессинга.
- **FR-A-10** — Каждое выполнение препроцессора ЛОГИРУЕТСЯ в postgres-таблицу `skill_preprocess_log`: skill_name, started_at, duration_ms, shell_count, errors_count.

## 7. Нефункциональные требования

| ID | Требование |
|---|---|
| NFR-A-1 | Скиллы без shell-токенов — load latency p50 ≤ 50мс (vs ~30мс baseline нативного load) |
| NFR-A-2 | Скиллы с N shell-токенами — load latency ≤ N × cmd_timeout + 100мс preprocessing overhead |
| NFR-A-3 | Memory cap на stdout buffer: 4096 chars per command, hard limit |
| NFR-A-4 | Runtime: TypeScript на Bun (соответствует существующему стеку helyx) |
| NFR-A-5 | Integration test загружает 3 примерных goodai-base скилла и проверяет byte-identical output к нативному loader'у |

## 8. Ограничения

**Технические**:
- ДОЛЖЕН работать внутри helyx-bot контейнера (доступ к postgres + cron)
- НЕ ДОЛЖЕН выполняться от root (текущий контейнер запускается под `bun` user — оставляем как есть)
- ДОЛЖЕН использовать `Bun.spawn(['bash', '-c', cmd])` с командой только из SKILL.md (автор скилла доверенный, но всё логируем)
- ДОЛЖЕН добавить postgres-миграцию (версионируется в существующем реестре `memory/db.ts`)

**Архитектурные**:
- НЕ ДОЛЖЕН менять существующее поведение dispatch в `channel/tools.ts` для не-skill-related tools
- ДОЛЖЕН откатываться через `git revert` одного PR — без manual cleanup

## 9. Edge cases

- **Body скилла содержит незакрытый backtick** (`` `!`malformed ``): regex требует балансированных backticks; незакрытый токен остаётся verbatim
- **Output команды содержит сам синтаксис `` !`...` ``**: препроцессор запускается ОДИН РАЗ — вложенные токены НЕ раскрываются рекурсивно (как Hermes)
- **Команда производит binary output**: stdout буферизуется как utf-8 с replacement char для невалидных байт
- **Скилл отсутствует на диске**: skill_view возвращает JSON `{ error: 'skill not found', name }`
- **Body уже содержит отрисованный shell output (идемпотентность)**: препроцессор сопоставляет только regex `` !`...` `` — уже отрисованный текст не реобрабатывается
- **Конкурентные skill_view-запросы для одного скилла**: per-skill lock'а нет — каждый вызов запускает команды свежими; команды ДОЛЖНЫ быть идемпотентны (контракт автора скилла, документируется)
- **Команда требует подгонки PATH**: запускается с `process.env` (полное наследование) — команда может сама `cd` или поставить переменные внутри body

## 10. Критерии приёмки (Gherkin)

```gherkin
Функция: Фаза A — Inline Shell Expansion

  Сценарий: Скилл без shell-токенов загружается без изменений
    Допустим SKILL.md в ~/.claude/skills/sample-static/SKILL.md
    И body не содержит токенов "!`"
    Когда mcp__helyx__skill_view({ name: "sample-static" }) вызван
    Тогда возвращённый body byte-identical body файла SKILL.md
    И время отклика < 50мс p50
    И в skill_preprocess_log не добавлена строка

  Сценарий: Скилл с одним shell-токеном раскрывает его
    Допустим SKILL.md с body "Today: !`date +%Y-%m-%d`"
    Когда mcp__helyx__skill_view({ name: "today" }) вызван
    Тогда body совпадает с /^Today: \d{4}-\d{2}-\d{2}$/
    И время отклика < 200мс p50
    И в skill_preprocess_log добавлена строка с shell_count=1, errors_count=0

  Сценарий: Скилл с падающим shell-токеном показывает inline error
    Допустим SKILL.md с body "Result: !`exit 1`"
    Когда mcp__helyx__skill_view вызван
    Тогда body совпадает с /^Result: \[inline-shell error: /
    И daemon не падает
    И в skill_preprocess_log одна строка с errors_count=1

  Сценарий: Превышение timeout показывает timeout marker
    Допустим SKILL.md с body "Wait: !`sleep 10`"
    И настроенный per-command timeout = 5000мс
    Когда mcp__helyx__skill_view вызван
    Тогда body совпадает с /^Wait: \[inline-shell timeout after 5s: sleep 10\]/
    И фактическое время отклика < 5500мс

  Сценарий: Output cap применён
    Допустим SKILL.md с body "Big: !`yes | head -10000`"
    Когда mcp__helyx__skill_view вызван
    Тогда отрисованный body имеет длину ≤ 4096 + len("Big: ") + len("…[truncated]")
    И заканчивается на "…[truncated]"

  Сценарий: goodai-base скилл загружается идентично нативному loader'у
    Допустим goodai-base скилл в ~/.claude/skills/feature-analyzer/SKILL.md
    Когда mcp__helyx__skill_view вызван
    Тогда возвращённый body byte-identical body-секции файла
```

## 11. Верификация

**Unit-тесты** (`tests/unit/skill-preprocessor.test.ts`):
- regex matches только single-line `` !`...` ``
- скилл без токенов возвращает input unchanged
- скилл с одной cmd заменяет токен на stdout
- failed-cmd производит inline-shell error marker
- timeout производит inline-shell timeout marker
- output truncation на 4096 bytes
- binary output sanitized к utf-8 replacement char

**Integration-тесты** (`tests/unit/mcp-skill-view.test.ts`):
- MCP tool зарегистрирован и вызываем
- 404 на отсутствующий скилл
- postgres log row вставляется на каждый вызов

**Telegram smoke**:
- Deploy на staging, отправить сообщение, триггерящее `/git-state` скилл, проверить что ответ включает live git-output
- Отправить 3 сообщения без триггера препроцессора — TTS работает как раньше

**goodai-base регрессия**:
- Загрузить `/feature-analyzer`, `/review-orchestrator`, `/job-orchestrator` через skill_view → byte-identical нативному loader read

**Rollback тест**:
- `git revert` этого PR + redeploy → skill_view tool возвращает "unknown tool", schema migration drift отсутствует

## 12. Эскиз реализации

**Файлы для создания**:
- `utils/skill-preprocessor.ts` — экспортирует `preprocessSkillBody`, `runInlineShell` (~150 LOC)
- `mcp/skill-view-tool.ts` — экспортирует `registerSkillViewTool` (~50 LOC)
- `tests/unit/skill-preprocessor.test.ts` (~200 LOC, 12 cases)
- `tests/unit/mcp-skill-view.test.ts` (~80 LOC, 5 cases)
- `migrations/v39_create_skill_preprocess_log.sql` (~20 LOC)

**Файлы для модификации**:
- `mcp/server.ts` — регистрация tool schema `skill_view`
- `mcp/tools.ts` — добавление `skill_view` в tool list
- `channel/tools.ts` — добавление `skill_view` dispatch case
- `memory/db.ts` — регистрация миграции v39
- `CHANGELOG.md` — запись под v1.33.0
- `package.json` — bump до 1.33.0

**Демо-скилл**:

```markdown
---
name: git-state
description: "Use when you need a snapshot of the current git working state"
version: 1.0.0
author: helyx
license: MIT
---

# Git State Snapshot

Branch: !`git rev-parse --abbrev-ref HEAD`

Last commit: !`git log -1 --format='%h %s (%an, %ar)'`

Working tree:
```

!`git status --short`

```

Diff summary:
```

!`git diff --stat`

```
```

**Postgres-миграция**:

```sql
-- v39_create_skill_preprocess_log.sql
CREATE TABLE skill_preprocess_log (
  id BIGSERIAL PRIMARY KEY,
  skill_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER NOT NULL,
  shell_count INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  first_error TEXT
);
CREATE INDEX skill_preprocess_log_started_at_idx
  ON skill_preprocess_log (started_at DESC);
```

**Конфигурация** (env-driven, без обязательных настроек):
- `HELYX_SHELL_TIMEOUT_MS` — per-command timeout (default 5000)
- `HELYX_SHELL_OUTPUT_CAP` — max stdout bytes per command (default 4096)
