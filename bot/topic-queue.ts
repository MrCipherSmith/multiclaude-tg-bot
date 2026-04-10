import { logger } from "../logger.ts";

const queues = new Map<string, Promise<void>>();

/**
 * Enqueue a task for a specific topic key.
 * Tasks for the same key run sequentially; different keys run in parallel.
 */
export function enqueueForTopic(key: string, task: () => Promise<void>): void {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev
    .then(task)
    .catch((err) => logger.error({ err, key }, "topic queue task failed"));
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

/**
 * Compute the queue key: "chatId:topicId" for forum messages, "chatId" for DMs.
 */
export function topicQueueKey(chatId: string, forumTopicId?: number | null): string {
  return forumTopicId ? `${chatId}:${forumTopicId}` : chatId;
}
