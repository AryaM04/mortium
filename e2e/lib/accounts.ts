// Sign-up through the API for the e2e tests. A client never sends the
// password: it sends an auth key from Argon2id and HKDF (see
// docs/concepts/password-keys.md). This helper uses the same code as the
// web app, so a later sign-in through the UI with the password works.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initSync } from "@mortium/crypto-wasm";
import { derivePasswordKeys, newKdfSalt } from "@mortium/client-core/password-keys";

let wasmReady = false;

function loadWasm(): void {
  if (!wasmReady) {
    const require = createRequire(import.meta.url);
    initSync({ module: readFileSync(require.resolve("@mortium/crypto-wasm/pkg/crypto_wasm_bg.wasm")) });
    wasmReady = true;
  }
}

/** The body of POST /auth/register for a user with a password. */
export async function registerBody(user: { email: string; username: string; password: string; displayName?: string }) {
  loadWasm();
  const keys = await derivePasswordKeys(user.password, newKdfSalt());
  return {
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    authKey: keys.authKey,
    kdfSalt: keys.kdfSalt,
    kdfVersion: 1,
  };
}
