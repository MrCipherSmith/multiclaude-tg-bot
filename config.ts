export const CONFIG = {
  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
  ALLOWED_USERS: (process.env.ALLOWED_USERS ?? "")
    .split(",")
    .map(Number)
    .filter(Boolean),

  // Claude (Anthropic)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-20250514",
  MAX_TOKENS: Number(process.env.MAX_TOKENS ?? "8192"),

  // Google AI
  GOOGLE_AI_API_KEY: process.env.GOOGLE_AI_API_KEY ?? "",
  GOOGLE_AI_MODEL: process.env.GOOGLE_AI_MODEL ?? "gemma-4-31b-it",

  // OpenRouter / OpenAI-compatible
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL ?? process.env.OPENAI_MODEL ?? "qwen/qwen3-235b-a22b:free",
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1",

  // Ollama
  OLLAMA_URL: process.env.OLLAMA_URL ?? "http://localhost:11434",
  OLLAMA_CHAT_MODEL: process.env.OLLAMA_CHAT_MODEL ?? "qwen3:8b",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
  VECTOR_DIMENSIONS: 768,

  // PostgreSQL
  DATABASE_URL: process.env.DATABASE_URL!,

  // Telegram transport
  TELEGRAM_TRANSPORT: (process.env.TELEGRAM_TRANSPORT ?? "polling") as "polling" | "webhook",
  TELEGRAM_WEBHOOK_URL: process.env.TELEGRAM_WEBHOOK_URL ?? "",
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
  TELEGRAM_WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH ?? "/telegram/webhook",

  // Server
  PORT: Number(process.env.PORT ?? "3847"),
  SHORT_TERM_WINDOW: Number(process.env.SHORT_TERM_WINDOW ?? "20"),
  IDLE_TIMEOUT_MS: Number(process.env.IDLE_TIMEOUT_MS ?? "900000"), // 15 min
  ARCHIVE_TTL_DAYS: Number(process.env.ARCHIVE_TTL_DAYS ?? "30") || 30,

  // Smart memory reconciliation
  MEMORY_SIMILARITY_THRESHOLD: Number(process.env.MEMORY_SIMILARITY_THRESHOLD ?? "0.35") || 0.35,
  MEMORY_RECONCILE_TOP_K: Number(process.env.MEMORY_RECONCILE_TOP_K ?? "5") || 5,

  // Per-type memory TTL (days). Set to 0 to disable TTL for a type.
  MEMORY_TTL_DAYS: {
    fact: Number(process.env.MEMORY_TTL_FACT_DAYS ?? "90") || 90,
    summary: Number(process.env.MEMORY_TTL_SUMMARY_DAYS ?? "60") || 60,
    decision: Number(process.env.MEMORY_TTL_DECISION_DAYS ?? "180") || 180,
    note: Number(process.env.MEMORY_TTL_NOTE_DAYS ?? "30") || 30,
    project_context: Number(process.env.MEMORY_TTL_PROJECT_CONTEXT_DAYS ?? "180") || 180,
  },
} as const;
