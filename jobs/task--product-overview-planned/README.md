# Job: task--product-overview-planned

**Intent:** implement  
**Source:** PRD docs/requirements/product-overview-2026-04-07 (Planned ⬜ items)  
**Branch:** feature/product-overview-planned  
**Base:** main  

## Features

1. **Dashboard project management** — Start/Stop/create projects from web UI
2. **Memory TTL per type** — per-type retention (fact/summary/decision/note/project_context)
3. **Dashboard browser notifications** — SSE + Web Notifications API

## Plan

| Step | Agent | Status |
|------|-------|--------|
| context | context-collector | ✅ done |
| prepare | orchestrator | 🔄 |
| Wave 1: task-2-ttl | task-implementer | ⏳ |
| Wave 2: task-1-dash | task-implementer | ⏳ |
| Wave 3: task-3-notif | task-implementer | ⏳ |
| sanity-check | orchestrator | ⏳ |
| review | code-review | ⏳ |
| fix | task-implementer | ⏳ conditional |
| checks | orchestrator | ⏳ |
| report | orchestrator | ⏳ |
| pr | orchestrator | ⏳ |
