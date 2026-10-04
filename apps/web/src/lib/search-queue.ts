// The small, always-loaded part of the local search: it collects the
// messages that this tab decoded and the redactions, and gives them to
// the index module (`search-indexer.ts`) in batches. That module loads
// only on the first batch. See docs/concepts/search.md.
import type { DecryptedPayload, EventJson } from "@mortium/shared";
import type { SearchChange } from "@mortium/client-core/search";

/** The queue keeps at most this many changes while the index is not ready. The oldest go first. */
const MAX_QUEUE = 5000;
const FLUSH_DELAY_MS = 1500;

let queue: SearchChange[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function schedule(): void {
  timer ??= setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

function push(changes: SearchChange[]): void {
  queue.push(...changes);
  if (queue.length > MAX_QUEUE) {
    queue.splice(0, queue.length - MAX_QUEUE);
  }
  schedule();
}

async function flush(): Promise<void> {
  timer = null;
  if (flushing || queue.length === 0) {
    return;
  }
  flushing = true;
  const batch = queue;
  queue = [];
  running = (async () => {
    try {
      await (await import("./search-indexer.js")).applyChanges(batch);
    } catch (error) {
      console.warn("[search] The local search index could not be updated.", error);
    }
  })();
  await running;
  running = null;
  flushing = false;
  if (queue.length > 0) {
    schedule();
  }
}

let running: Promise<void> | null = null;

export function queueDecoded(items: Array<{ event: EventJson; payload: DecryptedPayload }>): void {
  const useful = items.filter((item) => item.payload.type !== "reaction");
  if (useful.length > 0) {
    push(useful.map((item) => ({ kind: "decoded" as const, ...item })));
  }
}

export function queueRedacted(_channelId: string, ids: string[]): void {
  push([{ kind: "redacted", ids }]);
}

/** Write the queued changes now. The search panel calls it before a search. */
export async function flushSearchQueue(): Promise<void> {
  if (running) {
    await running;
  }
  if (timer) {
    clearTimeout(timer);
  }
  await flush();
}

/** Forget the queue, for example after sign-out. */
export function clearSearchQueue(): void {
  queue = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
