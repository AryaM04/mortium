// Tests for the web secure store: values are encrypted at rest with a
// non-extractable AES-GCM key, and a plain value from before still reads.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { webPlatform } from "./platform.js";

function readRaw(key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("mortium-secure-store", 1);
    open.onsuccess = () => {
      const request = open.result.transaction("kv", "readonly").objectStore("kv").get(key);
      request.onsuccess = () => {
        open.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  });
}

function writeRaw(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("mortium-secure-store", 1);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe("web secure store", () => {
  it("keeps values encrypted with a key that cannot be exported", async () => {
    const store = webPlatform.secureStore;
    await store.set("crypto-pickle-key:1:dev", "secret-value");
    expect(await store.get("crypto-pickle-key:1:dev")).toBe("secret-value");

    const raw = await readRaw("crypto-pickle-key:1:dev");
    expect(typeof raw).not.toBe("string");
    expect(JSON.stringify(raw)).not.toContain("secret-value");

    const key = (await readRaw("__wrapping-key")) as CryptoKey;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("binds each value to its entry name", async () => {
    const store = webPlatform.secureStore;
    await store.set("a", "value of a");
    await writeRaw("b", await readRaw("a"));
    await expect(store.get("b")).rejects.toThrow();
  });

  it("reads a plain value from before encryption", async () => {
    await writeRaw("session", "plain-json");
    expect(await webPlatform.secureStore.get("session")).toBe("plain-json");
  });
});
