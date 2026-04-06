# PRD: telegram-webapp (Claude Dev Hub)
version: 1.0.0
date: 2026-04-06
status: ready-for-implementation

## SCOPE
feature: telegram-webapp
change_type: UI + integration + new endpoints
phases: [1a, 1b, 1c, 2]

## MODULES
NEW:  dashboard/src/webapp/  (separate entry point from main dashboard)
MOD:  main.ts  (add /api/git/*, /api/permissions/*, /api/sessions endpoints)
NEW:  utils/git-runner.ts  (git command executor with project_path context)

## DATA SOURCES
sessions:
  table: sessions
  filter: status = 'active'
  fields: id, name, project_path, last_active

git:
  executor: Bun.spawn(['git', ...args], { cwd: session.project_path })
  commands:
    tree:   git ls-tree --name-only -r HEAD
    file:   git show HEAD:{filepath}
    diff:   git diff HEAD~1 --unified=5
    log:    git log --oneline --format="%H %s" -50
    commit: git show {hash} --unified=5
    status: git status --porcelain
    branches: git branch -a

permissions:
  table: permission_requests
  filter: response IS NULL AND session_id = ?
  fields: id, session_id, tool_name, description, message_id, created_at

## API ENDPOINTS (main.ts — Hono)

GET /api/webapp/sessions
  auth: initData validation (Telegram.WebApp.initData)
  response: Session[]

GET /api/webapp/git/:sessionId/tree
  response: { files: string[] }
  impl: git ls-tree --name-only -r HEAD

GET /api/webapp/git/:sessionId/file?path=<filepath>
  response: { content: string, language: string }
  impl: git show HEAD:{filepath}
  edge: binary → { binary: true }

GET /api/webapp/git/:sessionId/diff?base=HEAD~1&head=HEAD
  response: { diff: string }
  impl: git diff {base}..{head}

GET /api/webapp/git/:sessionId/log?limit=50
  response: { commits: { hash, subject, date, author }[] }

GET /api/webapp/git/:sessionId/commit/:hash
  response: { diff: string, subject: string, body: string }

GET /api/webapp/git/:sessionId/status
  response: { files: { path, status }[] }
  status codes: M=modified, A=added, D=deleted, ?=untracked

GET /api/webapp/git/:sessionId/branches
  response: { current: string, branches: string[] }

GET /api/webapp/permissions/:sessionId
  response: PermissionRequest[]
  filter: response IS NULL

POST /api/webapp/permissions/:id/respond
  body: { response: 'allow' | 'deny' }
  impl: UPDATE permission_requests SET response=? WHERE id=?

POST /api/webapp/permissions/:id/always
  body: { tool_name: string }
  impl:
    1. UPDATE permission_requests SET response='allow' WHERE id=?
    2. read ~/.claude/projects/{encoded_path}/settings.local.json
    3. append tool_name to permissions.allow[]
    4. write back

GET /api/webapp/session/:sessionId/status
  response: { status: 'idle'|'working', tool: string|null, file: string|null }
  impl: query permission_requests last entry + sessions.last_active

## FRONTEND ARCHITECTURE
entry: dashboard/src/webapp/main.tsx (separate from dashboard main.tsx)
build: separate vite config → dist/webapp/
served: GET /webapp → static SPA

Telegram.WebApp integration:
  - Telegram.WebApp.ready() on mount
  - Telegram.WebApp.expand() for full height
  - colorScheme: light/dark → CSS variables
  - initData → send as Authorization header to all API calls
  - MainButton: not used in Phase 1

## UI STRUCTURE
Layout:
  ├─ Sidebar (collapsible on mobile)
  │   ├─ Session list (from /api/webapp/sessions)
  │   ├─ Each item: {name} · {project_path basename} · {status dot}
  │   └─ Search input (filters file tree in main area)
  └─ Main area (tabs per selected session)
      ├─ Tab: Files     → file tree + file viewer
      ├─ Tab: Git       → log / diff / status / branches
      ├─ Tab: Status    → Claude activity monitor
      └─ Tab: Perms     → permission requests queue

## FILE SEARCH
  - Input in sidebar filters file tree
  - fuzzy match on filename (not path)
  - debounce 200ms
  - results: flat list of matching paths, click → open file viewer

## SYNTAX HIGHLIGHTING
  library: shiki (tree-sitter based, good mobile perf)
  languages: ts, js, tsx, jsx, py, go, rust, sql, json, md, sh, yaml
  theme: follows Telegram.WebApp.colorScheme

## PERMISSION FLOW
  1. GET /api/webapp/permissions/:sessionId → show queue
  2. User taps Allow → POST /respond { response: 'allow' }
  3. User taps Deny → POST /respond { response: 'deny' }
  4. User taps Always → POST /always { tool_name }
     → updates settings.local.json + marks allowed
  5. Item removed from queue after response
  polling: every 3s when Perms tab active

## SESSION STATUS POLLING
  GET /api/webapp/session/:sessionId/status every 2s
  display:
    idle: grey dot "Idle"
    working: animated dot + "Reading: {file}" | "Running: {cmd}" | "Editing: {file}"

## EDGE CASES
- project_path not on disk → { error: 'path_not_found' } → show in UI, no crash
- not a git repo → { error: 'not_git_repo' } → show "Not a git repository"
- binary file → show "Binary file — preview not available"
- diff > 5000 lines → truncate + "Showing first 5000 lines"
- no active sessions → empty state with message
- permission expired (no longer in DB) → remove from list silently
- sessionId from URL param doesn't match active sessions → redirect to session list

## PHASE 2: GITHUB
  new endpoints:
    GET /api/webapp/github/:sessionId/prs       → gh pr list --json
    GET /api/webapp/github/:sessionId/pr/:number → pr detail + diff + comments
    GET /api/webapp/github/:sessionId/issues     → gh issue list --json
  requires: GITHUB_TOKEN in .env, gh CLI on host

## ACCEPTANCE CRITERIA (Gherkin)

```gherkin
Feature: Telegram Mini App — Claude Dev Hub

  Scenario: WebApp loads and shows sessions
    Given user opens WebApp via bot menu button
    And Telegram.WebApp.initData is valid
    Then sidebar shows active sessions from DB
    And first session is auto-selected

  Scenario: Browse files
    Given session with project_path="/home/altsay/bots/claude-bot" selected
    When user opens Files tab
    Then GET /api/webapp/git/:id/tree called
    And file tree rendered
    When user clicks "channel.ts"
    Then file content shown with syntax highlighting

  Scenario: File search
    Given Files tab open
    When user types "handler" in sidebar search
    Then file list filters to files matching "handler"
    And results appear within 300ms

  Scenario: View git log
    Given Git tab open
    When user selects "Log" view
    Then list of last 50 commits shown
    When user taps commit
    Then diff for that commit shown

  Scenario: Approve permission
    Given Perms tab has 1 pending permission_request
    When user taps Allow
    Then POST /respond { response: 'allow' } sent
    And item removed from list

  Scenario: Always Allow
    Given pending permission for "Bash"
    When user taps Always Allow
    Then POST /always sent
    And settings.local.json updated with tool pattern
    And permission marked allowed

  Scenario: No active sessions
    Given sessions table has no active rows
    Then WebApp shows empty state "No active sessions"

  Scenario: Invalid git path
    Given session.project_path does not exist on disk
    Then Files tab shows error "Project path not found"
    And app does not crash
```

## FILES TO CREATE/MODIFY
NEW:  dashboard/src/webapp/main.tsx
NEW:  dashboard/src/webapp/App.tsx
NEW:  dashboard/src/webapp/components/Sidebar.tsx
NEW:  dashboard/src/webapp/components/FileTree.tsx
NEW:  dashboard/src/webapp/components/FileViewer.tsx
NEW:  dashboard/src/webapp/components/GitLog.tsx
NEW:  dashboard/src/webapp/components/DiffViewer.tsx
NEW:  dashboard/src/webapp/components/SessionStatus.tsx
NEW:  dashboard/src/webapp/components/PermissionQueue.tsx
NEW:  dashboard/vite.webapp.config.ts
NEW:  utils/git-runner.ts
MOD:  main.ts  (add /api/webapp/* routes)

## VERIFICATION
- Mobile Telegram: open WebApp, check theme adapts to dark/light
- psql: verify permission response written on Allow tap
- git: verify file content matches actual file on disk
- perf: Lighthouse mobile score > 80
- security: verify initData validation rejects tampered requests
