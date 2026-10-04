# Multi-stage build for the web app and the Caddy reverse proxy. The final
# image is Caddy with the web build inside it, so one image serves the
# static files and proxies the API.
# Build it from the repository root: docker build -f apps/web/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY packages/crypto-wasm/package.json packages/crypto-wasm/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @mortium/web...
COPY tsconfig.base.json tsconfig.base.json
COPY packages/shared packages/shared
COPY packages/client-core packages/client-core
# The crypto WASM is built ahead of time and kept in packages/crypto-wasm/pkg.
COPY packages/crypto-wasm/pkg packages/crypto-wasm/pkg
COPY apps/web apps/web
# Run the type check and the bundler as two steps. Do not use the "build"
# script, so the image build has the same result in every place.
RUN pnpm --filter @mortium/web exec tsc --noEmit \
  && pnpm --filter @mortium/web exec vite build

FROM caddy:2-alpine
# Caddy runs as a user without rights. Docker lets a process in a container
# open ports below 1024 (docker-compose.yml also sets the sysctl), so the
# file capability of the binary is not necessary. Remove it: with
# "cap_drop: [ALL]", the kernel does not start a binary with that capability.
# coturn uses the same user ID, so that it can read the TLS key that Caddy writes.
RUN setcap -r /usr/bin/caddy \
  && addgroup -S -g 10001 caddy \
  && adduser -S -D -H -u 10001 -G caddy caddy \
  && chown -R caddy:caddy /data /config
COPY infra/caddy/Caddyfile infra/caddy/Caddyfile.tunnel infra/caddy/site.caddy /etc/caddy/
COPY --from=build /repo/apps/web/dist /srv
USER caddy
