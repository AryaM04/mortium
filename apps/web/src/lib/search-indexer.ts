// The local search index of this tab: it gives the decoded messages to the
// crypto layer, which writes the encrypted IndexedDB index of this user and
// device, and it asks the crypto layer for searches. Only the crypto layer
// writes the index, so two tabs never write it at the same time. Loaded
// with a dynamic import. See docs/concepts/search.md.
import type { IndexQuery, IndexResult, SearchChange } from "@mortium/client-core/search";
import { cryptoReady } from "./messages.js";
import { clearSearchQueue } from "./search-queue.js";
import { session } from "./session.js";

export async function applyChanges(changes: SearchChange[]): Promise<void> {
  await (await cryptoReady()).search.apply(changes);
}

export async function searchLocal(query: IndexQuery): Promise<IndexResult[]> {
  return (await cryptoReady()).search.query(query);
}

session.store.subscribe((state, previous) => {
  if (state.status === "signedOut" && previous.status !== "signedOut") {
    clearSearchQueue();
  }
});
