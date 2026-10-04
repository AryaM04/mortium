// Loads the vodozemac WASM module one time. The web app reaches this file
// only through a dynamic import, so the WASM file is not in the main bundle.
import init, * as wasm from "@mortium/crypto-wasm";

export type Wasm = typeof wasm;

let loading: Promise<Wasm> | null = null;

/** Load and start the WASM module. A test can call `initSync` first; then this does no fetch. */
export function loadWasm(): Promise<Wasm> {
  loading ??= init().then(() => wasm);
  return loading;
}
