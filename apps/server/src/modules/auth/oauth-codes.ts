// A short-lived, single-use exchange code, so the OAuth callback (a plain
// browser redirect) never puts the access and refresh tokens in a URL.
// The map lives in process memory: one server process, no extra store.
import { randomBytes } from "node:crypto";
import type { AuthResult } from "@mortium/shared";

const CODE_TTL_MS = 60_000;
const MAX_CODES = 1000;

interface StoredCode {
  result: AuthResult;
  expiresAt: number;
}

const codes = new Map<string, StoredCode>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) {
      codes.delete(code);
    }
  }
  // Bound the map even if many codes were made but never used. Drop the
  // oldest entries first (Map keeps insertion order).
  while (codes.size > MAX_CODES) {
    const oldestKey = codes.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    codes.delete(oldestKey);
  }
}

/** Store one auth result under a new random code. The code expires in 60 seconds. */
export function storeOAuthCode(result: AuthResult): string {
  pruneExpired();
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { result, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/** Take and remove the auth result for a code. Returns undefined once, after that. */
export function consumeOAuthCode(code: string): AuthResult | undefined {
  pruneExpired();
  const entry = codes.get(code);
  if (!entry) {
    return undefined;
  }
  codes.delete(code);
  if (entry.expiresAt <= Date.now()) {
    return undefined;
  }
  return entry.result;
}

/** Test-only: remove every stored code, so tests do not leak state between runs. */
export function clearOAuthCodesForTests(): void {
  codes.clear();
}
