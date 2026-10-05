// A banner shown while the gateway connection is down and retrying, and a
// banner shown while another tab of this app runs the encryption or the
// encryption failed.
import { useStore } from "zustand";
import { cryptoTabStore } from "../lib/crypto.js";
import { session } from "../lib/session.js";
import { useConnectionState } from "../lib/useRealtime.js";

export function ConnectionBanner() {
  const state = useConnectionState((s) => s.state);
  if (state !== "reconnecting") {
    return null;
  }
  return (
    <div role="status" className="px-3 py-2 text-center text-sm" style={{ backgroundColor: "#5c3d00", color: "#ffe0a3" }}>
      The connection is lost. The app tries to connect again.
    </div>
  );
}

/**
 * Only one tab of a device runs the crypto layer. The other tabs show this
 * and wait. When the crypto layer cannot start, this shows the reason. When
 * the local crypto data is lost, only a sign-out and a new device can help.
 */
export function CryptoTabBanner() {
  const { otherTab, failure, lost } = useStore(cryptoTabStore);
  if (failure) {
    return (
      <div
        role="alert"
        data-crypto-failed
        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
        style={{ backgroundColor: "#5c1d1d", color: "#ffd9d9" }}
      >
        <span>
          Encryption failed: {failure}{" "}
          {lost
            ? "Sign out, then sign in again to make a new device. Messages that only this device could read stay locked."
            : "The app tries again."}
        </span>
        {lost && (
          <button type="button" className="underline" onClick={() => void session.store.getState().logout()}>
            Sign out
          </button>
        )}
      </div>
    );
  }
  if (!otherTab) {
    return null;
  }
  return (
    <div
      role="status"
      data-crypto-other-tab
      className="px-3 py-2 text-center text-sm"
      style={{ backgroundColor: "#5c3d00", color: "#ffe0a3" }}
    >
      Encryption runs in another tab of this app. Use that tab, or close it.
    </div>
  );
}
