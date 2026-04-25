import type { MessageParam, ContentBlock, StreamContext } from "../claude/client.ts";

export type ProviderType =
  | "anthropic"
  | "openai"
  | "google-ai"
  | "ollama"
  | "custom-openai";

/** Resolved provider configuration — output of profile-resolver. */
export interface ResolvedProvider {
  providerType: ProviderType;
  model: string;
  apiKey?: string;       // empty/undefined for ollama
  baseUrl?: string;      // null for native Anthropic SDK
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  /** Free-form metadata from model_profiles.metadata + model_providers.metadata, merged. */
  metadata?: Record<string, unknown>;
}

/** Input to LlmClient.generate / stream. Mirrors the existing claude/client.ts shape. */
export interface LlmGenerateInput {
  messages: MessageParam[];
  /** Optional override — when undefined, resolver picks profile from session/env. */
  modelProfileId?: number;
  /** Optional override — wins over profile.model. */
  modelOverride?: string;
}

export interface LlmGenerateResult {
  text: string;
  /** Echo back which provider/model actually served the request (for stats and audit). */
  providerType: ProviderType;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** High-level interface — Phase 3 introduces this; current code uses concrete functions. */
export interface LlmClient {
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>;
  stream(input: LlmGenerateInput, ctx: StreamContext): Promise<void>;
}

// Re-export upstream types so callers don't need a second import path
export type { MessageParam, ContentBlock, StreamContext };
