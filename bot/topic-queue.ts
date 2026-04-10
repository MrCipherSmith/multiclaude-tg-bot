import { logger } from "../logger.ts";

const queues = new Map<string, Promise<void>>();
const queueDepth = new Map<string, number>();

/**
 * Enqueue a task for a specific topic key.
 * Tasks for the same key run sequentially; different keys run in parallel.
 * If onQueued is provided and there are already tasks waiting, it is called
 * immediately with the position in queue (1 = one task ahead, etc.).
 */
export function enqueueForTopic(
  key: string,
  task: () => Promise<void>,
  onQueued?: (position: number) => void,
): void {
  const depth = (queueDepth.get(key) ?? 0) + 1;
  queueDepth.set(key, depth);
  if (depth > 1 && onQueued) onQueued(depth - 1);

  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev
    .then(task)
    .catch((err) => logger.error({ err, key }, "topic queue task failed"))
    .finally(() => {
      const d = (queueDepth.get(key) ?? 1) - 1;
      if (d <= 0) queueDepth.delete(key);
      else queueDepth.set(key, d);
    });
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
