# Отчет: Обновление README — Skills, Providers & OpenCode

**Дата:** 2026-04-06  
**Ветка:** main  
**Проанализировано коммитов:** 20 последних (195c9df → a3d66e7)  
**Применено в:** commit a3d66e7

---

## 1. Резюме

Проанализированы 20 последних git-коммитов. Обнаружен разрыв между реализованными функциями и документацией. README был на 620 строках и не отражал ~150 строк нового функционала. Обновлен до 770 строк с покрытием интеграции skills/commands, управления LLM-провайдерами и поддержки OpenCode TUI.

---

## 2. Анализируемые коммиты

| Хеш | Тип | Описание |
|-----|-----|----------|
| 195c9df | feat | Persistent OpenCode SSE монитор — пересылка сообщений TUI в Telegram |
| f8fbd3c | feat | Общая OpenCode-сессия между TUI и ботом |
| 9a94620 | fix | Нормализация JSONB-хранения cli_config |
| cb65946 | feat | Tmux-проекты с поддержкой провайдеров |
| a625154 | feat | Флаг `--provider` в `claude-bot add`, эндпоинт `/api/sessions/register` |
| 0959fae | feat | Команды `/add`, `/model`, `/connections`, бейджи провайдеров |
| 7149300 | fix | Кнопочный UI для /skills и /commands |
| afa61aa | feat | `/skills`, `/commands`, `/hooks` с inline-кнопками и вызовом инструментов |
| b945c04 | feat | Флаг `--name` в `claude-bot add` |
| 3d81555 | feat | Команда `/remove` для удаления сессий |
| 4253715 | feat | Команда `prune` для очистки старых сессий |

---

## 3. Анализ разрыва: код vs документация

### 3.1 Недокументированные Telegram-команды

| Команда | До | После |
|---------|----|-------|
| `/skills` | "каталог из knowledge base" | Inline-кнопки, live-скан, click-to-run |
| `/commands` | Не задокументирована | ~/.claude/commands/, YAML frontmatter |
| `/hooks` | Не задокументирована | settings.json, типы событий |
| `/add [provider]` | Не задокументирована | Wizard для 4 провайдеров |
| `/model` | Не задокументирована | Показ активного провайдера |
| `/connections` | Не задокументирована | Бейджи со статусом провайдеров |

### 3.2 Недокументированные CLI-опции

| Функция | До | После |
|---------|----|-------|
| Флаг `--provider` в `add` | Не задокументирован | Задокументирован с примерами |
| `claude-bot attach <url>` | Не задокументирован | Задокументирован |
| Tmux-окна с именами провайдеров | Не задокументировано | Задокументировано |

### 3.3 Отсутствующие разделы

| Раздел | До | После |
|--------|----|-------|
| Skills, Commands & Hooks | Нет | Полный раздел с примерами |
| LLM Providers | Нет | Полный раздел (/add, /model, /connections) |
| OpenCode Integration | Нет | Полный раздел (SSE, shared session, setup) |
| Recent Changes (v1.8.0) | Нет | Добавлен |
| ENV: HOST_CLAUDE_CONFIG | Нет | Задокументирован |
| ENV: OPENCODE_PORT | Нет | Задокументирован |

---

## 4. Применённые изменения

### 4.1 Таблица Telegram-команд
Добавлено 6 новых строк в группу "Tools & Knowledge".

### 4.2 Новый раздел: Skills, Commands & Hooks
Три подраздела: `/skills` (inline-кнопки, ~/.claude/skills/), `/commands` (YAML frontmatter), `/hooks` (settings.json).

### 4.3 Новый раздел: LLM Providers
Четыре подраздела: `/add`, `/model`, `/connections`, CLI Provider Support.

### 4.4 Новый раздел: OpenCode Integration
Описание полного флоу: `add --provider opencode` → auto-start serve → shared session → SSE → Telegram.

### 4.5 Обновлен раздел CLI Commands
Добавлены `--provider`, `attach <url>`, подраздел Providers.

### 4.6 Переменные окружения
Добавлены `HOST_CLAUDE_CONFIG` и `OPENCODE_PORT`.

### 4.7 Roadmap
Помечены как выполненные (x) три новых пункта.

### 4.8 Recent Changes
Добавлен раздел `## Recent Changes (v1.8.0)`.

---

## 5. Ключевые изменения в коде

| Файл | Строки | Назначение |
|------|--------|-----------|
| `utils/tools-reader.ts` | +141 | Парсинг метаданных skill/command из ~/.claude |
| `adapters/opencode-monitor.ts` | +214 | SSE монитор OpenCode TUI |
| `bot/commands/admin.ts` | +98 | /skills, /commands, /hooks, /add, /model, /connections |
| `bot/callbacks.ts` | +35 | Callback-обработчики inline-кнопок |
| `bot/handlers.ts` | +28 | Управление отложенным вводом аргументов (TTL 5 мин) |
| `cli.ts` | +302 | Флаг provider, команда attach, регистрация сессий |
| `mcp/server.ts` | +33 | Эндпоинт /api/sessions/register |
| `scripts/run-opencode.sh` | +40 | Запуск OpenCode serve |

**Итого по коду:** +659 / -144 строк, 13 файлов

---

## 6. Итоговая проверка

- Строк до: 620 → после: 770 (+150)
- Все новые Telegram-команды задокументированы
- Все новые CLI-флаги задокументированы
- Новые ENV-переменные добавлены в таблицу
- Roadmap соответствует реальному состоянию

---

## 7. Закрытые вопросы

Все открытые вопросы, выявленные при создании отчета, теперь закрыты:

| Вопрос | Решение |
|--------|--------|
| Диаграмма архитектуры не отражает OpenCode | Исправлено — диаграмма обновлена в README.md: добавлен блок `opencode serve (tmux)` в раздел хоста, стрелка `HTTP/SSE ↕ host.docker.internal:4096`, строка `OpenCode SSE monitor` внутри блока Bot |
| Нет PRD для `/add /model /connections` | Создан — `docs/requirements/provider-management-2026-04-06/en/prd.md` |
| Нет PRD для OpenCode integration | Создан — `docs/requirements/opencode-integration-2026-04-06/en/prd.md` |
