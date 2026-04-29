FROM node:22-alpine AS builder
WORKDIR /app
# Install pnpm
RUN npm i -g pnpm@9
# Copy package definitions
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
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
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json .
COPY --from=builder /app/pnpm-lock.yaml .
COPY --from=builder /app/pnpm-workspace.yaml .
# Install production dependencies for API server only
RUN pnpm install --prod --filter "@workspace/api-server"
ENV NODE_ENV=production
EXPOSE $PORT
CMD ["node", "dist/index.mjs"]
