FROM oven/bun:1 AS base
WORKDIR /app

# Install backend dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Build dashboard
COPY dashboard/package.json dashboard/bun.lock* dashboard/
RUN cd dashboard && bun install --frozen-lockfile

COPY dashboard/ dashboard/
RUN cd dashboard && bun run build

# Copy backend source
COPY . .

EXPOSE 3847

CMD ["bun", "main.ts"]
