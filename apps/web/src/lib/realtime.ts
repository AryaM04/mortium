// The one gateway connection and realtime store for this tab. It starts
// once the session signs in, and stops (and forgets everything) once it
// signs out. See docs/architecture.md section 7 and docs/concepts/gateway.md.
import { createStore } from "zustand/vanilla";
import {
  createGatewayClient,
  createRealtimeStore,
  type GatewayClient,
  type GatewayDispatch,
  type GatewayState,
} from "@mortium/client-core";
import { GatewayOpcode, type User } from "@mortium/shared";
import { session } from "./session.js";
import { messagesStore } from "./messages.js";
import { gatewayUrl } from "./server-url.js";

export const realtimeStore = createRealtimeStore();

export interface ConnectionState {
  state: GatewayState;
}

export const connectionStore = createStore<ConnectionState>(() => ({ state: "closed" }));

let client: GatewayClient | null = null;

// A second, raw listener list for every dispatch, in addition to the
// realtime store and the message store above. The voice module (loaded
// only once a call starts) uses this to see VOICE_STATE_UPDATE
// and VOICE_ERROR without this file needing to know voice exists.
const dispatchListeners = new Set<(event: GatewayDispatch) => void>();

/** Watch every gateway dispatch. Returns a function that stops watching. */
export function subscribeDispatch(listener: (event: GatewayDispatch) => void): () => void {
  dispatchListeners.add(listener);
  return () => {
    dispatchListeners.delete(listener);
  };
}

function startGateway(deviceId: string): void {
  if (client) {
    return;
  }
  client = createGatewayClient({
    url: gatewayUrl(),
    deviceId,
    api: session.apiClient,
    onEvent: (event) => {
      realtimeStore.getState().applyDispatch(event);
      if (event.t === "READY") {
        const payload = event.d as { user: { id: string } };
        messagesStore.getState().setSelfUserId(payload.user.id);
      } else if (event.t === "USER_UPDATE") {
        // For example, the email was verified in a different browser.
        session.store.setState({ user: event.d as User });
      }
      messagesStore.getState().applyDispatch(event.t, event.d);
      for (const listener of dispatchListeners) {
        listener(event);
      }
    },
    onState: (state) => connectionStore.setState({ state }),
    onFatal: () => {
      void session.store.getState().logout();
    },
  });
}

function stopGateway(): void {
  client?.close();
  client = null;
  realtimeStore.getState().reset();
  messagesStore.setState({ selfUserId: null, channels: {}, channelOrder: [] });
  connectionStore.setState({ state: "closed" });
}

/** Send PRESENCE_SET, or any other client-initiated gateway message. */
export function gatewaySend(op: number, d?: unknown): void {
  client?.send(op, d);
}

export function setPresence(status: "online" | "idle" | "dnd" | "invisible"): void {
  gatewaySend(GatewayOpcode.PRESENCE_SET, { status });
}

let previousStatus = session.store.getState().status;
session.store.subscribe((state) => {
  if (state.status === "signedIn" && state.deviceId && previousStatus !== "signedIn") {
    startGateway(state.deviceId);
  } else if (state.status === "signedOut" && previousStatus !== "signedOut") {
    stopGateway();
  }
  previousStatus = state.status;
});

const initial = session.store.getState();
if (initial.status === "signedIn" && initial.deviceId) {
  startGateway(initial.deviceId);
}
