# PRD (AI-readable): Kesha Voice Kit Integration

## METADATA
```json
{
  "feature": "kesha-voice-kit-integration",
  "version": "1.0.0",
  "date": "2026-04-19",
  "status": "implemented",
  "priority": "high",
  "type": "integration",
  "branch": "feat/kesha-voice-kit",
  "affects": ["utils/transcribe.ts", "utils/tts.ts", "utils/benchmark.ts", "Dockerfile", "docker-compose.yml", "config.ts", "bot/media.ts", "channel/tools.ts", "bot/commands/projects.ts"]
}
```

## PROBLEM
```
CURRENT_ASR_CHAIN:
  1. Groq Whisper cloud (GROQ_API_KEY required) → HTTP POST api.groq.com
  2. Local Whisper HTTP server (WHISPER_URL required) → separate Docker container

CURRENT_TTS_CHAIN (auto, Russian):
  1. Yandex SpeechKit (YANDEX_API_KEY + YANDEX_FOLDER_ID required) → cloud
  2. Piper local binary (manual install: binary + onnx voice files in PIPER_DIR)
  3. Groq Orpheus (GROQ_API_KEY required, English only) → cloud

CURRENT_TTS_CHAIN (auto, English):
  1. Piper local binary (English model)
  2. Kokoro-82M (npm package, loads ONNX model in-process)
  3. Groq Orpheus → cloud

PAIN_POINTS:
  - Fresh install requires 3+ external accounts
  - Piper requires manual binary + voice file download
  - Voice fails silently if all keys unavailable
  - Separate Whisper Docker container adds 2-3 GB to deployment
```

## SOLUTION
```
KESHA_VOICE_KIT:
  package: "@drakulavich/kesha-voice-kit"
  version: "1.1.3"
  binary:
    linux-x64: "kesha-engine-linux-x64" (24 MB)
    darwin-arm64: "kesha-engine-darwin-arm64" (21 MB)
  
  ASR:
    engine: ONNX Runtime (FluidAudio on Apple Silicon, ort on CPU)
    languages: 25
    speed_vs_whisper_large_v3_turbo: "~2.5x faster on CPU"
    input_formats: ["ogg", "opus", "wav", "mp3", "flac"]
    interface: "kesha <audio-file>"
    output: plain text to stdout
    model_size: ~1-2 GB (downloaded via `kesha install`)
  
  TTS:
    engines:
      english: "Kokoro-82M ONNX" (326 MB)
      russian: "Piper VITS ru-denis" (63 MB)
    auto_routing: language detected from text
    interface: "kesha say '<text>' > out.wav"
    output_format: WAV (mono f32, 24kHz Kokoro / 22.05kHz Piper)
    system_dep: espeak-ng (G2P)
    model_install: "kesha install --tts" (~390 MB)
```

## REQUIREMENTS

### FR-1: ASR subprocess integration
```
FILE: utils/transcribe.ts
ACTION: add function transcribeKesha(audioBuffer, fileName)
  - write buffer to /tmp/kesha-asr-<ts>-<safeName>
  - spawn: [KESHA_BIN, "transcribe", tmpFile]
  - capture stdout as transcription text
  - cleanup tmp file
  - return string | null

FALLBACK_POSITION: after Groq, before WHISPER_URL
TRIGGER: GROQ_API_KEY absent OR Groq returns non-2xx
ERROR_HANDLING: non-zero exit → log warn → return null (continue chain)
LOG_TAG: provider="kesha-asr"
STATS: recordTranscription({ provider: "kesha", ... })
```

### FR-2: TTS subprocess integration
```
FILE: utils/tts.ts
ACTION: add function synthesizeKesha(text, isRussian): Promise<Buffer | null>
  - construct: [KESHA_BIN, "say", "--voice", voice, "--out", tmpFile, text.slice(0, 5000)]
    where voice = isRussian ? "ru-denis" : "en-af_heart"
  - read WAV from tmpFile → Buffer
  - cleanup tmp in finally
  - return Buffer | null

FALLBACK_POSITION_RU: after Yandex → Piper, before Groq (last offline)
FALLBACK_POSITION_EN: after Piper → Kokoro, before Groq (last offline)
GUARD: KESHA_TTS_ENABLED must be true AND KESHA_ENABLED must be true
LOG_TAG: provider="kesha-tts"
```

### FR-3: Dockerfile changes
```
STAGE: production
ADD:
  ARG KESHA_INSTALL_TTS=false
  
  # Download binary
  RUN arch=$(uname -m) && \
      if [ "$arch" = "aarch64" ]; then PLATFORM="darwin-arm64"; else PLATFORM="linux-x64"; fi && \
      curl -fsSL -o /usr/local/bin/kesha-engine \
        "https://github.com/drakulavich/kesha-voice-kit/releases/download/v1.1.3/kesha-engine-${PLATFORM}" && \
      chmod +x /usr/local/bin/kesha-engine
  
  # ASR models (~1-2 GB, cached in volume)
  RUN kesha-engine install || true
  
  # TTS models (optional, ~390 MB)
  RUN if [ "$KESHA_INSTALL_TTS" = "true" ]; then \
        apt-get update && apt-get install -y --no-install-recommends espeak-ng && \
        rm -rf /var/lib/apt/lists/* && \
        kesha-engine install --tts; \
      fi

VOLUME: add /app/kesha-models to docker-compose.yml volumes for model persistence
```

### FR-4: Config vars
```
FILE: config.ts
ADD:
  KESHA_ENABLED: boolean (default: false, read from process.env.KESHA_ENABLED === "true")
  KESHA_TTS_ENABLED: boolean (default: false, read from process.env.KESHA_TTS_ENABLED === "true")
  KESHA_BIN: string (default: "kesha-engine")
  KESHA_BENCHMARK: boolean (default: false) — benchmark mode (see FR-7)
  LOGS_DIR: string (default: "logs") — directory for benchmark JSONL log
```

