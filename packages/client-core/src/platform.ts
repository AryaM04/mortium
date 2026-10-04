// A platform gives client-core the things it needs from the host: a
// secure place to keep the session and the crypto pickle key, and desktop
// notifications. The web app uses IndexedDB and the Notification API. The
// desktop app (apps/web/src/desktop/desktop-platform.ts) supplies the OS key
// store, system notifications and its own link preview fetch.
import type { FetchLinkPreview } from "./link-preview.js";

/** A small secure key-value store. Values are text (JSON, in practice). */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface NotifyOptions {
  title: string;
  body: string;
  /** Messages with the same tag replace each other, for example one tag for each channel. */
  tag?: string;
  /** Called when the user clicks the notification. */
  onClick?: () => void;
}

/** The host services that client-core needs. */
export interface Platform {
  secureStore: SecureStore;
  /** Show a desktop notification. It does nothing when the user did not give permission. */
  notify?(options: NotifyOptions): void;
  /**
   * Make the preview of a link, for a message that this device sends.
   * The limits: 3 s, 512 KiB of HTML, a 2 MiB image, and no private
   * network address. The web app supplies a version that asks its own
   * server (see `createServerLinkPreviewFetcher`). The desktop app
   * fetches the page itself.
   */
  fetchLinkPreview?: FetchLinkPreview;
}

const DB_NAME = "mortium-secure-store";
const DB_VERSION = 1;
const STORE_NAME = "kv";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the local store."));
  });
}

/** The IndexedDB entry that holds the AES-GCM key. The browser does not let page code export it. */
const WRAPPING_KEY_ENTRY = "__wrapping-key";

interface WrappedValue {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

function readEntry(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not read the local store."));
  });
}

/**
 * Get the AES-GCM key of this browser profile, or make one. The key is not
 * extractable. The add runs in one transaction with a read, so two tabs
 * that start at the same time keep the same key.
 */
async function loadWrappingKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = (await readEntry(db, WRAPPING_KEY_ENTRY)) as CryptoKey | undefined;
  if (existing) {
    return existing;
  }
  const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    let chosen = fresh;
    const request = store.get(WRAPPING_KEY_ENTRY);
    request.onsuccess = () => {
      if (request.result) {
        chosen = request.result as CryptoKey;
      } else {
        store.add(fresh, WRAPPING_KEY_ENTRY);
      }
    };
    tx.oncomplete = () => resolve(chosen);
    tx.onerror = () => reject(tx.error ?? new Error("Could not write to the local store."));
  });
}

/**
 * A small IndexedDB secure store for the web platform. Each value is
 * encrypted with a non-extractable AES-GCM key, with the entry name as
 * additional data. A copy of the IndexedDB files alone does not give the
 * values. Code in the page can still use the key. See
 * docs/concepts/olm-megolm.md section 7.
 */
function createIndexedDbSecureStore(): SecureStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  let keyPromise: Promise<CryptoKey> | null = null;
  function getDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = openDatabase();
    }
    return dbPromise;
  }
  function getKey(db: IDBDatabase): Promise<CryptoKey> {
    keyPromise ??= loadWrappingKey(db);
    return keyPromise;
  }
  const canEncrypt = typeof crypto !== "undefined" && crypto.subtle !== undefined;
  const text = new TextEncoder();

  return {
    async get(key: string): Promise<string | null> {
      const db = await getDb();
      const stored = await readEntry(db, key);
      if (stored === undefined || stored === null) {
        return null;
      }
      if (typeof stored === "string") {
        // A value from before encryption. The next set encrypts it.
        return stored;
      }
      const { iv, data } = stored as WrappedValue;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: text.encode(key) },
        await getKey(db),
        data,
      );
      return new TextDecoder().decode(plain);
    },

    async set(key: string, value: string): Promise<void> {
      const db = await getDb();
      let stored: string | WrappedValue = value;
      if (canEncrypt) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: text.encode(key) },
          await getKey(db),
          text.encode(value),
        );
        stored = { iv, data };
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(stored, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Could not write to the local store."));
      });
    },

    async delete(key: string): Promise<void> {
      const db = await getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("Could not write to the local store."));
      });
    },
  };
}

/** Show a notification through the Notification API. The app asks for the permission from a button. */
function webNotify(options: NotifyOptions): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  const notification = new Notification(options.title, { body: options.body, tag: options.tag });
  notification.onclick = () => {
    window.focus();
    notification.close();
    options.onClick?.();
  };
}

/** The platform for the web app: a browser tab, backed by IndexedDB and the Notification API. */
export const webPlatform: Platform = {
  secureStore: createIndexedDbSecureStore(),
  notify: webNotify,
};
