# Architecture and code conventions

Read this file before you change code. All milestones use these rules.
The full plan is in the plan file that `CLAUDE.md` names.

## 1. Workspace

| Path | Contents |
|---|---|
| `packages/shared` | Types, zod schemas and pure functions that the server and the clients both use. No Node APIs. No DOM APIs. |
| `packages/client-core` | Client logic without React: the REST client, the gateway client, the stores, E2EE and voice. It can use DOM and WebRTC APIs. |
| `packages/crypto-wasm` | The vodozemac WASM wrapper. |
| `apps/server` | Fastify REST API and WebSocket gateway. |
| `apps/web` | React UI. The desktop shells load this UI. |
| `apps/desktop-tauri`, `apps/desktop-electron` | Desktop shells. |
| `e2e` | Playwright tests. |

## 2. IDs and data on the wire

- All IDs are snowflakes. The database stores them as `bigint`. JSON sends them as decimal strings, for example `"123456789012345678"`. Do not send IDs as JSON numbers.
- Times on the wire are ISO 8601 strings in UTC.
- Binary data on the wire (ciphertext, keys) is base64url text, except for file uploads, which are raw bytes.
- Every request body and every response body has a zod schema in `packages/shared/src/api/`. The server validates requests with these schemas. The client parses responses with these schemas.

## 3. REST API

- The base path is `/api/v1`.
- Send and receive JSON (`content-type: application/json`), except for file routes.
- An error response has this shape and a correct HTTP status:
  `{ "error": { "code": "INVALID_CREDENTIALS", "message": "The email or password is not correct." } }`
  The `code` is UPPER_SNAKE_CASE and stable. Clients use the code, not the message.
- Use these statuses: 400 bad input, 401 no or bad token, 403 no permission, 404 not found, 409 conflict, 413 too large, 429 rate limit, 500 server fault.
- Do not show internal details (SQL errors, stack traces) in a response.

## 4. Authentication and devices

- One login makes one **device**. The server makes the device ID (random, 16 base64url characters). The E2EE keys attach to this device ID.
- The **access token** is a JWT (HS256, library `jose`). It is valid for 15 minutes. Claims: `sub` (user ID), `did` (device ID). The client sends it as `Authorization: Bearer <token>`.
- The **refresh token** is 32 random bytes as base64url. The server keeps only its SHA-256 hash. It is valid for 30 days. Each refresh gives a new refresh token and revokes the old one (rotation).
  If a client sends a revoked refresh token again, the server revokes all refresh tokens of that device, because the token was possibly stolen.
- Tokens go in the response body. The client keeps them in `platform.secureStore`. We do not use cookies, because the desktop shells use a different origin from the API.
- The desktop app has its own origin (`http://tauri.localhost` on Windows, `tauri://localhost` on macOS, `app://mortium` on Linux). The server sends CORS headers, without credentials, only to the origins in `CORS_ALLOWED_ORIGINS`. The gateway refuses a WebSocket upgrade from an origin that is not the web origin, the same host or an allowed origin.
- The client never sends the password. It derives an auth key from the password (Argon2id and HKDF) and sends that. See `docs/concepts/password-keys.md`.
- The server hashes the auth key with argon2id through `@node-rs/argon2` (it has prebuilt binaries for all platforms, including Alpine).
- Auth routes have a rate limit (`@fastify/rate-limit`, in memory).

## 5. Server code

- `src/index.ts` only starts the server. `src/app.ts` exports `buildApp(deps)`, which returns a Fastify instance and does not listen. Tests call `buildApp` with test dependencies.
- Put each feature in `src/modules/<feature>/`: `routes.ts` (thin: validate, call service, reply), `service.ts` (logic and database access), and tests.
- Put side effects behind small interfaces that `buildApp` receives: `mailer`, `clock` (only if a test needs it). Tests use in-memory fakes.
- The server runs the Drizzle migrations at start. Make new migrations with `pnpm --filter @mortium/server db:generate`. Do not edit an old migration.
- Use transactions when one action writes more than one row that must stay consistent.
- Use `request.log` or `app.log`. Do not use `console.log`.

## 6. Tests

- Unit tests: Vitest, next to the code (`*.test.ts`).
- Server integration tests use a real PostgreSQL. `TEST_DATABASE_URL` points to a server where the test user can make databases. The helper `test/db.ts` makes a new database for each test file, runs the migrations, and removes the database at the end. Use `app.inject()` for HTTP. Use a real `ws` client for the gateway.
- If `TEST_DATABASE_URL` is not set, integration tests are skipped with a clear message. CI sets it with a Postgres service.
- A test must check behavior that a user can see: status codes, bodies, database rows, events. Do not write tests that only repeat the implementation.

## 7. Web and client code

- React 19, `wouter` for routes, `zustand` for state. Tailwind for styles, with the CSS variables in `theme.css`.
- React components do not call `fetch` or open sockets. They use `packages/client-core`.
- The Vite dev server sends `/api` and `/gateway` to the API server (proxy). Thus, in dev and in production the web app and the API have one origin.
- Load heavy code (crypto WASM, emoji data, voice, diagnostics) with dynamic `import()` only when it is necessary.
- Every visible text follows ASD-STE100. Every form shows the error `message` from the server.

## 8. Resource rules (summary of `CLAUDE.md`)

- No polling where an event is available. Stop timers, sockets and media tracks when they are not in use.
- Keep memory use flat: bound every in-memory buffer and map (for example, the gateway resume buffer).
- Use pagination for every list that can grow (messages, members).
