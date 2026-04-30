# PRD: Фаза B — Skill Curator

## 1. Обзор

Фоновый cron-job, периодически просматривающий `agent_created_skills` и применяющий lifecycle-переходы: pin для часто используемых, archive для устаревших, consolidate для near-duplicates, patch для низкокачественных. Использует aux-LLM (отдельный от основной сессии) чтобы изолировать prompt cache.

Зеркалит `agent/curator.py` Hermes-Agent: idle-triggered, archives never deletes, трогает только `is_agent_created` скиллы.

## 2. Контекст

- **Продукт**: helyx (родительский PRD: `./overview.md`)
- **Модуль**: подсистема скиллов — фоновое управление lifecycle
- **Роль пользователя**: потребитель скиллов, тацитно выигрывающий от curated коллекции
- **Стек**: Postgres для curator state, существующий `admin-daemon.ts` для cron scheduling, OpenAI-совместимый aux-LLM (DeepSeek default)

**Триггер**:
- Cron `0 3 * * 0` (воскресенья 03:00 UTC, еженедельно) — настраивается через env `HELYX_CURATOR_CRON`
- Scheduler: существующий `scripts/admin-daemon.ts` (никаких новых long-running процессов)

**Source data**:
- Таблица `agent_created_skills` из фазы C (только `status='active' AND pinned=false`)
- Cost log: таблица `aux_llm_invocations` из фазы C

**Изоляция**:
- aux-LLM client тот же что у фазы C (DeepSeek default, Ollama fallback)
- Критично: prompt cache основной Claude-сессии НЕ ДОЛЖЕН затрагиваться

**Действия куратора**:
1. **pin** — `pinned=true` (auto-применяется для high-use recent скиллов)
2. **archive** — `status='archived', archived_at=now()` (auto-применяется для stale)
3. **consolidate** — слить два скилла в один (требует Telegram approval)
4. **patch** — мелкая правка через aux-LLM rewrite (требует Telegram approval)

## 3. Постановка проблемы

После релиза фазы C agent-created скиллы накапливаются. Без периодического обзора:
- Stale скиллы (не использовались месяцы) висят вечно
- Near-duplicates размножаются (например `/git-state`, `/git-status-snapshot`)
- Низкокачественные скиллы остаются незамеченными до их провала в использовании

Куратор Hermes решает это еженедельным aux-LLM-driven проходом, который предлагает pin/archive/consolidate/patch и применяет безопасные действия автоматически, гейтя рискованные за human approval.

## 4. Цели

- **G-B-1** — еженедельный cron запускает куратора по всем agent-created скиллам
- **G-B-2** — куратор НИКОГДА не трогает user-created скиллы (по scope таблицы: только `agent_created_skills`)
- **G-B-3** — куратор НИКОГДА не удаляет — только архивирует (соответствие инварианту Hermes)
- **G-B-4** — pinned скиллы обходят все авто-переходы
- **G-B-5** — auto-применяемые: pin, archive (low risk). Confirmation-required: consolidate, patch (трогают body)
- **G-B-6** — куратор использует aux-LLM, НЕ main session — billing isolation верифицируема
- **G-B-7** — после каждого запуска отправляет weekly summary в Telegram supervisor topic

## 5. Чего НЕ делаем

- Курируем goodai-base или другие user скиллы — только `agent_created_skills`
- Real-time / event-driven curation — fixed cron достаточен в v1
- ML-driven similarity detection для consolidate — используем LLM judgment в v1, vector embeddings = follow-up
- Auto-apply consolidate или patch без human approval — слишком рискованно в v1
- Куратор, обучающийся на user override'ах — out of scope

## 6. Функциональные требования

