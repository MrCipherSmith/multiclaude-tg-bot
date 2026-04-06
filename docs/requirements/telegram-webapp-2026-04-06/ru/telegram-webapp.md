# ПРД: Telegram Mini App — Claude Dev Hub

## 1. Обзор

Telegram WebApp (Mini App) внутри бота @GoodeaAIBot — многофункциональный клиент для мониторинга Claude-сессий, управления разрешениями и работы с git-репозиториями активных проектов. Открывается из кнопки меню бота, адаптирован под мобильный Telegram.

---

## 2. Контекст

- **Продукт:** @GoodeaAIBot
- **Тип:** Telegram Mini App (WebApp API)
- **Стек фронта:** React + TypeScript + Vite (расширение существующего `dashboard/`)
- **Стек бэка:** Bun + Hono (`main.ts`) + PostgreSQL + git CLI
- **Данные о сессиях:** таблица `sessions` (поле `project_path`)
- **Существующий дашборд:** остаётся отдельно — WebApp не заменяет его

---

## 3. Проблема

- Невозможно удобно просматривать файлы, дифы и статус git из Telegram
- Permission-запросы от Claude приходят как текст — нет нормального preview
- Нет быстрого способа переключиться между проектами и понять что делает Claude

---

## 4. Цели

- Боковая навигация по сессиям/проектам из активных Claude-сессий
- Поиск по файлам текущего проекта
- Git-браузер: файлы, дифы, лог, ветки, статус
- Мониторинг статуса текущей сессии (что делает Claude прямо сейчас)
- Permission UI: просмотр + Approve / Deny / Always Allow
- Фаза 2: интеграция с GitHub API (PRы, комменты, issues)

---

## 5. Non-Goals

- Редактирование файлов (только просмотр)
- Управление скилами/командами/хуками (отдельный ПРД)
- Отправка сообщений Claude из WebApp (только мониторинг)
- Поддержка SVN/Mercurial
- Уведомления Push (за рамками)
- Замена существующего дашборда

---

## 6. Функциональные требования

### Фаза 1

**FR-1: Навигация — боковое меню**
- Список активных сессий из `sessions WHERE status = 'active'`
- Каждый элемент: название сессии + `project_path` + статус Claude
- Выбор сессии → меняет контекст всего приложения
- Поиск по файлам внутри выбранного проекта (fuzzy, по имени файла)

**FR-2: Git-браузер**
- **Файлы:** дерево файлов текущей ветки (`git ls-tree --name-only -r HEAD`)
- **Просмотр файла:** содержимое с подсветкой синтаксиса
- **Диф:** `git diff HEAD~1` и `git diff <branch>` — side-by-side или unified
- **Лог:** `git log --oneline -50` — список коммитов, клик → диф коммита
- **Ветки:** список веток, переключение (только read — `git show <branch>:file`)
- **Статус:** `git status` — modified/staged/untracked файлы

**FR-3: Мониторинг сессии**
- Текущий статус из `sessions.last_active` + последний `tool_name` из `permission_requests` или `request_logs`
- Индикатор: "Idle" / "Reading: file.ts" / "Running: git status" / "Editing: handler.ts"
- Обновление: polling каждые 2 сек (или WebSocket если уже есть)

**FR-4: Permission UI**
- Список ожидающих разрешений из `permission_requests WHERE response IS NULL AND session_id = ?`
- Каждый запрос: инструмент, описание, полный preview (diff или команда)
- Кнопки: ✅ Allow / ❌ Deny / ♾️ Always Allow
- Always Allow: добавляет паттерн в `settings.local.json` (через API)
- После ответа: `UPDATE permission_requests SET response = ? WHERE id = ?`

### Фаза 2 (после Фазы 1)

**FR-5: GitHub интеграция**
- Список PRов репозитория (`gh pr list` или GitHub API)
- PR detail: title, description, diff, comments
- Review comments: thread view
- Issues: list + detail

---

## 7. Нефункциональные требования

**NFR-1:** Открывается за < 2 сек на мобильном Telegram  
**NFR-2:** Адаптирован под тёмную/светлую тему Telegram (`Telegram.WebApp.colorScheme`)  
**NFR-3:** Git-команды выполняются на сервере (никаких git в браузере)  
**NFR-4:** WebApp открывается по кнопке в меню бота (не по ссылке)  
**NFR-5:** Авторизация через `Telegram.WebApp.initData` (тот же механизм что у текущего dashboard)  

