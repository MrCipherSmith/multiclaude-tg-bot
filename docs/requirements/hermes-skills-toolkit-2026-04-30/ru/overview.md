# PRD: Hermes Skills Toolkit — Overview

## 1. Обзор

Три улучшения системы скиллов, вдохновлённые [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) и адаптированные под архитектуру helyx (Bun-MCP-мост, Claude Code как agent runtime). Реализуются последовательно по roadmap'у с жёсткими зависимостями: **A → C → B**.

| Фаза | Фича | Зачем именно сейчас |
|---|---|---|
| **A** | Inline `` !`cmd` `` expansion в скилл-препроцессоре | Минимальный риск, максимальный немедленный эффект — экономит один tool-call round-trip на каждый динамический контекст |
| **C** | Автономное создание скиллов после сложных задач | Замыкает learning loop — успешные workflow становятся переиспользуемыми артефактами |
| **B** | Фоновый куратор скиллов | Ухаживает за накопленными agent-created скиллами (pin / archive / consolidate) |

Каждая фаза = независимый PR, мерджится и откатывается в изоляции.

## 2. Контекст

- **Продукт**: helyx — Telegram-бот, мост между телефоном и Claude Code на удалённой машине
- **Модуль**: подсистема скиллов (сейчас: pass-through к нативному loader'у Claude Code)
- **Роль пользователя**: разработчик, использующий helyx как coding-ассистента через Telegram
- **Стек**: Bun 1.3+, TypeScript 5.x, Postgres 16 (pgvector), Docker Compose, MCP SDK ^1.x, DeepSeek API (уже настроен), Ollama (уже настроен для local fallback)

helyx сегодня НЕ трогает скиллы — Claude Code загружает их напрямую из `~/.claude/skills/<name>/SKILL.md`. Экосистема goodai-base поставляет ~30+ инженерных скиллов (`feature-analyzer`, `review-orchestrator` и т.д.).

Этот toolkit добавляет тонкий helyx-side препроцессор + реестр скиллов поверх Claude Code, не заменяя loader.

## 3. Постановка проблемы

1. **Статичные скиллы требуют live-данных через tool-calls.** Скилл `/git-state` сегодня инструктирует LLM выполнить `Bash("git status")` — полный round-trip, ~150 токенов, ~500мс. Hermes позволяет инжектить этот вывод на этапе загрузки скилла через синтаксис `` !`cmd` ``.

2. **Успешные workflow забываются.** Когда агент собирает многошаговое решение (debug + fix + test + commit), этот workflow исчезает вместе с разговором. В следующий раз он переоткрывается с нуля. Hermes-овские agent-created скиллы захватывают такие паттерны как переиспользуемые SKILL.md.

3. **Накопленные скиллы не курируются.** Без периодического обзора agent-created скиллы дублируются, никогда не архивируются при простое, не сливаются почти-одинаковые. Hermes-овский куратор (auxiliary-LLM, idle-triggered) решает это.

## 4. Цели

- **G1** — скиллы могут инжектить динамический shell-output на этапе загрузки, экономя один tool-call round-trip на каждую динамическую зависимость
- **G2** — после многошагового успеха агент МОЖЕТ дистиллировать workflow в переиспользуемый SKILL.md без участия пользователя
- **G3** — agent-created скиллы автокурируются: pin для популярных, archive для устаревших, merge для почти-дубликатов
- **G4** — никаких регрессов на goodai-base скиллах, существующих TTS/ASR, MCP transport, lifecycle channel.ts-сессий
- **G5** — стоимость aux-LLM на активного пользователя <$0.50/мес при типичном использовании (~10 запусков куратора/мес)

## 5. Чего НЕ делаем

- **NG1** — переписывать skill-loader Claude Code. Мы НАСЛАИВАЕМСЯ через MCP, не заменяем.
- **NG2** — поддерживать multi-platform gateway Hermes (Discord/Slack/WhatsApp). Telegram-only остаётся.
- **NG3** — реплицировать переключение LLM-провайдеров Hermes на уровне сессии. Claude Code остаётся первичным runtime'ом.
- **NG4** — реализовывать RL/Atropos training pipelines.
- **NG5** — авто-УДАЛЯТЬ скиллы. Куратор только архивирует — соблюдаем инвариант Hermes "никогда не удалять".
- **NG6** — шарить agent-created скиллы между пользователями. Per-installation в v1.

## 6. Функциональные требования (верхний уровень)

- **FR-Overview-1** — Все три фичи поставляются БЕЗ env-флагов. Откат — только через `git revert <pr-sha>` + redeploy.
- **FR-Overview-2** — Фичи последовательны A → C → B, каждая в отдельном PR, мерджится и откатывается независимо.
- **FR-Overview-3** — Фича C ЗАВИСИТ от препроцессора фичи A (чтобы сгенерированные скиллы могли использовать `` !`cmd` ``).
- **FR-Overview-4** — Фича B ЗАВИСИТ от таблицы `agent_created_skills` фичи C (иначе курировать нечего).

Per-feature FR'ы — в детальных PRD.

## 7. Нефункциональные требования

| ID | Требование | Верификация |
|---|---|---|
| **NFR-Compat** | Ноль изменений в SKILL.md goodai-base; они остаются валидным input | grep `!\`` в goodai-base скиллах не находит совпадений; загруженные скиллы не меняются по числу токенов |
| **NFR-Cost** | Aux-LLM <$0.50/мес/пользователь при 10 запусках куратора/мес, средний промпт ≤8 KB | Залогированные токены × DeepSeek pricing в postgres-таблице `aux_llm_invocations` |
| **NFR-Latency** | Препроцессор фичи A добавляет ≤200мс медианной задержки на загрузку скилла (исключая время выполнения самой shell-команды) | p50 из perf-лога `tts_skill_load_ms` на staging |
| **NFR-Isolation** | Фича B использует выделенный aux-LLM client; prompt cache основной сессии не затрагивается | Anthropic billing dashboard показывает curator events на отдельном API key ИЛИ DeepSeek/Ollama (не Claude) |
| **NFR-Observability** | Каждый запуск препроцессора, создание скилла, запуск куратора — логируется в postgres + structured logs | Таблицы: `skill_preprocess_log`, `agent_created_skills` (audit columns), `curator_runs` |

## 8. Ограничения

**Технические**:
- TypeScript 5.x + Bun 1.3+ (текущий стек)
- Postgres 16 с pgvector (текущий стек)
- MCP SDK ^1.x
- Никаких новых внешних сервисов — DeepSeek и Ollama уже сконфигурированы в `.env`

**Архитектурные**:
- Препроцессор ЖИВЁТ на стороне helyx-MCP server, не в Claude Code subprocess — логика в helyx-репе, переиспользуется между сессиями
- Agent-created скиллы ЖИВУТ в postgres ради queryability + audit; on-disk SKILL.md генерируется по запросу для потребления Claude Code
- Куратор ЗАПУСКАЕТСЯ как cron job через helyx admin-daemon, не через Claude Code

**Дизайн**:
- Соответствие правилам валидации Hermes: name ≤64 chars, description ≤1024 chars, body ≤100k chars
- Соответствие конвенции goodai-base: description начинается с "Use when"
- Hermes-специфичные расширения (`` !`cmd` ``, граф `related_skills`) — АДДИТИВНЫ: отсутствие токенов = поведение как сегодня

## 9. Edge cases

- **Hermes-style скилл загружается non-Hermes-aware клиентом** (например Cursor): graceful degradation — текст `` !`cmd` `` проходит verbatim, превращается в неразрендеренный markdown
- **Агент генерирует скилл, превышающий лимит 100k chars**: отклоняется с диагностикой, retry с truncation-промптом
- **Aux-LLM куратора недоступен** (DeepSeek down + Ollama не запущен): запуск пропускается с warning-логом, retry на следующем расписании
- **Два конкурентных автономных создания скиллов для похожих workflow**: unique constraint на `(name, owner)` в postgres предотвращает дубликаты; второй creator получает EXISTS-ошибку и завершается
- **Пользователь руками правит скилл с `is_agent_created=true`**: запиннить (куратор не трогает pinned) или transfer ownership к пользователю
- **Циклическая `related_skills`-ссылка**: детектится при insert через DFS, отклоняется с диагностикой

## 10. Критерии приёмки (Gherkin)

```gherkin
Функция: Hermes Skills Toolkit — общий rollout

  Сценарий: Фаза A смерджена независимо
    Допустим main без Hermes-фич
    Когда PR inline-shell-expansion смерджен
    Тогда helyx обслуживает Hermes-style скиллы с раскрытым `!`cmd``
    И goodai-base скиллы продолжают загружаться без изменений
    И никаких postgres schema-миграций не запускалось
    И aux-LLM не вызывался

  Сценарий: Фаза C смерджена после A
    Допустим фаза A в production
    Когда PR autonomous-skill-creator смерджен
    Тогда таблица `agent_created_skills` существует в postgres
    И после успешной многошаговой задачи агент может предложить сохранить как скилл
    И препроцессор фазы A переиспользуется для сгенерированного SKILL.md

  Сценарий: Фаза B смерджена после C
    Допустим фазы A и C в production, есть хотя бы 1 agent-created скилл
    Когда PR skill-curator смерджен
    Тогда cron-запись запускает куратора еженедельно
    И куратор использует DeepSeek (default) или Ollama (configurable)
    И куратор никогда не трогает user-created скиллы (is_agent_created=false)
    И куратор никогда не удаляет — только проставляет archived_at

  Сценарий: Откат всех фич
    Допустим все три фазы в production
    Когда git revert применён в обратном порядке (B потом C потом A)
    И helyx redeployed
    Тогда helyx ведёт себя так же как до фазы A
    И таблица agent_created_skills удалена через migration down
    И никаких orphaned данных не остаётся
```

## 11. Верификация

**Per-feature**: см. детальные PRD по inline-shell, autonomous-skill-creator, skill-curator.

**Сквозное**:
1. **Smoke после каждого PR**: 1 RU + 1 EN сообщение в Telegram, 1 голосовое → существующий TTS/ASR продолжает работать
2. **goodai-base регрессия**: загрузить 3 случайных goodai-base скилла (`/feature-analyzer`, `/review-orchestrator`, `/job-orchestrator`) → рендерятся корректно, без зависаний и исключений
3. **Cost мониторинг**: таблица postgres `aux_llm_invocations` после каждого запуска куратора
4. **Еженедельный health panel**: dashboard `Hermes Toolkit Health` показывает skill_preprocess_count, agent_created_skills_count, curator_run_count, errors_count

**Rollback тест**: в staging, после деплоя всех трёх фаз, прогнать `git revert` каждой в обратном порядке → проверить чистое состояние и отсутствие goodai-base регрессий.

## 12. Roadmap и зависимости

| Фаза | Заголовок PR | ETA | Блокирует | Зависит от | Файлы |
|---|---|---|---|---|---|
| A | feat: inline shell expansion in skill preprocessor | 1-2 дня | C | — | ~3 (preprocessor, тесты, демо-скилл) |
| C | feat: autonomous skill creation after complex tasks | 3-5 дней | B | A | ~6 (creator, prompt template, migration, MCP tool, тесты, docs) |
| B | feat: background skill curator | 5-7 дней | — | C | ~7 (curator, aux-llm-client, scheduler, migration, dashboard panel, тесты, docs) |

**Общий ETA**: 9-14 дней, один разработчик.

---

## См. также

- `./inline-shell.md` — детальный PRD фазы A
- `./autonomous-skill-creator.md` — детальный PRD фазы C
- `./skill-curator.md` — детальный PRD фазы B