- **FR-B-1** — Cron entry ЗАПУСКАЕТ `curator.run()` еженедельно в воскресенье 03:00 UTC; настраивается через `HELYX_CURATOR_CRON`
- **FR-B-2** — Куратор ВЫБИРАЕТ строки из `agent_created_skills` WHERE `status='active' AND pinned=false`
- **FR-B-3** — Куратор СТРОИТ один aux-LLM промпт со всеми именами + descriptions + use_count + last_used_at; max 200 скиллов на запуск (chunked если больше)
- **FR-B-4** — Aux-LLM response СОДЕРЖИТ proposed actions: `{ name, action, reason }`; action ∈ `{pin, archive, consolidate_with, patch, no_action}`
- **FR-B-5** — Куратор АВТО-ПРИМЕНЯЕТ 'pin' (low risk) и 'archive' (Hermes invariant) actions
- **FR-B-6** — Куратор СТАВИТ В ОЧЕРЕДЬ 'consolidate_with' и 'patch' как Telegram-сообщения с [Approve] [Skip] кнопками; пользователь имеет 24ч до истечения
- **FR-B-7** — Auto-archive критерий: `last_used_at` старше 90 дней (настраивается)
- **FR-B-8** — Auto-pin критерий: `use_count > 10` И `last_used_at` в пределах 14 дней
- **FR-B-9** — Каждый запуск куратора ВСТАВЛЯЕТ строку в `curator_runs` с timing + counts + cost
- **FR-B-10** — Summary ОТПРАВЛЯЕТСЯ в Telegram (`SUPERVISOR_CHAT_ID + SUPERVISOR_TOPIC_ID` если настроены, иначе первый зарегистрированный chat)
- **FR-B-11** — Куратор ИДЕМПОТЕНТЕН: повторный запуск на тех же данных даёт те же действия (по модулю aux-LLM nondeterminism, который ограничен)
- **FR-B-12** — Куратор ПАУЗИРУЕМ: env `HELYX_CURATOR_PAUSED=true` пропускает все запуски с logged reason

## 7. Нефункциональные требования

| ID | Требование |
|---|---|
| NFR-B-1 | Запуск куратора ЗАВЕРШАЕТСЯ за 5 минут p95 для ≤200 скиллов |
| NFR-B-2 | Aux-LLM cost на запуск <$0.10 при типичных размерах |
| NFR-B-3 | Сбой куратора НЕ КРАШИТ admin-daemon; залогирован + retried на следующем расписании |
| NFR-B-4 | Anthropic prompt cache основной сессии НЕ инвалидируется (verify: ноль API-вызовов на main key во время curator run) |
| NFR-B-5 | Consolidate/patch confirmations ИСТЕКАЮТ через 24ч чтобы не засорять Telegram inbox |

## 8. Ограничения

**Технические**:
- Scheduler: существующий admin-daemon (никаких новых long-running процессов)
- Aux-LLM: переиспользуем client фазы C (openai-compatible)
- Postgres: 1 новая таблица `curator_runs`, никаких schema-изменений в `agent_created_skills`

**Архитектурные**:
- Куратор ДОЛЖЕН работать внутри helyx-bot контейнера (не на Claude Code subprocess)
- Куратор ДОЛЖЕН использовать aux-LLM client, никогда main Claude API
- Действия ДОЛЖНЫ детерминированно выводиться из aux-LLM response (никакой fuzzy logic)
- Действия, трогающие body (patch, consolidate), ДОЛЖНЫ логировать before/after diff в `aux_llm_invocations.related_id` chain

**Дизайн**:
- Еженедельный cadence консервативен; можно настроить на daily когда стабилизируется
- Один aux-LLM call на запуск если все скиллы влезают в промпт; chunked иначе (200 скиллов/chunk)
- Summary report включает: counts per action, список pending confirmations, cost

## 9. Edge cases

