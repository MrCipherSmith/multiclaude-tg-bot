import type { Context } from "grammy";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { setPendingInput } from "../handlers.ts";
import { projectService } from "../../services/project-service.ts";
import { forumService } from "../../services/forum-service.ts";
import { CONFIG } from "../../config.ts";
import { logger } from "../../logger.ts";
import { replyInThread } from "../format.ts";

const HOST_HOME = process.env.HOST_HOME ?? "";

/** Convert a host-side absolute path to the container-visible path for existence checks. */
function toContainerPath(hostPath: string): string {
  if (HOST_HOME && hostPath.startsWith(HOST_HOME)) {
    return "/host-home" + hostPath.slice(HOST_HOME.length);
  }
  return hostPath;
}

export async function handleProjectAdd(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/project[_-]add\s*/, "").trim();

  if (arg) {
    await addProject(ctx, arg);
  } else {
    const chatId = String(ctx.chat!.id);
    const hostProjects = CONFIG.HOST_PROJECTS_DIR ?? "/home/user";
    await replyInThread(ctx, `Enter project path:\ne.g. ${join(hostProjects, "my-project")}`);
    setPendingInput(chatId, async (replyCtx) => {
      const path = replyCtx.message?.text?.trim() ?? "";
      await addProject(replyCtx, path);
    });
  }
}

async function addProject(ctx: Context, path: string): Promise<void> {
  if (!path.startsWith("/")) {
    await replyInThread(ctx, "Path must be absolute (start with /).");
    return;
  }

  const containerPath = toContainerPath(path);
  if (!existsSync(containerPath)) {
    await replyInThread(ctx, `❌ Path not found: ${path}`);
    return;
  }

  const name = path.split("/").pop() ?? path;

  let project = await projectService.create(name, path);
  let isNew = true;
  if (!project) {
    project = await projectService.getByPath(path);
    if (!project) {
      await replyInThread(ctx, `❌ Failed to get project: ${path}`);
      return;
    }
    isNew = false;
  }

  // Link any orphan sessions that were created before this project record existed
  {
    const { sql } = await import("../../memory/db.ts");
    await sql`
      UPDATE sessions SET project_id = ${project.id}
      WHERE project_path = ${path} AND project_id IS NULL
    `;
  }

  // FR-2: create forum topic if forum is configured; verify existing topic is alive
  const forumChatId = await forumService.getForumChatId();
  if (forumChatId) {
    const { sql } = await import("../../memory/db.ts");
    const topicRow = await sql`SELECT forum_topic_id FROM projects WHERE id = ${project.id}`;
    const existingTopicId = topicRow[0]?.forum_topic_id as number | null | undefined;

    // Verify existing topic is still alive in Telegram
    let topicAlive = false;
    if (existingTopicId) {
      try {
        await ctx.api.sendMessage(Number(forumChatId), `📌 ${project.name}`, {
          message_thread_id: existingTopicId,
        } as any);
        topicAlive = true;
      } catch {
        // Topic was deleted — clear stale ID and recreate below
        await sql`UPDATE projects SET forum_topic_id = NULL WHERE id = ${project.id}`;
        logger.info({ project: project.name, topicId: existingTopicId }, "project-add: stale forum_topic_id cleared");
      }
    }

    if (!topicAlive) {
      try {
        const allProjects = await sql`SELECT id FROM projects WHERE forum_topic_id IS NOT NULL`;
        const colorIndex = allProjects.length;
        const threadId = await forumService.createTopicForProject(ctx.api, forumChatId, project, colorIndex);
        await ctx.api.sendMessage(Number(forumChatId), `📁 ${project.name}\n${project.path}`, {
          message_thread_id: threadId,
        } as any);
        await replyInThread(ctx, isNew
          ? `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`
          : `✅ Forum topic recreated for: ${project.name}`
        );
      } catch (err) {
        logger.error({ err, project: project.name }, "project-add: failed to create forum topic");
        await replyInThread(ctx, isNew
          ? `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`
          : `Project already exists: ${path} (forum topic creation failed)`
        );
      }
    } else {
      await replyInThread(ctx, isNew
        ? `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`
        : `Project already exists: ${path} (forum topic already active)`
      );
    }
  } else {
    await replyInThread(ctx, isNew
      ? `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`
      : `Project already exists: ${path}`
    );
  }

  // Inject bot rules into CLAUDE.md
  const claudeMdStatus = injectBotRules(containerPath);
  if (claudeMdStatus === "created") {
    await replyInThread(ctx, "📝 CLAUDE.md создан с правилами бота. Напиши `/init` в топике проекта чтобы Claude проанализировал кодовую базу.");
  } else if (claudeMdStatus === "updated") {
    await replyInThread(ctx, "📝 Правила бота добавлены в существующий CLAUDE.md.");
  } else if (claudeMdStatus === "readonly") {
    await replyInThread(ctx, "⚠️ Не удалось записать CLAUDE.md — файловая система read-only. Добавь правила бота вручную.");
  }

  // Trigger async project knowledge scan (non-blocking)
  const { scanProjectKnowledge } = await import("../../memory/project-scanner.ts");
  scanProjectKnowledge(project.path).catch((err) =>
    logger.error({ err, path: project.path }, "project-add: scan error")
  );
}

