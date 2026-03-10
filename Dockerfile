FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Data volume
ENV COBRAIN_BASE_PATH=/data
VOLUME /data

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
