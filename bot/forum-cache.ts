/**
 * In-memory cache for forum_chat_id.
 *
 * Loaded lazily on first message; invalidated after /forum_setup.
 * Avoids a DB query on every incoming message.
 */

import { sql } from "../memory/db.ts";

let _forumChatId: string | null | undefined = undefined; // undefined = not loaded yet

export async function getForumChatId(): Promise<string | null> {
  if (_forumChatId !== undefined) return _forumChatId;
  try {
    const rows = await sql`SELECT value FROM bot_config WHERE key = 'forum_chat_id'`;
    const val = rows[0]?.value as string | undefined;
    _forumChatId = val && val.length > 0 ? val : null;
  } catch {
    _forumChatId = null;
  }
  return _forumChatId;
}

/** Call after /forum_setup or /forum_sync so next message reloads from DB. */
export function invalidateForumCache(): void {
  _forumChatId = undefined;
}
