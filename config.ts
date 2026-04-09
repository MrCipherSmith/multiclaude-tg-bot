import { z } from "zod";

const EnvSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  ALLOWED_USERS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map(Number).filter(Boolean)),

  // Claude (Anthropic)
  ANTHROPIC_API_KEY: z.string().default(""),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  MAX_TOKENS: z.coerce.number().int().positive().default(8192),

  // Google AI
  GOOGLE_AI_API_KEY: z.string().default(""),
  GOOGLE_AI_MODEL: z.string().default("gemma-4-31b-it"),

  // OpenRouter / OpenAI-compatible
  OPENROUTER_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENROUTER_MODEL: z.string().default(""),
  OPENAI_MODEL: z.string().default(""),
  OPENROUTER_BASE_URL: z.string().default(""),
  OPENAI_BASE_URL: z.string().default(""),

  // Ollama
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  OLLAMA_CHAT_MODEL: z.string().default("qwen3:8b"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),

  // PostgreSQL
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Telegram transport
  TELEGRAM_TRANSPORT: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_WEBHOOK_URL: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  TELEGRAM_WEBHOOK_PATH: z.string().default("/telegram/webhook"),

  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(3847),
  SHORT_TERM_WINDOW: z.coerce.number().int().positive().default(20),
  IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  ARCHIVE_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Smart memory reconciliation
  MEMORY_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  MEMORY_RECONCILE_TOP_K: z.coerce.number().int().positive().default(5),

  // Per-type memory TTL (days). Set to 0 to disable TTL for a type.
  MEMORY_TTL_FACT_DAYS: z.coerce.number().int().min(0).default(90),
  MEMORY_TTL_SUMMARY_DAYS: z.coerce.number().int().min(0).default(60),
  MEMORY_TTL_DECISION_DAYS: z.coerce.number().int().min(0).default(180),
  MEMORY_TTL_NOTE_DAYS: z.coerce.number().int().min(0).default(30),
  MEMORY_TTL_PROJECT_CONTEXT_DAYS: z.coerce.number().int().min(0).default(180),

  // Voice transcription
  GROQ_API_KEY: z.string().default(""),
  WHISPER_URL: z.string().default("http://localhost:9000"),

  // Security / paths
  JWT_SECRET: z.string().optional(),
  SECURE_COOKIES: z.string().optional(),
  DOWNLOADS_DIR: z.string().default("/app/downloads"),
  HOST_DOWNLOADS_DIR: z.string().optional(),
  HOST_CLAUDE_CONFIG: z.string().default("/host-claude-config"),
  HOST_PROJECTS_DIR: z.string().optional(),
  KNOWLEDGE_BASE: z.string().optional(),
  KNOWLEDGE_BASE_PATH: z.string().optional(),

  // Access control (for security-defaults PRD)
  ALLOW_ALL_USERS: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
});

const result = EnvSchema.safeParse(process.env);
if (!result.success) {
  console.error("[config] Invalid environment configuration:");
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = result.data;

export const CONFIG = {
  // Telegram
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
  ALLOWED_USERS: env.ALLOWED_USERS,

  // Claude (Anthropic)
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  CLAUDE_MODEL: env.CLAUDE_MODEL,
  MAX_TOKENS: env.MAX_TOKENS,

  // Google AI
  GOOGLE_AI_API_KEY: env.GOOGLE_AI_API_KEY,
  GOOGLE_AI_MODEL: env.GOOGLE_AI_MODEL,

  // OpenRouter / OpenAI-compatible (preserve alias behavior)
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || env.OPENAI_API_KEY,
  OPENROUTER_MODEL: env.OPENROUTER_MODEL || env.OPENAI_MODEL || "qwen/qwen3-235b-a22b:free",
  OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL || env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",

  // Ollama
  OLLAMA_URL: env.OLLAMA_URL,
  OLLAMA_CHAT_MODEL: env.OLLAMA_CHAT_MODEL,
  EMBEDDING_MODEL: env.EMBEDDING_MODEL,
  VECTOR_DIMENSIONS: 768 as const,

  // PostgreSQL
  DATABASE_URL: env.DATABASE_URL,

  // Telegram transport
  TELEGRAM_TRANSPORT: env.TELEGRAM_TRANSPORT,
  TELEGRAM_WEBHOOK_URL: env.TELEGRAM_WEBHOOK_URL,
  TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_WEBHOOK_PATH: env.TELEGRAM_WEBHOOK_PATH,

  // Server
  PORT: env.PORT,
  SHORT_TERM_WINDOW: env.SHORT_TERM_WINDOW,
  IDLE_TIMEOUT_MS: env.IDLE_TIMEOUT_MS,
  ARCHIVE_TTL_DAYS: env.ARCHIVE_TTL_DAYS,

  // Smart memory reconciliation
  MEMORY_SIMILARITY_THRESHOLD: env.MEMORY_SIMILARITY_THRESHOLD,
  MEMORY_RECONCILE_TOP_K: env.MEMORY_RECONCILE_TOP_K,

  // Per-type memory TTL
  MEMORY_TTL_DAYS: {
    fact: env.MEMORY_TTL_FACT_DAYS,
    summary: env.MEMORY_TTL_SUMMARY_DAYS,
    decision: env.MEMORY_TTL_DECISION_DAYS,
    note: env.MEMORY_TTL_NOTE_DAYS,
    project_context: env.MEMORY_TTL_PROJECT_CONTEXT_DAYS,
  },

  // Voice transcription
  GROQ_API_KEY: env.GROQ_API_KEY,
  WHISPER_URL: env.WHISPER_URL,

  // Security / paths
  JWT_SECRET: env.JWT_SECRET,
  SECURE_COOKIES: env.SECURE_COOKIES,
  DOWNLOADS_DIR: env.DOWNLOADS_DIR,
  HOST_DOWNLOADS_DIR: env.HOST_DOWNLOADS_DIR,
  HOST_CLAUDE_CONFIG: env.HOST_CLAUDE_CONFIG,
  HOST_PROJECTS_DIR: env.HOST_PROJECTS_DIR,
  KNOWLEDGE_BASE: env.KNOWLEDGE_BASE,
  KNOWLEDGE_BASE_PATH: env.KNOWLEDGE_BASE_PATH,

  // Access control
  ALLOW_ALL_USERS: env.ALLOW_ALL_USERS,
} as const;

export type Config = typeof CONFIG;