const BOT_RULES_MARKER = "<!-- helyx-rules -->";

const BOT_RULES_SECTION = `
${BOT_RULES_MARKER}
## Bot Integration

### Session start — load context
At the beginning of any session where you will do significant work on this codebase,
call \`search_project_context(query="project architecture constraints conventions")\`
to load facts saved in previous sessions. Read the results before exploring source files.

### During work — search memory proactively
Call \`recall(query="<topic>")\` before exploring unfamiliar code or starting a new task:

- Before touching auth/DB/config code: \`recall("auth middleware")\`, \`recall("database schema")\`
- When you see an unfamiliar pattern: \`recall("<pattern name>")\`
- Before implementing something significant: \`recall("<feature area>")\`
- When debugging a hard problem: \`recall("<error or component name>")\`

### During work — save facts proactively
Call \`remember(type="fact", tags=["project", "<category>"])\` when you discover anything
a future Claude session should know:

- Architecture decisions and why they were made
- Non-obvious constraints (hardcoded ports, required env vars, ordering dependencies)
- Important file roles that are not obvious from the name
- Setup quirks (e.g. "downloads/ must be pre-created before Docker starts")
- Naming or coding conventions specific to this project
- Gotchas you encountered

Write facts as self-contained sentences — assume the future reader has no context from
this session.

Good: \`"channel.ts pre-registers MCP sessions before Claude Code connects to avoid a race condition on startup"\`
Bad: \`"fixed bug in channel.ts today"\`

### What NOT to save
- Transient task state ("I just edited X")
- Things already documented in source comments or README
- Per-session events
`;

function injectBotRules(containerPath: string): "created" | "updated" | "skipped" | "readonly" {
  const claudeMdPath = `${containerPath}/CLAUDE.md`;

  try {
    if (existsSync(claudeMdPath)) {
      const existing = readFileSync(claudeMdPath, "utf-8");
      if (existing.includes(BOT_RULES_MARKER)) {
        return "skipped";
      }
      writeFileSync(claudeMdPath, existing.trimEnd() + "\n" + BOT_RULES_SECTION, "utf-8");
      logger.info({ path: claudeMdPath }, "project-add: appended bot rules to CLAUDE.md");
      return "updated";
    }

    writeFileSync(claudeMdPath, BOT_RULES_SECTION.trimStart(), "utf-8");
    logger.info({ path: claudeMdPath }, "project-add: created CLAUDE.md with bot rules");
    return "created";
  } catch (err: any) {
    logger.warn({ path: claudeMdPath, err: err?.message }, "project-add: cannot write CLAUDE.md (read-only fs?)");
    return "readonly";
  }
}
