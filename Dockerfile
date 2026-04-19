FROM oven/bun:1 AS base
WORKDIR /app

# Stage 1: Build dashboard
FROM base AS dashboard-build
COPY dashboard/package.json dashboard/bun.lock* ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile
COPY dashboard/ dashboard/
RUN cd dashboard && bun run build

# Stage 1b: Build webapp
FROM base AS webapp-build
COPY dashboard/webapp/package.json dashboard/webapp/bun.lock* ./dashboard/webapp/
RUN cd dashboard/webapp && bun install --frozen-lockfile
COPY dashboard/webapp/ dashboard/webapp/
RUN cd dashboard/webapp && bun run build

# Stage 2: Production
FROM base AS production

ARG KESHA_INSTALL_TTS=false

# Install backend dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy backend source
COPY . .

# Copy dashboard build output from stage 1
COPY --from=dashboard-build /app/dashboard/dist dashboard/dist

# Copy webapp build output from stage 1b
COPY --from=webapp-build /app/dashboard/webapp/dist dashboard/webapp/dist

# Install git for webapp git API; espeak-ng only when KESHA_INSTALL_TTS=true
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl \
      $([ "$KESHA_INSTALL_TTS" = "true" ] && echo "espeak-ng" || true) && \
    rm -rf /var/lib/apt/lists/*

# Install kesha-engine binary (linux-x64 only — darwin handled at runtime)
RUN curl -fsSL -o /usr/local/bin/kesha-engine \
      "https://github.com/drakulavich/kesha-voice-kit/releases/download/v1.1.3/kesha-engine-linux-x64" && \
    chmod +x /usr/local/bin/kesha-engine

# Pre-install kesha ASR models into the image cache dir (populated into volume on first run)
# Models are stored in /app/kesha-models (mounted as a Docker volume to survive restarts)
ENV KESHA_MODELS_DIR=/app/kesha-models
RUN mkdir -p /app/kesha-models

# Ensure downloads dir exists and is writable
RUN mkdir -p /app/downloads

# Use uid=1000 (bun) to match host user for volume read access
RUN chown -R bun /app
USER bun

EXPOSE 3847

CMD ["bun", "main.ts"]
