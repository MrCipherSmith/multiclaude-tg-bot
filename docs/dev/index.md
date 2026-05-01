# Helyx Documentation Index

Navigation map for all generated documentation. Each entry links to the document and its major sections.

---

## Documents

### [README.md](README.md)
Publication-ready project overview for new developers. Covers what Helyx is, key features, architecture diagram, quick-start steps, top Telegram commands, MCP tool summary, dashboard overview, environment variable table, and tech stack.

Sections: [What is Helyx](README.md#what-is-helyx) · [Key Features](README.md#key-features) · [Architecture at a Glance](README.md#architecture-at-a-glance) · [Quick Start](README.md#quick-start) · [Telegram Commands](README.md#telegram-commands) · [MCP Tools](README.md#mcp-tools) · [Dashboard](README.md#dashboard) · [Configuration](README.md#configuration) · [Tech Stack](README.md#tech-stack)

---

### [onboarding.md](onboarding.md)
Complete developer onboarding guide. Everything needed to go from zero to a running Helyx instance, plus day-to-day development workflows and troubleshooting for the most common failure modes.

Sections: [What is Helyx](onboarding.md#what-is-helyx) · [Architecture at a Glance](onboarding.md#architecture-at-a-glance) · [Prerequisites](onboarding.md#prerequisites) · [Setup Steps](onboarding.md#setup-steps) · [Project Structure](onboarding.md#project-structure) · [Development Workflow](onboarding.md#development-workflow) · [Common Tasks](onboarding.md#common-tasks) · [Troubleshooting](onboarding.md#troubleshooting)

---

### [architecture.md](architecture.md)
Deep-dive system architecture reference. Explains the hybrid event-driven message-broker design, the dual MCP transport mechanism, PostgreSQL-as-message-bus pattern, full inbound and outbound data flows, permission request flow, authentication surfaces, error recovery strategies, caching, and all key architectural decisions with rationale.

Sections: [Overview](architecture.md#overview) · [System Components](architecture.md#system-components) · [Deployment Split](architecture.md#deployment-split) · [The Two MCP Transports](architecture.md#the-two-mcp-transports) · [PostgreSQL as Message Bus](architecture.md#postgresql-as-message-bus) · [Data Flow: Telegram → Claude Code → Response](architecture.md#data-flow-telegram-message--claude-code--response) · [Permission Request Flow](architecture.md#permission-request-flow) · [Cross-Cutting Concerns](architecture.md#cross-cutting-concerns) · [Key Architectural Decisions](architecture.md#key-architectural-decisions)

---

### [modules.md](modules.md)
Per-module developer reference. For each of the 10 major modules: purpose, entry point, key files with responsibilities, public API exports, environment variables, how to develop and test, and inter-module dependencies.

Modules: [bot](modules.md#bot) · [channel](modules.md#channel) · [mcp](modules.md#mcp) · [sessions](modules.md#sessions) · [memory](modules.md#memory) · [services](modules.md#services) · [adapters](modules.md#adapters) · [utils](modules.md#utils) · [scripts](modules.md#scripts) · [dashboard](modules.md#dashboard)

---

### [api-reference.md](api-reference.md)
Complete API surface reference for all integration points.

- **Part 1: Telegram Bot Commands** — all commands grouped by category (session, memory, projects, forum, monitoring, admin, model, codex, onboarding) with arguments and descriptions
- **Part 2: MCP Tools — stdio channel adapter** — all 19 tools exposed by `channel.ts` with full parameter schemas; runs on host, delivers messages into Claude Code
- **Part 3: MCP Tools — HTTP Docker server** — all 18 tools exposed by the `mcp/` server over StreamableHTTP/SSE; runs in Docker, receives tool calls from Claude Code; notes differences from the stdio adapter
- **Part 4: Dashboard REST API** — all `/api/*` endpoints grouped by resource (auth, overview, sessions, logs, memories, projects, permissions, process health, git, SSE events, health check)
- **Part 5: WebApp Mini App API** — Telegram Mini App authentication flow and WebApp-specific endpoints

---

### [data-models.md](data-models.md)
PostgreSQL schema reference. All 24+ tables with column definitions, types, constraints, indexes, which processes write and read each table, and the trigger that drives `LISTEN/NOTIFY`. Covers pgvector HNSW index configuration for semantic search. Includes migration framework documentation and instructions for adding new migrations.

Schema domains: [Sessions & Routing](data-models.md#sessions--routing) · [Messages & Queue](data-models.md#messages--queue) · [Memory](data-models.md#memory) · [Skills Toolkit](data-models.md#skills-toolkit) · [Stats](data-models.md#stats) · [Config](data-models.md#config) · [Permissions](data-models.md#permissions) · [Running Migrations](data-models.md#running-migrations) · [pgvector Indexes](data-models.md#pgvector-indexes)

---

## Artifacts (Source Analysis)

The following artifacts were produced during the documentation generation process and contain raw analysis output. They are referenced by the documentation above.

| Artifact | Description |
|---|---|
| [../artifacts/project-map.md](../artifacts/project-map.md) | Module inventory, entry points, detected integrations, tech stack summary |
| [../artifacts/architecture.md](../artifacts/architecture.md) | Architecture analysis: component roles, integration map, data flows, cross-cutting concerns, observations |