---

## 8. Ограничения

- Git-команды запускаются через `Bun.spawn` или `child_process` в `main.ts`
- `project_path` из сессий — абсолютные пути на хосте (доступны серверу)
- GitHub токен из `.env` для Фазы 2
- Подсветка синтаксиса: `shiki` или `highlight.js` (лёгкий бандл)
- Telegram WebApp max viewport: ~100vh, без внешних окон

---

## 9. Edge Cases

- Сессия есть в БД, но `project_path` не существует на диске → показать ошибку, не крашить
- Репозиторий не инициализирован (`git status` fail) → показать "Not a git repo"
- Нет активных сессий → экран-заглушка "No active sessions"
- Permission запрос истёк (timeout в channel.ts) → автоматически убирать из списка
- Бинарный файл в браузере файлов → показать "Binary file, cannot preview"
- Очень большой диф (> 1000 строк) → виртуальный скролл или пагинация

---

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Telegram Mini App — Claude Dev Hub

  Scenario: Открытие и выбор проекта
    Given пользователь нажимает кнопку WebApp в боте
    And есть 2 активные сессии в БД
    Then WebApp открывается с боковым меню
    And меню показывает 2 проекта с именами и статусами
    When пользователь выбирает проект "claude-bot"
    Then контекст переключается на этот проект

  Scenario: Просмотр файлов проекта
    Given выбран проект с project_path="/home/altsay/bots/claude-bot"
    When пользователь открывает вкладку "Files"
    Then отображается дерево файлов из `git ls-tree`
    When пользователь кликает на "channel.ts"
    Then показывается содержимое файла с подсветкой синтаксиса

  Scenario: Поиск по файлам
    Given выбран проект
    When пользователь вводит "handler" в поиск
    Then список сужается до файлов содержащих "handler" в имени
    And результаты появляются за < 300ms

  Scenario: Просмотр дифа коммита
    Given открыт git лог
    When пользователь кликает на коммит "fix: transfer chat routing"
    Then показывается диф этого коммита в unified формате

  Scenario: Approve разрешения
    Given есть ожидающий permission_request для "Bash: git status"
    When пользователь нажимает ✅ Allow
    Then UPDATE permission_requests SET response='allow' WHERE id=?
    And запрос исчезает из списка

  Scenario: Always Allow разрешения
    Given есть permission_request для "Read: /home/altsay/..."
    When пользователь нажимает ♾️ Always Allow
    Then паттерн добавляется в settings.local.json
    And response='allow' записывается в БД
    And кнопки исчезают

  Scenario: Нет активных сессий
    Given в таблице sessions нет записей со status='active'
    Then WebApp показывает "No active sessions"
    And предлагает запустить сессию
```

---

## 11. Архитектура (высокий уровень)

```
Telegram WebApp (React SPA)
    ↕ HTTPS / initData auth
Bot API (main.ts — Hono)
    ├─ GET  /api/sessions          → sessions table
    ├─ GET  /api/git/:sessionId/tree    → git ls-tree
    ├─ GET  /api/git/:sessionId/file    → git show HEAD:file
    ├─ GET  /api/git/:sessionId/diff    → git diff
    ├─ GET  /api/git/:sessionId/log     → git log
    ├─ GET  /api/git/:sessionId/status  → git status
    ├─ GET  /api/permissions/:sessionId → permission_requests
    ├─ POST /api/permissions/:id/respond → update response
    └─ POST /api/permissions/:id/always  → update settings.local.json
```

---

## 12. Roadmap

| Фаза | Содержание | Приоритет |
|------|-----------|-----------|
| 1a | Боковое меню сессий + git-браузер (файлы, лог, диф, статус) | P0 |
| 1b | Мониторинг статуса Claude + Permission UI | P0 |
| 1c | Поиск по файлам проекта | P1 |
| 2 | GitHub API: PRы, комменты, issues | P2 |

---

## 13. Верификация

- **Ручное:** открыть WebApp в Telegram на мобильном — проверить тему, навигацию, git-вывод
- **Permission flow:** создать тестовый permission_request в БД → нажать Allow → проверить response
- **Git:** выбрать сессию → открыть файл → проверить подсветку синтаксиса
- **Observability:** все git-команды логируются в `request_logs` с `session_id`