### FR-7: Benchmark mode
```
FILE: utils/benchmark.ts (new)
TRIGGER: KESHA_BENCHMARK=true

ASR_BENCHMARK (bot/media.ts handleVoice):
  - call runAsrBenchmark(audioBuffer, fileName, mimeType) once
    → runs groq→whisper and kesha in parallel via Promise.all
    → uses groq→whisper result as actual transcription text
    → no duplicate API calls
  - append result to logs/kesha-benchmark.jsonl
  - fire-and-forget: sendAsrBenchReport to same Telegram thread

TTS_BENCHMARK (channel/tools.ts reply tool):
  - call runTtsBenchmarkAndReport(token, chatId, text, threadId, forceVoice)
    → runs current pipeline and kesha in parallel
    → sends both voice messages to Telegram with 4s gap
    → sends comparison stats message
    → appends to logs/kesha-benchmark.jsonl

REPORT_FORMAT (Telegram HTML):
  ASR: provider, latencyMs, RTF, char/s, charCount, heapDeltaMB
       word similarity %, sample word diffs
  TTS: provider, latencyMs, fileSizeKB, fmt, kbps, heapDeltaMB
```

### FR-5: Graceful degradation
```
PATTERN: same as existing Piper integration
  try {
    const buf = await synthesizeKesha(text, isRussian);
    if (buf) return { buf, fmt: "wav" };
  } catch (err) {
    channelLogger.warn({ err }, "tts: kesha failed, continuing chain");
  }
```

### FR-6: Audio format
```
VERIFY: does `kesha <file.ogg>` accept Telegram OGG/Opus natively?
  IF YES: no conversion needed
  IF NO: add ffmpeg step to convert OGG → WAV before passing to kesha
NOTE: check kesha README for supported formats list
```

## ACCEPTANCE_CRITERIA
```gherkin
Feature: Kesha ASR integration

  Scenario: ASR offline without GROQ_API_KEY
    Given env GROQ_API_KEY is unset
    And KESHA_ENABLED=true
    And kesha binary exists at KESHA_BIN path
    When handleVoice receives a 15-second OGG audio buffer
    Then transcribeKesha is called with the audio
    And the function returns a non-empty string
    And no HTTP request is sent to api.groq.com
    And recordTranscription is called with provider="kesha"

  Scenario: Groq 429 triggers kesha fallback
    Given GROQ_API_KEY is set
    And Groq API responds with status 429
    When transcribe() is called
    Then transcribeKesha is attempted next
    And logs contain provider="kesha-asr"

  Scenario: kesha binary missing → graceful skip
    Given KESHA_BIN points to a non-existent path
    When transcribe() is called
    Then transcribeKesha returns null
    And the chain continues to WHISPER_URL
    And no unhandled exception is thrown

Feature: Kesha TTS integration

  Scenario: TTS_PROVIDER=auto, no Yandex key, kesha TTS enabled
    Given TTS_PROVIDER=auto
    And YANDEX_API_KEY is unset
    And KESHA_TTS_ENABLED=true
    And kesha TTS models are installed
    When synthesize() is called with 400-char Russian text
    Then synthesizeKesha is called with isRussian=true
    And returned buffer is non-empty WAV
    And sendVoice is called with audio/wav MIME type

  Scenario: KESHA_TTS_ENABLED=false skips kesha TTS
    Given KESHA_TTS_ENABLED=false (default)
    When synthesize() runs auto chain
    Then synthesizeKesha is never called
    And existing Piper/Kokoro logic unchanged

Feature: Docker build

  Scenario: Default build (TTS disabled)
    Given docker build args: KESHA_INSTALL_TTS=false
    When docker build completes
    Then kesha-engine binary exists at /usr/local/bin/kesha-engine
    And espeak-ng is NOT installed
    And `kesha-engine install` completed (ASR models in volume)

  Scenario: TTS build
    Given docker build args: KESHA_INSTALL_TTS=true
    When docker build completes
    Then espeak-ng IS installed
    And `kesha-engine install --tts` completed
    And Kokoro + Piper RU voice files present in volume
```

## IMPLEMENTATION_ORDER
```
1. config.ts — add KESHA_ENABLED, KESHA_TTS_ENABLED, KESHA_BIN, KESHA_BENCHMARK, LOGS_DIR
2. utils/transcribe.ts — add transcribeKesha(), insert into fallback chain (Groq → Kesha → Whisper)
3. utils/tts.ts — add synthesizeKesha(), detectRussian(), synthesizeCurrentOnly()
                   insert kesha as last offline fallback in both RU and EN chains
4. utils/benchmark.ts — new file: runAsrBenchmark, runTtsBenchmark, formatBenchmarkReport,
                         appendBenchmarkLog, sendTelegramVoice
5. bot/media.ts — benchmark in handleVoice; fix ctx.reply() → replyInThread()
6. channel/tools.ts — benchmark in reply tool
7. bot/commands/projects.ts — Start All button; fix ctx.reply() → replyInThread()
8. Dockerfile — binary download + espeak-ng + kesha install (ASR + optional TTS)
9. docker-compose.yml — KESHA_BIN + HOME env vars
10. .env.example — document new vars
```

## RISKS
```
- kesha model download in Dockerfile makes build slow (1-2 GB); mitigate with volume mount
- espeak-ng system dep may conflict with existing apt packages; test in clean build
- kesha CLI interface may change in future versions; pin to v1.1.3 binary URL
- OGG/Opus support in kesha not confirmed; may need ffmpeg conversion step
- License of kesha-engine binary must be verified before distribution in Docker image
```
