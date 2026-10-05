// The message part of the account settings: link previews for the
// messages that this user sends (a synced setting).
import { linkPreviewsOf } from "@mortium/client-core";
import { settingsStore, useSettings } from "../lib/settings.js";

export default function MessageSettings() {
  const linkPreviews = useSettings((s) => linkPreviewsOf(s.values));
  return (
    <section className="mb-4 flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">Messages</h3>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={linkPreviews}
          onChange={(e) => void settingsStore.getState().update({ linkPreviews: e.target.checked })}
        />
        Show link previews for my messages
      </label>
      <p className="text-xs text-muted">
        The server of this app gets the page for the preview, so it sees the link. It keeps the
        preview in memory for 10 minutes. It does not write the link to its log.
      </p>
    </section>
  );
}
