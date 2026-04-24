# PRD: Интеграция Kesha Voice Kit

## 1. Обзор

Интегрировать [kesha-voice-kit](https://github.com/drakulavich/kesha-voice-kit) в Helyx как локальный голосовой движок для ASR (распознавание речи) и TTS (синтез речи). Цель — убрать зависимость от облачных провайдеров (Groq Whisper, Yandex SpeechKit, OpenAI TTS) и сделать голосовые функции работоспособными без API-ключей сразу после установки.

## 2. Контекст

Продукт: Helyx — AI-бот для Telegram  
Модуль: `utils/transcribe.ts` (ASR), `utils/tts.ts` (TTS), `Dockerfile`, `docker-compose.yml`  
Роль пользователя: Конечный пользователь (Telegram) + DevOps (деплой)  
Стек: Bun / TypeScript, Docker, grammY, Piper (локальный TTS), Kokoro-82M (npm), kesha-engine (Rust/ONNX)

## 3. Проблема

Голосовые функции Helyx сейчас требуют внешних API-ключей:
- **ASR**: Groq Whisper (облако, лимиты) с тяжёлым Whisper Docker-контейнером как резервом
- **TTS**: Yandex SpeechKit (облако, платный), Piper (ручная установка бинарника + голосов), Kokoro-82M (npm), Groq Orpheus (облако)

При новой установке нужно завести несколько внешних аккаунтов и вручную настроить Piper + голосовые файлы. При недоступности API-ключей или превышении лимитов качество голоса деградирует незаметно.

Kesha v1.1.3 предоставляет единый бинарник (`kesha-engine-linux-x64`, 24 МБ) и npm-пакет (`@drakulavich/kesha-voice-kit`), который включает:
- Локальный ASR на ONNX (в 2.5× быстрее Whisper на CPU, 25 языков)
- Локальный TTS через Kokoro-82M (EN) + Piper VITS (RU) с авторазводкой по языку

## 4. Цели

- Голосовые функции Helyx работают без внешних API-ключей из коробки
- Заменить отдельный Whisper Docker-контейнер на kesha ASR
- Заменить ручную установку Piper + голосов на `kesha install --tts`
- Сохранить существующую цепочку фолбэков (kesha как основной/резервный, не принудительный)
- Поддержка Linux x64 (Docker) и macOS arm64 (разработка)

## 5. Что НЕ входит в скоуп

- Удаление поддержки Yandex / OpenAI / Groq TTS (они остаются как опциональные провайдеры)
- Замена LLM-нормализации текста для TTS (`normalizeForSpeech`)
- Поддержка Windows (kesha TTS ещё не готов для Windows в v1.1.3)
- Стриминговый ASR в реальном времени
- Обучение кастомных голосовых моделей

## 6. Функциональные требования

**FR-1 — Интеграция kesha ASR**  
`utils/transcribe.ts` ДОЛЖЕН вызывать `kesha <audio-file>` как subprocess, когда `GROQ_API_KEY` не задан или Groq вернул ошибку. Kesha становится основным локальным ASR, заменяя HTTP-фолбэк на `WHISPER_URL`.

**FR-2 — Интеграция kesha TTS**  
`utils/tts.ts` ДОЛЖЕН добавить функцию `synthesizeKesha(text, isRussian)`, вызывающую `kesha say "<text>" > /tmp/kesha-tts-<ts>.wav`. Вставляется в цепочку `auto`: после Yandex (RU) или как основной офлайн-провайдер при отсутствии облачных ключей.

**FR-3 — Установка kesha в Dockerfile**  
Продакшн-образ ДОЛЖЕН скачивать бинарник `kesha-engine-linux-x64`, делать его исполняемым, запускать `kesha install` (ASR-модели, ~1-2 ГБ) и опционально `kesha install --tts` (~390 МБ Kokoro + Piper RU) если build arg `KESHA_INSTALL_TTS=true`.

**FR-4 — Конфигурационные флаги**  
Добавить четыре новых опциональных env-переменных:  
- `KESHA_ENABLED` (по умолчанию `false`) — мастер-выключатель (opt-in, по умолчанию выключен)
- `KESHA_TTS_ENABLED` (по умолчанию `false`) — включить kesha TTS (Piper/Kokoro используются напрямую пока выключен)
- `KESHA_BIN` (по умолчанию `kesha-engine`) — путь к бинарнику kesha-engine
- `KESHA_BENCHMARK` (по умолчанию `false`) — benchmark-режим: прогон обоих пайплайнов параллельно с отчётом в Telegram (задержка, RTF, совпадение слов)

**FR-5 — Деградация без падения**  
Если бинарник kesha не найден или вернул ненулевой код — система ДОЛЖНА залогировать предупреждение и перейти к следующему провайдеру в цепочке без краша.

**FR-6 — Совместимость форматов аудио**  
Kesha принимает OGG/Opus (формат голосовых Telegram) нативно. Проверить и задокументировать поддерживаемые форматы; добавить ffmpeg-конвертацию только если потребуется.

## 7. Нефункциональные требования

**NFR-1 — Задержка ASR**: Kesha ASR для голосового на 30 с ДОЛЖЕН завершаться менее чем за 15 с на CPU-only Linux x64 хосте.

**NFR-2 — Размер Docker-образа**: Добавление kesha-бинарника НЕ ДОЛЖНО увеличивать сжатый размер образа более чем на 30 МБ (бинарник 24 МБ). Загрузка моделей — runtime, не build time (кроме опционального build arg).

**NFR-3 — Нет новых системных зависимостей**: Kesha — самодостаточный Rust-бинарник. TTS требует `espeak-ng`. При `KESHA_INSTALL_TTS=true` — установить в Dockerfile через `apt-get`.

**NFR-4 — Обратная совместимость**: Все существующие env-переменные (`GROQ_API_KEY`, `WHISPER_URL`, `PIPER_DIR` и др.) ДОЛЖНЫ продолжать работать без изменений. Kesha — аддитивное добавление.

**NFR-5 — Кэширование моделей**: Модели kesha ДОЛЖНЫ храниться в Docker volume или монтируемом пути, чтобы пережить перезапуск контейнера без повторной загрузки.

## 8. Ограничения

- Бинарник kesha v1.1.3 доступен только для `linux-x64` и `darwin-arm64`
- TTS требует системную зависимость `espeak-ng` (G2P)
- Kesha — CLI-инструмент, интеграция через subprocess (как существующий Piper)
- Загрузка моделей требует интернет при первом запуске (~1-2 ГБ ASR, ~390 МБ TTS)
- Лицензия: проверить лицензию kesha-voice-kit перед включением бинарника в Docker-образ
- Piper и Kokoro остаются в кодовой базе как фолбэки, не удалять

## 9. Граничные случаи

- Бинарник kesha отсутствует → тихо пропустить, залогировать, перейти к следующему провайдеру
- `kesha install` прерван → частичные модели → kesha вернёт ненулевой код → обработано через FR-5
- Аудио > 60 с → проверить, обрабатывает ли kesha длинные файлы или нужна нарезка
- Смешанный русско-английский текст в TTS → kesha авторазводит; сравнить с Piper
- Docker build с `KESHA_INSTALL_TTS=false` → espeak-ng не нужен → образ меньше
- Volume с моделями удалён → kesha перезагружает при следующем старте (ожидаемое поведение)

## 10. Критерии приёмки (Gherkin)

```gherkin
Feature: Kesha ASR как локальный фолбэк

  Scenario: Голосовое транскрибируется локально без API-ключа
    Given GROQ_API_KEY не задан
    And бинарник kesha установлен в /app/kesha/kesha-engine
    When пользователь отправляет голосовое 15 с на русском
    Then бот транскрибирует через kesha
    And транскрипция возвращена менее чем за 15 с
    And запросов к api.groq.com не было

  Scenario: Groq упал, kesha подхватил
    Given GROQ_API_KEY задан
    And Groq API вернул HTTP 429
    When пользователь отправляет голосовое
    Then система фолбэчится на kesha ASR
    And лог содержит "tts: Groq failed, falling back to kesha"

  Scenario: Бинарник kesha отсутствует
    Given бинарник kesha отсутствует
    When пришло голосовое сообщение
    Then система фолбэчится на WHISPER_URL (если задан)
    And лог содержит предупреждение, краша нет

Feature: Kesha TTS для офлайн-синтеза

  Scenario: TTS работает без Yandex-ключа
    Given YANDEX_API_KEY не задан
    And KESHA_TTS_ENABLED=true
    And модели kesha TTS установлены
    When Claude отвечает текстом 400+ символов на русском
    Then голосовое синтезируется через kesha say
    And аудио-формат WAV отправляется как Telegram voice

  Scenario: TTS_PROVIDER=auto доходит до kesha (русский)
    Given TTS_PROVIDER=auto
    And Yandex API key отсутствует
    And Piper упал или отсутствует
    And KESHA_TTS_ENABLED=true
    When TTS вызывается для русского текста
    Then вызывается kesha say как следующий фолбэк после Piper

  Scenario: TTS_PROVIDER=auto доходит до kesha (английский)
    Given TTS_PROVIDER=auto
    And Piper EN упал
    And Kokoro упал
    And KESHA_TTS_ENABLED=true
    When TTS вызывается для английского текста
    Then вызывается kesha say как фолбэк после Kokoro
```

## 11. Benchmark-режим

Задать `KESHA_BENCHMARK=true` для параллельного прогона обоих пайплайнов ASR и TTS на каждом голосовом сообщении и каждом ответе Claude.

**ASR benchmark**: прогоняет `groq→whisper` и `kesha` одновременно; для реального ответа использует результат groq→whisper. Отчёт в Telegram: задержка (мс), RTF, кол-во символов, совпадение слов (%), пример расхождений.

**TTS benchmark**: синтезирует аудио текущим пайплайном и через kesha, отправляет оба голосовых сообщения в Telegram с таблицей сравнения (задержка, размер файла, kbps).

Результаты также дописываются в `logs/kesha-benchmark.jsonl`.

> Вызовы Groq API не дублируются: `runAsrBenchmark()` запускает текущий пайплайн (Groq → Whisper) внутри себя.

## 12. Верификация

**Как тестировать:**
1. Собрать Docker образ с `KESHA_INSTALL_TTS=false` → задать `KESHA_ENABLED=true` → отправить голосовое → проверить логи `provider=kesha`
2. Убрать `GROQ_API_KEY` из `.env` → перезапустить → отправить голосовое → транскрипция работает через kesha
3. Задать `KESHA_TTS_ENABLED=true` + убрать `YANDEX_API_KEY` → длинный ответ → голосовое отправлено
4. Проверить `docker images` — прирост < 30 МБ сжатого образа
5. Удалить бинарник kesha → отправить голосовое → убедиться в graceful fallback в логах
6. Задать `KESHA_BENCHMARK=true` → отправить голосовое → убедиться что benchmark-отчёт появился в Telegram

**Где тестировать:**
- Локально: `bun run main.ts` с бинарником kesha в PATH
- Docker: `docker compose up --build` с тестовым `.env`
- Интеграционно: Telegram тест-бот (@helyx_dev)

**Наблюдаемость:**
- Все вызовы kesha логируются через `channelLogger.info/warn/error` с тегом `provider=kesha-asr` / `provider=kesha-tts`
- Статистика через существующий `recordTranscription()` с `provider: "kesha"`
- Healthcheck Docker покрывает общее здоровье; сбои kesha видны в структурированных логах