- **Aux-LLM предлагает consolidate где target не существует**: validator отклоняет, log warning, продолжает с другими действиями
- **Aux-LLM предлагает archive скилла использовавшегося вчера**: нарушает auto-archive критерий (≥90 дней idle); validator отклоняет
- **Два consolidate proposal на один target**: первый обрабатывается, второй no-op
- **Aux-LLM недоступен на scheduled run**: log warning, `curator_runs.status='skipped'`, retry на следующем расписании
- **Пользователь руками правит скилл во время curator run**: optimistic concurrency — re-read at apply time, skip если mtime изменился
- **Скилл с `is_agent_created=true` ещё и user-pinned**: куратор пропускает pinned независимо от рекомендации
- **Telegram approval истекает до того как пользователь увидит**: log expiry, no action; куратор может re-propose на следующем запуске
- **Consolidation создаёт body >100k chars**: validator отклоняет, fallback к archive одного + keep другого
- **Curator run производит ноль действий**: всё равно log row + send "all clear" summary

## 10. Критерии приёмки (Gherkin)

```gherkin
Функция: Фаза B — Skill Curator

  Сценарий: Cron entry зарегистрирован при старте admin-daemon
    Допустим Phase B PR смерджен
    Когда admin-daemon стартует
    Тогда cron entry "0 3 * * 0" существует для runCurator
    И виден в mcp__helyx__list_crons (existing tool)

  Сценарий: Auto-archive stale скилла
    Допустим agent-created скилл с last_used_at = now() - 91 день
    И status='active', pinned=false
    Когда куратор запускается и aux-LLM предлагает archive
    Тогда status становится 'archived', archived_at=now()
    И никакая Telegram confirmation не отправляется
    И в curator_runs строка с skills_archived+=1

  Сценарий: Auto-pin часто используемого скилла
    Допустим agent-created скилл с use_count=15, last_used_at в пределах 14 дней
    Когда куратор запускается и aux-LLM предлагает pin
    Тогда pinned=true, status='active' (без изменений)
    И никакая Telegram confirmation не отправляется

  Сценарий: Consolidate proposal требует confirmation
    Допустим два near-duplicate скилла /git-status и /git-state-snapshot
    Когда куратор предлагает consolidate_with target=/git-state-snapshot
    Тогда отправляется Telegram-сообщение с [Approve] [Skip]
    И никакой body не модифицируется

  Сценарий: Patch proposal требует confirmation
    Допустим низкокачественный body скилла
    Когда куратор предлагает patch с diff
    Тогда Telegram-сообщение содержит preview diff
    И [Approve] / [Skip] кнопки гейтят действие

  Сценарий: Pinned скилл обходит куратора
    Допустим pinned agent-created скилл помеченный stale (>90 дней)
    Когда куратор запускается
    Тогда никакое действие не предпринимается
    И curator_runs.skills_examined включает его но action не записан

  Сценарий: Aux-LLM недоступен — graceful skip
    Допустим DeepSeek и Ollama оба unreachable
    Когда куратор запускается
    Тогда curator_runs.status='skipped', error_message залогирован
    И admin-daemon НЕ КРАШИТСЯ
    И следующий scheduled run retries

  Сценарий: Куратор не трогает user-created скиллы
    Допустим goodai-base скиллы в ~/.claude/skills/
    И agent-created скиллы в таблице agent_created_skills
    Когда куратор запускается
    Тогда только agent_created_skills запрашиваются
    И ~/.claude/skills/ filesystem не модифицируется кроме agent-created/ subtree

  Сценарий: Prompt cache основной сессии не затронут
    Допустим curator run завершился успешно
    Когда пользователь отправляет следующее сообщение
    Тогда время отклика основной Claude-сессии соответствует pre-curator baseline
    И никакого Anthropic API-всплеска на main key
```

## 11. Верификация

**Unit-тесты** (`tests/unit/curator.test.ts`):
- Select active+unpinned скиллов только
- Auto-archive критерий (>90 дней idle)
- Auto-pin критерий (use_count>10 && recent)
- Consolidate proposal идёт в Telegram queue
- Patch proposal идёт в Telegram queue
- Pinned скиллы исключены из action set
- Chunked aux-LLM calls для >200 скиллов
- `curator_runs` строка вставляется с правильными counts
- Graceful skip на aux-LLM unavailable

**Integration-тесты** (`tests/unit/curator-integration.test.ts`):
- Полный run на staging postgres с seed data
- Telegram confirmations queued + process callback responses

