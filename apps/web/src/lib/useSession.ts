// React binding for the vanilla session store (see docs/architecture.md
// section 7: React components use client-core, never fetch directly).
import { useStore } from "zustand";
import type { SessionStore } from "@mortium/client-core";
import { session } from "./session.js";

export function useSession<T>(selector: (state: SessionStore) => T): T {
  return useStore(session.store, selector);
}
