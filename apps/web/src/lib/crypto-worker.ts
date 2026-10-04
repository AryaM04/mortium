// The crypto SharedWorker. The browser runs one for each device (the name
// has the user and the device), and every tab of that device connects to
// it. It runs the crypto layer, the WASM file and the local search index.
// See docs/concepts/olm-megolm.md section 13.
import { webPlatform } from "@mortium/client-core";
import { createCryptoHost, startCrypto } from "@mortium/client-core/crypto";

const log = (message: string) => console.warn(`[crypto] ${message}`);

const host = createCryptoHost({
  locks: navigator.locks,
  log,
  start: (options) => startCrypto({ ...options, secureStore: webPlatform.secureStore, log }),
});

(globalThis as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (event) => {
  host.connect(event.ports[0]!);
};
