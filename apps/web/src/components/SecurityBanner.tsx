// Banners for the trust state of the encryption: a user whose identity key
// changed. It also opens the verification dialog when a verification
// starts. The dialog loads only when it opens. A device that the owner did
// not verify sees the security gate (SecurityGate.tsx), not the app. See
// docs/concepts/olm-megolm.md sections 4 and 10.
import { Suspense, lazy } from "react";
import { useStore } from "zustand";
import type { RealtimeState } from "@mortium/client-core";
import { currentCrypto, securityStore } from "../lib/crypto.js";
import { memberUser } from "../lib/members.js";
import { realtimeStore } from "../lib/realtime.js";

const VerificationDialog = lazy(() => import("./VerificationDialog.js"));

/** The display name of a user from any guild, DM or friend entry. */
export function nameOfUser(state: RealtimeState, userId: string): string {
  const user =
    memberUser(state, null, userId) ??
    Object.values(state.membersByGuild).find((members) => members[userId])?.[userId]?.user;
  return user?.displayName ?? `User ${userId}`;
}

const bannerStyle = { backgroundColor: "#5c1d1d", color: "#ffd9d9" };

export function SecurityBanner() {
  const security = useStore(securityStore);
  if (!security.ready) {
    return null;
  }
  const state = realtimeStore.getState();
  const openFlow = security.verifications.length > 0;

  return (
    <>
      {security.changedUsers.map((userId) => (
        <div key={userId} role="alert" className="flex items-center justify-between gap-3 px-3 py-2 text-sm" style={bannerStyle}>
          <span>
            Warning: the identity key of {nameOfUser(state, userId)} changed. This occurs after a reset of their account, or
            when someone tries to read your messages. Messages to this user stay locked until you accept the change.
          </span>
          <button type="button" className="underline" onClick={() => void currentCrypto()?.security.acceptIdentityChange(userId)}>
            Accept the new identity
          </button>
        </div>
      ))}
      {openFlow && (
        <Suspense fallback={null}>
          <VerificationDialog />
        </Suspense>
      )}
    </>
  );
}
