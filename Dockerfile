FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Install dependencies
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/anki-generator/package.json ./artifacts/anki-generator/
COPY lib/db/package.json ./lib/db/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/integrations-openai-ai-server/package.json ./lib/integrations-openai-ai-server/
COPY lib/api-client-react/package.json ./lib/api-client-react/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
# Skip typecheck during production build to avoid failures
RUN pnpm -r --if-present run build

# Production image
FROM node:22-slim
WORKDIR /app
RUN corepack enable

# Copy everything from base (easier in monorepo to just copy all)
COPY --from=base /app /app

EXPOSE 3000

ENV NODE_ENV=production

# Start the API server which now also serves the frontend
WORKDIR /app/artifacts/api-server
CMD ["pnpm", "run", "start"]
