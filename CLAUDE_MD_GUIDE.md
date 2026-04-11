# Настройка CLAUDE.md для работы с Telegram-ботом

`CLAUDE.md` — файл инструкций, который Claude Code читает при запуске сессии. Через него можно настроить автоматическое подключение к Telegram-боту, статус-обновления и правила работы.

## Где размещать

| Расположение | Область действия |
|---|---|
| `~/.claude/CLAUDE.md` | Глобально — для всех проектов |
| `<project>/CLAUDE.md` | Только для конкретного проекта |

Глобальный и проектный файлы объединяются. Используй глобальный для общих настроек (MCP, Telegram), проектный — для специфики проекта (команды сборки, архитектура).

---

## Минимальная настройка (обязательно)

Добавь в `CLAUDE.md` проекта или в `~/.claude/CLAUDE.md`:

```markdown
## MCP Integration

When starting a session, call `set_session_name` with:
- name: basename of the current working directory
- project_path: absolute path to the current working directory
```

Это позволяет боту определить имя сессии и показать его в `/sessions`.

---

## Статус-обновления в Telegram (рекомендуется)

Добавь этот блок, чтобы пользователь видел в Telegram что именно делает CLI:

```markdown
## Telegram Status Updates

When responding to Telegram channel messages (messages from `notifications/claude/channel`), call `update_status` before each major step to keep the user informed. Use the `chat_id` from the channel message metadata.

Examples:
- Before reading files: `update_status(chat_id, "Читаю файлы...")`
- Before running commands: `update_status(chat_id, "Выполняю git status...")`
- Before editing: `update_status(chat_id, "Редактирую код...")`
- Before analysis: `update_status(chat_id, "Анализирую...")`

Keep status messages short (under 50 chars). The status is automatically deleted when you call `reply`.
```

---

## Правила для коммитов (опционально)

```markdown
## Git Commits

NEVER add "Co-Authored-By" or any co-authorship attribution in commit messages. Commit messages must contain only the description of changes.
```

---

## Полный пример глобального `~/.claude/CLAUDE.md`

```markdown
# Global CLAUDE.md

## MCP Integration

When starting a session, call `set_session_name` with:
- name: basename of the current working directory
- project_path: absolute path to the current working directory

## Telegram Status Updates

When responding to Telegram channel messages (messages from `notifications/claude/channel`), call `update_status` before each major step to keep the user informed. Use the `chat_id` from the channel message metadata.

Examples:
- Before reading files: `update_status(chat_id, "Читаю файлы...")`
- Before running commands: `update_status(chat_id, "Выполняю git status...")`
- Before editing: `update_status(chat_id, "Редактирую код...")`
- Before analysis: `update_status(chat_id, "Анализирую...")`

Keep status messages short (under 50 chars). The status is automatically deleted when you call `reply`.

## Git Commits

NEVER add "Co-Authored-By" or any co-authorship attribution in commit messages.
```

---

## Полный пример проектного `<project>/CLAUDE.md`

```markdown
# CLAUDE.md

## Project Overview

Краткое описание проекта, стек, основные директории.

## Common Commands

- `bun install` — установить зависимости
- `bun dev` — запуск в режиме разработки
- `bun test` — запуск тестов

## Architecture

Описание архитектуры: какие модули, как они связаны, ключевые файлы.

## Code Style

- TypeScript strict mode
- Prefer async/await over callbacks
- Use named exports
```

---

## Доступные MCP-инструменты

CLI-сессии подключаются к боту через два MCP-сервера:

### `helyx` (HTTP, общий)
| Инструмент | Описание |
|---|---|
| `set_session_name` | Задать имя сессии (вызывается автоматически) |
| `reply` | Ответить в Telegram-чат |
| `react` | Поставить реакцию на сообщение |
| `edit_message` | Отредактировать сообщение бота |
| `remember` | Сохранить в долгосрочную память |
| `recall` | Семантический поиск по памяти |
| `forget` | Удалить воспоминание |
| `list_memories` | Список воспоминаний |
| `list_sessions` | Список сессий |
| `session_info` | Информация о сессии |

### `helyx-channel` (stdio, per-session)
| Инструмент | Описание |
|---|---|
| `reply` | Ответить в Telegram (прямой доступ к Bot API) |
| `update_status` | Обновить статус-сообщение в Telegram |
| `remember` | Сохранить в память |
| `recall` | Поиск по памяти |
| `forget` | Удалить воспоминание |
| `list_memories` | Список воспоминаний |

---

## Авто-одобрение MCP-инструментов

Чтобы CLI не спрашивал разрешение на каждый MCP-вызов, добавь в `<project>/.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__helyx__*",
      "mcp__helyx-channel__*"
    ]
  }
}
```

Или в глобальный `~/.claude/settings.local.json` для всех проектов.

---

## Советы

- **Не перегружай CLAUDE.md** — Claude читает его при каждом запуске. Держи файл кратким и по делу.
- **Используй императивные инструкции** — "Call X", "Never do Y", "Always check Z".
- **Проектный CLAUDE.md коммитится в git** — вся команда получает одинаковые инструкции.
- **`settings.local.json` НЕ коммитится** — это личные настройки (permissions, tokens).
