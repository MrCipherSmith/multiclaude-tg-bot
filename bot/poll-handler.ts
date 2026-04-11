import type { Context } from "grammy";
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";
import { appendLog } from "../utils/stats.ts";

/**
 * Called when a user votes in a non-anonymous poll.
 * Stores the answer in the poll_sessions table.
 */
export async function handlePollAnswer(ctx: Context): Promise<void> {
  const pollAnswer = ctx.pollAnswer;
  if (!pollAnswer) return;

  const pollId = pollAnswer.poll_id;
  const optionIds = pollAnswer.option_ids; // [] means user retracted vote

  try {
    // Find the poll session that owns this poll_id (Bug 6: skip sessions older than 24h)
    const rows = await sql`
      SELECT id, answers, questions, telegram_poll_ids, status
      FROM poll_sessions
      WHERE telegram_poll_ids @> ${JSON.stringify([pollId])}::jsonb
        AND status = 'pending'
        AND created_at > NOW() - INTERVAL '24 hours'
      LIMIT 1
    `;

    if (!rows.length) return; // Not our poll

    const session = rows[0];
    const answers = (session.answers as Record<string, number | null>) ?? {};

    if (optionIds.length === 0) {
      // User retracted vote
      delete answers[pollId];
    } else {
      answers[pollId] = optionIds[0]; // single-choice — take first
    }

    await sql`UPDATE poll_sessions SET answers = ${sql.json(answers)} WHERE id = ${session.id}`;
    logger.debug({ pollSessionId: session.id, pollId, optionIds }, "poll answer stored");
  } catch (err) {
    logger.error({ err }, "handlePollAnswer error");
  }
}

/**
 * Called when user clicks "Готово ✅" button.
 * Collects all answers, formats them, and queues back to Claude.
 */
export async function handlePollSubmit(ctx: Context, pollSessionId: number): Promise<void> {
  try {
    const rows = await sql`
      SELECT ps.*, s.id as sid
      FROM poll_sessions ps
      JOIN sessions s ON s.id = ps.session_id
      WHERE ps.id = ${pollSessionId} AND ps.status = 'pending'
    `;

    if (!rows.length) {
      await ctx.answerCallbackQuery({ text: "Опрос уже завершён или не найден" });
      return;
    }

    const session = rows[0];

    // Bug 6: Expire sessions older than 24 hours
    const ageMs = Date.now() - new Date(session.created_at as string).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      await sql`UPDATE poll_sessions SET status = 'expired' WHERE id = ${pollSessionId}`;
      try {
        if (session.submit_message_id) {
          await ctx.editMessageText("⏰ Опрос истёк");
        }
      } catch {}
      await ctx.answerCallbackQuery({ text: "⏰ Этот опрос истёк (>24ч)", show_alert: true });
      return;
    }

    const questions = session.questions as Array<{ question: string; options: string[] }>;
    const pollIds = session.telegram_poll_ids as string[];
    const answers = session.answers as Record<string, number | null>;

    // Check if all questions are answered
    const unanswered = pollIds.filter((pid) => answers[pid] === undefined);
    if (unanswered.length > 0) {
      await ctx.answerCallbackQuery({
        text: `Осталось ответить на ${unanswered.length} вопр${unanswered.length === 1 ? "ос" : "оса"}`,
        show_alert: true,
      });
      return;
    }

    // Format answers as readable text
    const lines = questions.map((q, i) => {
      const pollId = pollIds[i];
      const optIdx = answers[pollId];
      const chosenOption = optIdx !== null && optIdx !== undefined ? q.options[optIdx] : "—";
      return `• ${q.question}\n  → ${chosenOption}`;
    });

    const title = session.title ? `Ответы на опрос «${session.title}»:\n\n` : "Ответы на опрос:\n\n";
    const formattedAnswers = title + lines.join("\n\n");

    // Mark poll session as submitted
    await sql`UPDATE poll_sessions SET status = 'submitted' WHERE id = ${pollSessionId}`;

    // Queue answers as a user message back to Claude
    const chatId = String(session.chat_id);
    const sessionId = session.session_id as number;

    await sql`
      INSERT INTO message_queue (session_id, chat_id, from_user, content, message_id)
      VALUES (${sessionId}, ${chatId}, 'user', ${formattedAnswers}, ${'poll_submit'})
    `;

    appendLog(sessionId, chatId, "poll", `answers submitted for session ${pollSessionId}`);

    // Edit the submit button message to show completed state
    try {
      await ctx.editMessageText("✅ Ответы отправлены");
    } catch {}

    await ctx.answerCallbackQuery({ text: "Ответы отправлены!" });
    logger.info({ pollSessionId, chatId }, "poll answers submitted to queue");
  } catch (err) {
    logger.error({ err }, "handlePollSubmit error");
    await ctx.answerCallbackQuery({ text: "Ошибка при отправке ответов" });
  }
}
