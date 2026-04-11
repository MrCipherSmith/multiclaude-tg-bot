# Voice Conversations with Claude

One of the most distinctive features of Helyx: you can have a **full voice conversation with Claude** directly in Telegram — send a voice message, get a voice reply back.

---

## How it works

### Sending voice to Claude

Record a voice message in Telegram and send it to your session topic. The bot:

1. Transcribes it using **Groq Whisper** (~200ms, free) or local Whisper fallback
2. Forwards the text to Claude CLI as your message
3. Shows a "recording voice..." indicator while Claude's reply is being synthesized

No typing needed. Just talk.

### Getting voice replies

Claude automatically sends a voice message back alongside the text reply in two cases:

| Condition | Behavior |
|---|---|
| You sent a voice message | Claude **always** replies with voice, regardless of reply length |
| Reply is ≥300 chars and not mostly code/diffs | Voice is attached automatically |

This means: if you're having a conversation via voice, Claude matches your mode and speaks back. If you send a text message, short replies stay text-only; longer explanations get a voice attachment.

### Smart filtering — no voice for code

Claude skips voice if the reply is mostly code or a diff:
- Fenced code blocks > 40% of reply length → no voice
- 6+ diff lines (`+added`, `-removed`) → no voice

This avoids Claude reading out walls of TypeScript or git diffs.

### LLM normalization before speech

Before synthesizing, Claude runs a fast LLM pass (~250ms via Groq llama-3.1-8b-instant) to make the text sound natural when spoken:

- `channel/session.ts` → "session dot ts"
- `lease_expires_at` → "lease expires at"
- `acquireLease()` → "acquire lease"
- Git hashes → omitted or "the commit"
- URLs → omitted or "по ссылке"
- Same language as input (Russian stays Russian)

---

## Voice providers

### Transcription (speech → text)

| Provider | Config | Notes |
|---|---|---|
| **Groq Whisper** | `GROQ_API_KEY` | Primary; ~200ms, free tier at [console.groq.com](https://console.groq.com) |
| **Local Whisper** | auto-detected | Fallback; slower, runs on device |

### Synthesis (text → speech)

| Provider | Config | Notes |
|---|---|---|
| **Yandex SpeechKit** | `YANDEX_API_KEY` + `YANDEX_FOLDER_ID` | Primary; best Russian quality, multilingual |
| **Groq Orpheus** | `GROQ_API_KEY` | Fallback; English-only; free tier |
| **OpenAI TTS** | `OPENAI_API_KEY` | Alternative; not wired by default |

Yandex SpeechKit requires a service account with `ai.speechkit.tts` IAM role. See [Yandex Cloud docs](https://cloud.yandex.ru/docs/speechkit/) for setup.

---

## Setup

Add to your `.env`:

```env
# Transcription + TTS normalization (free)
GROQ_API_KEY=gsk_...

# Voice synthesis — Russian-first (best quality)
YANDEX_API_KEY=AQVN...
YANDEX_FOLDER_ID=b1g...
```

Both keys are optional — the bot degrades gracefully:
- No `GROQ_API_KEY` → transcription falls back to local Whisper; normalization skipped
- No Yandex keys → synthesis falls back to Groq Orpheus (English only)
- No synthesis keys at all → voice replies disabled, text-only

---

## Example flow

```
You:    🎤 "Объясни что делает функция resolveSession"
                    ↓ Groq Whisper (~200ms)
Claude: [thinking... reading files...]
Claude: 📝 "resolveSession отвечает за..." (long explanation)
Claude: 🎤 [voice message, synthesized via Yandex SpeechKit]
```

The voice message appears immediately after the text reply, synthesized in parallel.

---

## Troubleshooting

**Voice sent but no voice reply:**
- Check `YANDEX_API_KEY` / `YANDEX_FOLDER_ID` — Yandex errors appear in bot logs
- The reply might be too short (<300 chars) or mostly code — this is by design
- Groq Orpheus has a 3600 token/day free limit; check if exhausted

**Transcription fails / wrong language:**
- Whisper auto-detects language; works best with clear audio
- For Russian, Groq Whisper handles it well natively

**Voice reply is in wrong Telegram topic:**
- This was a bug fixed in `channel/tools.ts` (April 2026) — update to latest
