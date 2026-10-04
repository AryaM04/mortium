// The local search index of one user and device, in IndexedDB. The server
// cannot search ciphertext, so each device indexes the messages that it
// decrypted: live, fetched and restored ones.
//
// At rest, the index holds for each message:
// - the words as HMAC-SHA-256 tags (a per-device key), not as text,
// - the text and the file flag, encrypted with AES-GCM (a per-device key),
// - the ids of the event, the channel and the sender, and the time. The
//   server knows these already.
// Both keys come from the pickle key of the crypto store (see
// `deriveLocalIndexKeys`). The trade-off of word tags against one
// encrypted blob is in docs/concepts/search.md.
import type { DecryptedPayload, EventJson } from "@mortium/shared";
import { tokenize, type HasFilter } from "./text.js";

/** The index keeps at most this many messages. It drops the oldest first. */
export const MAX_INDEXED_MESSAGES = 200_000;
/** The index drops old messages in batches, when it has this many more than the limit. */
const TRIM_SLACK = 1000;
const TAG_BYTES = 12;
const STORE = "messages";

export interface IndexKeys {
  encryptionKey: CryptoKey;
  tokenKey: CryptoKey;
}

/** One message to index. */
export interface IndexInput {
  id: string;
  channelId: string;
  senderId: string;
  createdAt: string;
  body: string;
  hasFile: boolean;
}

/** One edit to apply: only an edit from the sender of the message, newer than the last one. */
export interface EditInput {
  targetId: string;
  editId: string;
  senderId: string;
  body: string;
}

export interface IndexQuery {
  /** Folded words. A result has each of them. */
  terms: string[];
  has: HasFilter[];
  /** When set, only these senders. */
  senderIds?: string[];
  /** When set, only these channels. */
  channelIds?: string[];
  limit?: number;
}

export interface IndexResult {
  id: string;
  channelId: string;
  senderId: string;
  createdAt: string;
  body: string;
}

interface StoredMessage {
  /** The event id, padded to 20 digits, so the key order is the time order. */
  key: string;
  channelId: string;
  senderId: string;
  createdAt: string;
  editId: string | null;
  tags: string[];
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

interface SecretPart {
  body: string;
  hasFile: boolean;
}

function orderKey(id: string): string {
  return id.padStart(20, "0");
}

function idOf(key: string): string {
  return key.replace(/^0+(?=\d)/, "");
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The search index could not be read."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("The search index could not be written."));
    tx.onabort = () => reject(tx.error ?? new Error("The search index could not be written."));
  });
}

/** True when the text has an http or https link. */
export function hasLink(body: string): boolean {
  return /https?:\/\/\S/i.test(body);
}

export interface LocalSearchIndex {
  /** Add messages, or replace them. An edit that the index already has stays applied. */
  add(messages: IndexInput[]): Promise<void>;
  applyEdits(edits: EditInput[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  search(query: IndexQuery): Promise<IndexResult[]>;
  count(): Promise<number>;
  close(): void;
}

/** One change for the index: a message that a tab decoded, or deleted messages. */
export type SearchChange =
  | { kind: "decoded"; event: EventJson; payload: DecryptedPayload }
  | { kind: "redacted"; ids: string[] };

/** Write a batch of changes in their order. */
export async function applySearchChanges(index: LocalSearchIndex, changes: SearchChange[]): Promise<void> {
  const messages: IndexInput[] = [];
  const edits: EditInput[] = [];
  const write = async () => {
    // Messages first: an edit needs its message in the index.
    await index.add(messages.splice(0));
    await index.applyEdits(edits.splice(0));
  };
  for (const change of changes) {
    if (change.kind === "redacted") {
      await write();
      await index.remove(change.ids);
      continue;
    }
    const { event, payload } = change;
    if (payload.type === "message") {
      messages.push({
        id: event.id,
        channelId: event.channelId,
        senderId: event.senderId,
        createdAt: event.createdAt,
        body: payload.body,
        hasFile: payload.attachments.length > 0,
      });
    } else if (payload.type === "edit" && event.relatesToId) {
      edits.push({ targetId: event.relatesToId, editId: event.id, senderId: event.senderId, body: payload.body });
    }
  }
  await write();
}

export async function openLocalSearchIndex(options: {
  name: string;
  keys: IndexKeys;
  indexedDb?: IDBFactory;
  maxMessages?: number;
}): Promise<LocalSearchIndex> {
  const factory = options.indexedDb ?? indexedDB;
  const maxMessages = options.maxMessages ?? MAX_INDEXED_MESSAGES;
  const { encryptionKey, tokenKey } = options.keys;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(options.name, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("tags", "tags", { multiEntry: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The search index could not be opened."));
  });
  const encoder = new TextEncoder();

  async function tag(value: string): Promise<string> {
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", tokenKey, encoder.encode(value)));
    let text = "";
    for (const byte of mac.subarray(0, TAG_BYTES)) {
      text += byte.toString(16).padStart(2, "0");
    }
    return text;
  }

  const wordTag = (word: string) => tag(`w:${word}`);
  const hasTag = (kind: HasFilter) => tag(`h:${kind}`);

  async function seal(secret: SecretPart): Promise<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, encoder.encode(JSON.stringify(secret)));
    return { iv, data };
  }

  async function open(record: StoredMessage): Promise<SecretPart> {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, encryptionKey, record.data);
    return JSON.parse(new TextDecoder().decode(plain)) as SecretPart;
  }

