FROM node:22 AS base

RUN corepack enable
WORKDIR /app

# Copy package files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/anki-generator/package.json ./artifacts/anki-generator/
COPY lib/db/package.json ./lib/db/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/integrations-openai-ai-server/package.json ./lib/integrations-openai-ai-server/
COPY lib/api-client-react/package.json ./lib/api-client-react/

# Install ALL dependencies
RUN pnpm install

# Copy source code (respecting .dockerignore)
COPY . .

# Build the app (filtering to only what we need)
RUN pnpm --filter "...@workspace/api-server" --filter "...@workspace/anki-generator" run build

# Final Production Stage
FROM node:22-slim
WORKDIR /app
RUN corepack enable

# Copy everything from build stage
COPY --from=base /app /app

EXPOSE 3000
ENV NODE_ENV=production

# Start the server
WORKDIR /app/artifacts/api-server
CMD ["node", "dist/index.mjs"]
