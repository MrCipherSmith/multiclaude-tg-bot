# PRD: Kesha Voice Kit Integration

## 1. Overview

Integrate [kesha-voice-kit](https://github.com/drakulavich/kesha-voice-kit) into Helyx as a local-first voice engine for both ASR (speech-to-text) and TTS (text-to-speech), replacing cloud dependencies on Groq Whisper, Yandex SpeechKit, and OpenAI TTS. The goal is a zero-API-key voice stack that works out of the box after a single `kesha install` step.

## 2. Context

Product: Helyx — AI-powered Telegram bot  
Module: `utils/transcribe.ts` (ASR), `utils/tts.ts` (TTS), `Dockerfile`, `docker-compose.yml`  
User Role: End-user (Telegram) + DevOps (deployment)  
Tech Stack: Bun / TypeScript, Docker, grammY, Piper (local TTS), Kokoro-82M (npm), kesha-engine binary (Rust/ONNX)

## 3. Problem Statement

Helyx voice features currently require external API keys:
- **ASR**: Groq Whisper (cloud, rate-limited) with a heavy separate Whisper Docker container as fallback
- **TTS**: Yandex SpeechKit (cloud, paid), Piper binary + voice files (manual install), Kokoro-82M (npm), Groq Orpheus (cloud)

New deployments must set up multiple external accounts and manually install Piper + voice files. If API keys are unavailable or rate-limited, voice quality degrades silently.

Kesha v1.1.3 provides a single binary (`kesha-engine-linux-x64`, 24 MB) and an npm package (`@drakulavich/kesha-voice-kit`) that bundle:
- Local ONNX-based ASR (2.5× faster than Whisper on CPU, 25 languages)
- Local TTS via Kokoro-82M (EN) + Piper VITS (RU), auto-routed by language

## 4. Goals

- Make Helyx voice work with zero external API keys out of the box
- Replace the separate Whisper Docker container with kesha ASR
- Replace manual Piper binary + voices setup with `kesha install --tts`
- Keep existing provider fallback chain intact (kesha as primary/fallback, not forced override)
- Support Linux x64 (Docker) and macOS arm64 (dev)

## 5. Non-Goals

- Removing Yandex / OpenAI / Groq TTS support (they remain as optional higher-quality providers)
- Replacing the LLM normalization step for TTS (`normalizeForSpeech`)
- Supporting Windows (kesha TTS not available on Windows yet per v1.1.3 release)
- Real-time streaming ASR
- Custom voice model training

## 6. Functional Requirements

**FR-1 — Kesha ASR integration**  
`utils/transcribe.ts` MUST call `kesha <audio-file>` as a subprocess when `GROQ_API_KEY` is absent or Groq returns an error. Kesha becomes the primary local ASR provider, replacing the `WHISPER_URL` HTTP fallback.

**FR-2 — Kesha TTS integration**  
`utils/tts.ts` MUST add a `synthesizeKesha(text, isRussian)` function that calls `kesha say "<text>" > /tmp/kesha-tts-<ts>.wav`. It is inserted into the `auto` fallback chain: after Yandex (RU) or as primary offline provider when no cloud keys are set.

**FR-3 — Dockerfile kesha install**  
The production Docker image MUST download the `kesha-engine-linux-x64` binary, make it executable, run `kesha install` (ASR models, ~1-2 GB), and optionally `kesha install --tts` (~390 MB Kokoro + Piper RU) if `KESHA_INSTALL_TTS=true` build arg is set.

**FR-4 — Config flags**  
Add two new optional env vars:  
- `KESHA_ENABLED` (default `true`) — master switch for all kesha integration  
- `KESHA_TTS_ENABLED` (default `false`) — enable kesha TTS (off by default, Piper/Kokoro still used directly)

**FR-5 — Graceful degradation**  
If kesha binary is not found or exits non-zero, the system MUST log a warning and continue to the next provider in the fallback chain without crashing.

**FR-6 — Audio format compatibility**  
Kesha accepts OGG/OPus (Telegram voice format) natively. Verify and document supported input formats; add ffmpeg conversion step only if required.

## 7. Non-Functional Requirements

**NFR-1 — ASR latency**: Kesha ASR for a 30 s voice message MUST complete in under 15 s on a CPU-only Linux x64 host (2.5× faster than Whisper large-v3-turbo).

**NFR-2 — Docker image size delta**: Adding kesha binary to the image MUST NOT increase the compressed image size by more than 30 MB (binary is 24 MB). Model downloads happen at runtime, not build time (except via optional build arg).

**NFR-3 — No new system dependencies**: Kesha is a self-contained Rust binary. TTS requires `espeak-ng` (system dep). If `KESHA_INSTALL_TTS=true`, `espeak-ng` MUST be installed in Dockerfile via `apt-get`.

**NFR-4 — Backward compatibility**: All existing env vars (`GROQ_API_KEY`, `WHISPER_URL`, `PIPER_DIR`, etc.) MUST continue to work unchanged. Kesha is additive, not a breaking replacement.

**NFR-5 — Model caching**: Kesha models MUST be stored in a Docker volume or host-mounted path to survive container restarts without re-downloading.

## 8. Constraints

- Kesha v1.1.3 binary is available for `linux-x64` and `darwin-arm64` only
- TTS on kesha requires `espeak-ng` system dependency (G2P)
- Kesha is a CLI tool — integration requires subprocess spawning (similar to existing Piper integration)
- Model download requires internet access at first run (~1-2 GB ASR, ~390 MB TTS)
- License: check kesha-voice-kit license before bundling binary in Docker image
- Piper and Kokoro remain in the codebase as fallbacks; do not remove them

## 9. Edge Cases

- Kesha binary not present → skip silently, log warn, fall through to next provider
- `kesha install` fails mid-download → partial models → kesha exits non-zero → caught by FR-5
- Audio file > 60 s → test whether kesha handles long files or needs chunking
- Mixed Russian/English text in TTS → kesha auto-routes; verify correctness vs current Piper
- Docker build with `KESHA_INSTALL_TTS=false` → no espeak-ng needed → smaller image
- Model volume deleted → kesha re-downloads on next start (expected behavior)

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Kesha ASR as local fallback

  Scenario: Voice message transcribed locally without API key
    Given GROQ_API_KEY is not set
    And kesha binary is installed at /app/kesha/kesha-engine
    When a user sends a 15-second voice message in Russian
    Then the bot transcribes it using kesha
    And the transcription is returned in under 15 seconds
    And no HTTP request is made to api.groq.com

  Scenario: Groq fails, kesha picks up
    Given GROQ_API_KEY is set
    And the Groq API returns HTTP 429
    When a user sends a voice message
    Then the system falls back to kesha ASR
    And logs "tts: Groq failed, falling back to kesha"

  Scenario: Kesha binary missing
    Given kesha binary is absent
    When a voice message arrives
    Then the system falls back to WHISPER_URL (if set)
    And logs a warning but does not crash

Feature: Kesha TTS for offline synthesis

  Scenario: TTS works without Yandex key
    Given YANDEX_API_KEY is not set
    And KESHA_TTS_ENABLED=true
    And kesha TTS models are installed
    When Claude replies with 400+ character Russian text
    Then a voice message is synthesized via kesha say
    And audio format is WAV sent as Telegram voice

  Scenario: TTS_PROVIDER=auto falls through to kesha
    Given TTS_PROVIDER=auto
    And Yandex API key is missing
    And Piper binary is absent
    When TTS is triggered for Russian text
    Then kesha say is called as the next fallback

Feature: Docker installation

  Scenario: Build with TTS disabled
    Given KESHA_INSTALL_TTS is not set (default false)
    When docker compose build runs
    Then kesha ASR models are downloaded
    And espeak-ng is NOT installed
    And image size increase is under 30 MB compressed

  Scenario: Build with TTS enabled
    Given KESHA_INSTALL_TTS=true
    When docker compose build runs
    Then kesha TTS models (Kokoro + Piper RU) are downloaded
    And espeak-ng IS installed
```

## 11. Verification

**How to test:**
1. Build Docker image with `KESHA_INSTALL_TTS=false` → send voice message → check logs for `kesha ASR ok`
2. Unset `GROQ_API_KEY` in `.env` → restart → send voice → verify transcription still works
3. Set `KESHA_TTS_ENABLED=true` + unset `YANDEX_API_KEY` → trigger long reply → verify voice message sent
4. Check `docker images` for size delta < 30 MB compressed
5. Deliberately delete kesha binary → send voice → verify graceful fallback in logs

**Where to test:**
- Local: `bun run main.ts` with kesha binary in PATH
- Docker: `docker compose up --build` with test `.env`
- Integration: Telegram test bot (@helyx_dev)

**Observability:**
- All kesha calls log via `channelLogger.info/warn/error` with provider tag `provider=kesha-asr` / `provider=kesha-tts`
- Stats recorded via existing `recordTranscription()` with `provider: "kesha"` 
- Docker healthcheck covers overall bot health; kesha failures visible in structured logs
