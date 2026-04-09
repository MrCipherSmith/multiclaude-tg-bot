# PRD: Google AI Provider in Setup Wizard

## Overview

Re-add Google AI (Gemma 4) as an interactive option in the `claude-bot setup` wizard (`cli.ts`), so the wizard's provider list matches the README and all four supported LLM providers are accessible without manual `.env` editing.

## Problem Statement

The README documents four supported LLM providers in the interactive wizard (Anthropic / Google AI / OpenRouter / Ollama). The actual wizard in `cli.ts` only presents three choices — Google AI is missing. It was removed from the wizard at some point but remains fully implemented in `claude/client.ts` and documented in `.env.example`. Users who follow the README expect to choose Google AI interactively but cannot.

## Goals

- Restore Google AI as option 2 in the wizard's provider choice list
- Collect `GOOGLE_AI_API_KEY` and optionally `GOOGLE_AI_MODEL` (default: `gemma-4-31b-it`) when selected
- Write collected values into the generated `.env` file
- Keep all other wizard steps unchanged

## Non-Goals

- Changing the Google AI backend in `claude/client.ts`
- API-key validation or model-browsing during setup
- Modifying any other CLI command besides `setup`

## Functional Requirements

**FR-1:** The provider selection prompt MUST offer four options in order:
1. Anthropic (best quality, requires API key)
2. Google AI (Gemma 4 models, free tier available)
3. OpenRouter (many models, free & paid)
4. Ollama (local, free)

**FR-2:** When Google AI is selected, the wizard MUST prompt for `GOOGLE_AI_API_KEY` (required) and `GOOGLE_AI_MODEL` (optional, default `gemma-4-31b-it`).

**FR-3:** The generated `.env` MUST include both vars in the `# LLM Provider` section when Google AI is selected.

**FR-4:** Existing provider flows MUST NOT change in behavior. `providerIdx` mapping updated: 0→Anthropic, 1→Google AI, 2→OpenRouter, 3→Ollama.

## Implementation Notes

Only `cli.ts` requires changes (~lines 111–130, provider selection block). `claude/client.ts`, `.env.example`, `config.ts`, and `README.md` already handle Google AI correctly.

## Acceptance Criteria

```gherkin
Scenario: Wizard displays four provider options
  Given I run "claude-bot setup"
  When I reach the "LLM Provider" prompt
  Then I see exactly four options including "Google AI (Gemma 4 models, free tier available)"

Scenario: Selecting Google AI collects API key and model
  When I select option 2 (Google AI)
  Then the wizard prompts "Google AI API Key"
  And the wizard prompts "Google AI Model" with default "gemma-4-31b-it"

Scenario: Generated .env contains Google AI variables
  Given I selected Google AI and entered a key
  When the wizard finishes
  Then .env contains "GOOGLE_AI_API_KEY=..." and "GOOGLE_AI_MODEL=gemma-4-31b-it"

Scenario: Existing provider flows are unaffected
  Given I select any other provider
  Then its flow is unchanged
```
