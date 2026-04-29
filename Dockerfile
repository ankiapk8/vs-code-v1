FROM node:22-alpine AS builder
WORKDIR /app
# Install pnpm
RUN npm i -g pnpm@9
# Copy package definitions
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/anki-generator/package.json ./artifacts/anki-generator/
COPY lib/db/package.json ./lib/db/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/integrations-openai-ai-server/package.json ./lib/integrations-openai-ai-server/
COPY lib/api-client-react/package.json ./lib/api-client-react/
# Install dependencies
RUN pnpm install --frozen-lockfile
# Copy source files
COPY . .
# Build frontend and backend
RUN pnpm --filter "@workspace/api-server" run build && pnpm --filter "@workspace/anki-generator" run build
# Runtime image
FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/package.json .
COPY --from=builder /app/pnpm-lock.yaml .
COPY --from=builder /app/pnpm-workspace.yaml .
COPY --from=builder /app/.npmrc .
# Copy workspace packages definitions for pnpm install
COPY --from=builder /app/artifacts/api-server/package.json ./artifacts/api-server/
COPY --from=builder /app/artifacts/anki-generator/package.json ./artifacts/anki-generator/
COPY --from=builder /app/lib/db/package.json ./lib/db/
COPY --from=builder /app/lib/api-zod/package.json ./lib/api-zod/
COPY --from=builder /app/lib/integrations-openai-ai-server/package.json ./lib/integrations-openai-ai-server/
COPY --from=builder /app/lib/api-client-react/package.json ./lib/api-client-react/
# Copy build outputs
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/anki-generator/dist ./artifacts/anki-generator/dist
# Install pnpm and production dependencies for API server only
RUN npm i -g pnpm@9 && pnpm install --prod --filter "@workspace/api-server"
ENV NODE_ENV=production
EXPOSE $PORT
CMD ["node", "artifacts/api-server/dist/index.mjs"]
