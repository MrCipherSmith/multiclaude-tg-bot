FROM oven/bun:1 AS base
WORKDIR /app

# Stage 1: Build dashboard
FROM base AS dashboard-build
COPY dashboard/package.json dashboard/bun.lock* ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile
COPY dashboard/ dashboard/
RUN cd dashboard && bun run build

# Stage 2: Production
FROM base AS production

# Install backend dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy backend source
COPY . .

# Copy dashboard build output from stage 1
COPY --from=dashboard-build /app/dashboard/dist dashboard/dist

# Ensure downloads dir exists and is writable
RUN mkdir -p /app/downloads

# Non-root user
RUN useradd --no-create-home --shell /bin/false app && chown -R app /app
USER app

EXPOSE 3847

CMD ["bun", "main.ts"]
