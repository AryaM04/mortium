// React bindings for the realtime store and the gateway connection state.
import { useStore } from "zustand";
import type { RealtimeStore } from "@mortium/client-core";
import { connectionStore, realtimeStore, type ConnectionState } from "./realtime.js";

export function useRealtime<T>(selector: (state: RealtimeStore) => T): T {
  return useStore(realtimeStore, selector);
}

export function useConnectionState<T>(selector: (state: ConnectionState) => T): T {
  return useStore(connectionStore, selector);
}
