// Tests of the password keys: the auth key is the same for the same
// password and salt, and the wrap key is a different key from the auth key.
import { beforeAll, describe, expect, it } from "vitest";
import { decodeBase64Url } from "@mortium/shared";
import { derivePasswordKeys, newKdfSalt, unwrapRecoveryKey, wrapRecoveryKey } from "./password-keys.js";
import { encodeRecoveryKey } from "./recovery-key.js";
import { initWasmForTests } from "./test/fake-server.js";

beforeAll(() => {
  initWasmForTests();
});

describe("password keys", () => {
  it("derives the same auth key from the same password and salt, and a different one from a different salt", async () => {
    const salt = newKdfSalt();
    const first = await derivePasswordKeys("correct horse battery staple", salt);
    const again = await derivePasswordKeys("correct horse battery staple", salt);
    const other = await derivePasswordKeys("correct horse battery staple", newKdfSalt());

    expect(decodeBase64Url(first.authKey)).toHaveLength(32);
    expect(again.authKey).toBe(first.authKey);
    expect(other.authKey).not.toBe(first.authKey);

    // The wrap key of the second derivation opens a wrap of the first: it is the same key.
    const recoveryKey = encodeRecoveryKey(crypto.getRandomValues(new Uint8Array(32)));
    const wrap = await wrapRecoveryKey(first.wrapKey, recoveryKey, "42", 3);
    expect(decodeBase64Url(wrap)).toHaveLength(60);
    expect(await unwrapRecoveryKey(again.wrapKey, wrap, "42", 3)).toBe(recoveryKey);
    expect(await unwrapRecoveryKey(other.wrapKey, wrap, "42", 3)).toBeNull();
    // A wrap of a different user or backup version does not open.
    expect(await unwrapRecoveryKey(first.wrapKey, wrap, "43", 3)).toBeNull();
    expect(await unwrapRecoveryKey(first.wrapKey, wrap, "42", 4)).toBeNull();

    // The auth key, which the server gets, is not the wrap key.
    const authAsKey = await crypto.subtle.importKey("raw", decodeBase64Url(first.authKey) as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["decrypt"]);
    expect(await unwrapRecoveryKey(authAsKey, wrap, "42", 3)).toBeNull();
  });
});
