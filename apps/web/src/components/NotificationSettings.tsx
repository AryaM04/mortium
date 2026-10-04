// The notification part of the account settings: the browser permission
// for desktop notifications (asked only from this button) and the ring
// sound of incoming calls (a synced setting).
import { useState } from "react";
import { playRingSoundOf } from "@mortium/client-core";
import { settingsStore, useSettings } from "../lib/settings.js";
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermissionState,
} from "../lib/notifications.js";

const PERMISSION_TEXT: Record<NotificationPermissionState, string> = {
  granted: "Desktop notifications are on.",
  default: "Desktop notifications are off.",
  denied: "The browser blocks desktop notifications. Change this in the site settings of the browser.",
  unsupported: "This browser cannot show desktop notifications.",
};

export default function NotificationSettings() {
  const [permission, setPermission] = useState(notificationPermission);
  const playRingSound = useSettings((s) => playRingSoundOf(s.values));
  const saveError = useSettings((s) => s.error);

  return (
    <section className="mb-4 flex flex-col gap-2 border-t pt-4" style={{ borderColor: "var(--color-border)" }}>
      <h3 className="text-sm font-semibold">Notifications</h3>
      <p className="text-sm" style={{ color: "var(--color-text-muted)" }} data-notification-permission={permission}>
        {PERMISSION_TEXT[permission]}
      </p>
      {permission === "default" && (
        <button
          type="button"
          onClick={() => void requestNotificationPermission().then(setPermission)}
          className="self-start rounded px-3 py-1 text-sm font-medium"
          style={{ backgroundColor: "var(--color-accent)", color: "white" }}
        >
          Turn on desktop notifications
        </button>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={playRingSound}
          onChange={(e) => void settingsStore.getState().update({ playRingSound: e.target.checked })}
        />
        Play ring sound
      </label>
      {saveError && (
        <p role="alert" className="text-xs" style={{ color: "var(--color-danger-text)" }}>
          {saveError}
        </p>
      )}
    </section>
  );
}
