# Multi-stage build for the server. The final image holds only production
# dependencies and compiled output, to keep the image small.
# Build it from the repository root: docker build -f apps/server/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/link-preview-fetch/package.json packages/link-preview-fetch/package.json
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/link-preview-fetch packages/link-preview-fetch
COPY apps/server apps/server
COPY tsconfig.base.json tsconfig.base.json
RUN pnpm --filter @mortium/server build:bundle
RUN pnpm --filter @mortium/server deploy --legacy --prod /out/server

# The runtime image copies only the node binary from the node image. This
# leaves out npm, yarn and corepack, which the server does not need.
FROM alpine:3.22 AS runtime
RUN apk add --no-cache libstdc++
COPY --from=node:24-alpine /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production
ENV DATA_DIR=/data
# The IDs are fixed, because the backup service uses the same user to read and write /data.
RUN addgroup -S -g 101 app && adduser -S -u 100 -G app app && mkdir /data && chown app:app /data
WORKDIR /app
COPY --from=build /out/server/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/server/package.json ./package.json
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${API_PORT:-3000}/api/v1/health" || exit 1
CMD ["node", "dist/index.js"]
