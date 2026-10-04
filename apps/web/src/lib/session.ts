// The one session instance for this tab. Every page reads it through the
// `useSession` hook in `useSession.ts`, and never calls `fetch` directly
// (see docs/architecture.md section 7).
import { createSession } from "@mortium/client-core";
import { sessionPlatform } from "./platform.js";
import { apiBaseUrl } from "./server-url.js";

// The store moves itself to "signedOut" on a reused or invalid refresh
// token. Protected routes react to that status and redirect on their own
// (see App.tsx), so there is nothing extra to wire up here.
export const session = createSession({ baseUrl: apiBaseUrl, platform: sessionPlatform });