**Telegram smoke**:
- Manually триггернуть curator run через admin-daemon, проверить что summary message приходит

**Prompt cache isolation**:
- Мониторить Anthropic API usage во время curator run; ожидаем zero requests на main key

**goodai-base регрессия**:
- Запустить куратора на staging с agent skills; проверить что ни один goodai-base скилл не модифицирован

**Rollback тест**:
- `git revert` PR + redeploy → admin-daemon cron entry исчезает, `curator_runs` таблица drop через migration down

## 12. Эскиз реализации

**Файлы для создания**:
- `utils/curator/index.ts` (~200 LOC, оркестратор)
- `utils/curator/select-candidates.ts` (~80 LOC, query active+unpinned skills)
- `utils/curator/aux-llm-prompt.ts` (~150 LOC, build prompt, parse response)
- `utils/curator/apply-actions.ts` (~150 LOC, auto-apply pin/archive, queue consolidate/patch)
- `utils/curator/summary-report.ts` (~100 LOC, format Telegram summary)
- `prompts/skill-curation.md` (~100 lines, system prompt для aux-LLM)
- `migrations/v42_create_curator_runs.sql` (~25 LOC)
- `tests/unit/curator.test.ts` (~350 LOC, 12 cases)
- `tests/unit/curator-integration.test.ts` (~200 LOC, 4 cases)

**Файлы для модификации**:
- `scripts/admin-daemon.ts` — добавить cron entry вызывающий `import('../utils/curator').then(m => m.run())`
- `mcp/server.ts` — регистрация `mcp__helyx__curator_run` (manual trigger для тестирования) и `mcp__helyx__curator_status`
- `mcp/tools.ts` — добавление в tool list
- `channel/tools.ts` — dispatch cases
- `bot/callbacks.ts` — обработчики curator [Approve] / [Skip] inline-кнопок
- `dashboard/api` — новый endpoint `/api/curator-runs` (history view)
- `dashboard/webapp` — новая страница с curator run history + skills lifecycle distribution
- `memory/db.ts` — регистрация миграции v42
- `CHANGELOG.md` — запись под v1.35.0
- `package.json` — bump до 1.35.0
- `.env.example` — `HELYX_CURATOR_CRON`, `HELYX_CURATOR_PAUSED`, `HELYX_CURATOR_ARCHIVE_AFTER_DAYS`, `HELYX_CURATOR_PIN_USE_COUNT`

**Postgres-схема**:

```sql
-- v42_create_curator_runs.sql
CREATE TABLE curator_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  status TEXT NOT NULL,  -- running | success | skipped | error
  skills_examined INTEGER NOT NULL DEFAULT 0,
  skills_pinned INTEGER NOT NULL DEFAULT 0,
  skills_archived INTEGER NOT NULL DEFAULT 0,
  skills_proposed_consolidate INTEGER NOT NULL DEFAULT 0,
  skills_proposed_patch INTEGER NOT NULL DEFAULT 0,
  aux_llm_cost_usd NUMERIC(10,6),
  error_message TEXT,
  summary TEXT
);
CREATE INDEX curator_runs_started_at_idx ON curator_runs (started_at DESC);
```

**Скелет промпта курации** (`prompts/skill-curation.md`):

```markdown
You are skill-curation aux. Given a list of agent-created skills with metadata,
propose lifecycle actions per skill. Allowed actions: pin, archive,
consolidate_with:<target_name>, patch:<diff>, no_action.

Auto-applied: pin (high use, recent) and archive (stale).
Confirmation-required: consolidate (merging) and patch (body edit).

Constraints:
- Never propose archive for skills used within 90 days
- Propose pin only if use_count > 10 AND last_used_at within 14 days
- Propose consolidate_with only when names + descriptions show >70% overlap
- Propose patch only for clearly improvable bodies (broken inline-shell, typos)
- When in doubt, choose no_action

Output JSON: { actions: [{ name, action, reason, ... }] }
```
