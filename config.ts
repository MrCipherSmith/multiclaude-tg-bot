export const CONFIG = {
  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  ALLOWED_USERS: (process.env.ALLOWED_USERS ?? "")
    .split(",")
    .map(Number)
    .filter(Boolean),

  // Claude
  CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514",
  MAX_TOKENS: Number(process.env.MAX_TOKENS ?? "8192"),

  // PostgreSQL
  DATABASE_URL: process.env.DATABASE_URL!,

  // Ollama
  OLLAMA_URL: process.env.OLLAMA_URL ?? "http://localhost:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
  VECTOR_DIMENSIONS: 768,

  // Telegram transport
  TELEGRAM_TRANSPORT: (process.env.TELEGRAM_TRANSPORT ?? "polling") as "polling" | "webhook",
  TELEGRAM_WEBHOOK_URL: process.env.TELEGRAM_WEBHOOK_URL ?? "",
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
  TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH ?? "/telegram/webhook",

  // Server
  PORT: Number(process.env.PORT ?? "3847"),
  SHORT_TERM_WINDOW: Number(process.env.SHORT_TERM_WINDOW ?? "20"),
  IDLE_TIMEOUT_MS: Number(process.env.IDLE_TIMEOUT_MS ?? "900000"), // 15 min
} as const;
