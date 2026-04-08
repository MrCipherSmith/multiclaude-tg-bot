# Session Management Redesign — Implementation Context v1

## Critical findings

### No Hono router
Routes are raw if/else chain in mcp/server.ts startMcpHttpServer().
New route /api/sessions/:id/summarize-work goes after line 278, before webhook handler.
Pattern: url.pathname.match(/^\/api\/sessions\/(\d+)\/summarize-work$/)

### MCP tools registered in TWO places
- mcp/tools.ts TOOL_DEFINITIONS (used by channel.ts stdio MCP)
- mcp/server.ts registerTools() (used by HTTP MCP)
- channel.ts lines 492-568 has its OWN separate tool list
All three need search_project_context added.

### config.ts missing ARCHIVE_TTL_DAYS
Must add: ARCHIVE_TTL_DAYS: Number(process.env.ARCHIVE_TTL_DAYS ?? "30")

### channel.ts is a separate process
Reads env directly, not via config.ts. Has own sql pool (max:3).

### deleteSessionCascade also deletes memories
sessions/delete.ts line 15. Must NEVER be called on remote sessions.

### Advisory lock uses session ID as integer
Remote sessions must have stable IDs (never deleted) — design satisfies this.

### handleCleanup (session.ts:228) deletes all status='disconnected'
After redesign remote=inactive, local=terminated — filter must be updated.

### main.ts cleanup job (lines 9-48)
Currently deletes permission_requests by created_at (not archived_at).
Deletes ALL disconnected sessions including remote ones — must scope to local only.

### summarizeConversation() in claude/client.ts
Expects JSON {summary, facts}. Work-session summary needs different prompt.
Must use Promise.race() for 30s timeout with fallback to raw concat.

## Files to change
- config.ts — add ARCHIVE_TTL_DAYS
- memory/db.ts — migrations v6,v7,v8
- sessions/manager.ts — status vocab, project_id field, markStale fix, cleanup guard
- memory/summarizer.ts — summarizeWork() + archival in trySummarize()
- memory/long-term.ts — add 'project_context' type, search function
- mcp/tools.ts — search_project_context definition + handler
- mcp/server.ts — new route + registerTools search_project_context
- channel.ts — resolveSession project_id, markDisconnected status, triggerSummarize routing
- channel.ts own tool list (lines 492-568) — add search_project_context
- main.ts — TTL cleanup extension
- bot/commands/project-add.ts — DB instead of file
- bot/commands/projects.ts — DB instead of file
- bot/commands/session.ts — briefing on switch, cleanup guard, status display
- bot/callbacks.ts — briefing on switch callback
- claude/client.ts — summarizeWorkSession() function
- scripts/admin-daemon.ts — read from DB instead of tmux-projects.json (implicit PRD scope)