  async function tagsOf(secret: SecretPart): Promise<string[]> {
    const tags = await Promise.all(tokenize(secret.body).map(wordTag));
    if (secret.hasFile) tags.push(await hasTag("file"));
    if (hasLink(secret.body)) tags.push(await hasTag("link"));
    return tags;
  }

  async function build(
    base: Pick<StoredMessage, "key" | "channelId" | "senderId" | "createdAt" | "editId">,
    secret: SecretPart,
  ): Promise<StoredMessage> {
    const [tags, sealed] = await Promise.all([tagsOf(secret), seal(secret)]);
    return { ...base, tags, ...sealed };
  }

  async function getRecords(keys: string[]): Promise<Array<StoredMessage | undefined>> {
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    return Promise.all(keys.map((key) => requestResult(store.get(key) as IDBRequest<StoredMessage | undefined>)));
  }

  async function putAll(records: StoredMessage[]): Promise<void> {
    if (records.length === 0) return;
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const record of records) {
      store.put(record);
    }
    await transactionDone(tx);
  }

  /** Drop the oldest messages when the index has too many. */
  async function trim(): Promise<void> {
    const total = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).count());
    if (total <= maxMessages + Math.min(TRIM_SLACK, Math.floor(maxMessages / 10))) {
      return;
    }
    let extra = total - maxMessages;
    const tx = db.transaction(STORE, "readwrite");
    const cursorRequest = tx.objectStore(STORE).openKeyCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor && extra > 0) {
        tx.objectStore(STORE).delete(cursor.primaryKey);
        extra -= 1;
        cursor.continue();
      }
    };
    await transactionDone(tx);
  }

  return {
    async add(messages) {
      const existing = await getRecords(messages.map((message) => orderKey(message.id)));
      const records = await Promise.all(
        messages.map((message, index) => {
          const old = existing[index];
          if (old?.editId) {
            // The edit came first (or the message was fetched again). Keep the edited text.
            return null;
          }
          return build(
            { key: orderKey(message.id), channelId: message.channelId, senderId: message.senderId, createdAt: message.createdAt, editId: null },
            { body: message.body, hasFile: message.hasFile },
          );
        }),
      );
      await putAll(records.filter((record): record is StoredMessage => record !== null));
      await trim();
    },

    async applyEdits(edits) {
      const existing = await getRecords(edits.map((edit) => orderKey(edit.targetId)));
      const records: StoredMessage[] = [];
      for (const [index, edit] of edits.entries()) {
        const old = existing[index];
        // Only the sender can edit, and only a newer edit wins (the ids are in time order).
        if (!old || old.senderId !== edit.senderId || (old.editId && orderKey(old.editId) >= orderKey(edit.editId))) {
          continue;
        }
        const secret = await open(old);
        records.push(await build({ ...old, editId: edit.editId }, { body: edit.body, hasFile: secret.hasFile }));
      }
      await putAll(records);
    },

    async remove(ids) {
      if (ids.length === 0) return;
      const tx = db.transaction(STORE, "readwrite");
      for (const id of ids) {
        tx.objectStore(STORE).delete(orderKey(id));
      }
      await transactionDone(tx);
    },

    async search(query) {
      const limit = query.limit ?? 50;
      const senders = query.senderIds ? new Set(query.senderIds) : null;
      const channels = query.channelIds ? new Set(query.channelIds) : null;
      const required = await Promise.all([...query.terms.map(wordTag), ...query.has.map(hasTag)]);
      const matches = (record: StoredMessage) =>
        (!senders || senders.has(record.senderId)) &&
        (!channels || channels.has(record.channelId)) &&
        required.every((value) => record.tags.includes(value));

      let found: StoredMessage[] = [];
      if (required.length > 0) {
        const index = db.transaction(STORE, "readonly").objectStore(STORE).index("tags");
        // Start from the rarest tag: it gives the fewest records to check.
        const counts = await Promise.all(required.map((value) => requestResult(index.count(value))));
        const rarest = required[counts.indexOf(Math.min(...counts))]!;
        const candidates = await requestResult(index.getAll(rarest) as IDBRequest<StoredMessage[]>);
        found = candidates
          .filter(matches)
          .sort((a, b) => (a.key < b.key ? 1 : -1))
          .slice(0, limit);
      } else {
        // Only filters: walk from the newest message.
        const tx = db.transaction(STORE, "readonly");
        const cursorRequest = tx.objectStore(STORE).openCursor(null, "prev");
        await new Promise<void>((resolve, reject) => {
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor || found.length >= limit) {
              resolve();
              return;
            }
            const record = cursor.value as StoredMessage;
            if (matches(record)) {
              found.push(record);
            }
            cursor.continue();
          };
          cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("The search index could not be read."));
        });
      }
      return Promise.all(
        found.map(async (record) => ({
          id: idOf(record.key),
          channelId: record.channelId,
          senderId: record.senderId,
          createdAt: record.createdAt,
          body: (await open(record)).body,
        })),
      );
    },

    count: () => requestResult(db.transaction(STORE, "readonly").objectStore(STORE).count()),

    close() {
      db.close();
    },
  };
}
