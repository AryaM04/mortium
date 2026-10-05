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
    <div
      role="status"
      className="border-b border-warning/30 bg-[#2a2110] px-3 py-2 text-center text-sm text-[#fcd34d]"
    >
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
        className="mx-1.5 mt-1.5 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-[#2a1018] px-3 py-2 text-sm text-[#fecdd3]"
      >
        <span>
          Encryption failed: {failure}{" "}
          {lost
            ? "Sign out, then sign in again to make a new device. Messages that only this device could read stay locked."
            : "The app tries again."}
        </span>
        {lost && (
          <button type="button" className="underline underline-offset-2" onClick={() => void session.store.getState().logout()}>
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
      className="mx-1.5 mt-1.5 rounded-lg border border-warning/30 bg-[#2a2110] px-3 py-2 text-center text-sm text-[#fcd34d]"
    >
      Encryption runs in another tab of this app. Use that tab, or close it.
    </div>
  );
}
