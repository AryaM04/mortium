// Channel settings: rename, edit the topic, move up/down (the keyboard
// alternative to drag-and-drop reorder), delete with confirmation, and a
// Permissions tab for this channel's overwrites (a lazy chunk, loaded
// only the first time it opens).
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { channelNameSchema, type ChannelJson } from "@mortium/shared";
import { deleteChannel, updateChannel } from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";

const ChannelPermissionsTab = lazy(() =>
  import("./ChannelPermissionsTab.js").then((mod) => ({ default: mod.ChannelPermissionsTab })),
);

type ChannelSettingsTab = "general" | "permissions";

export function ChannelSettingsDialog({
  open,
  onClose,
  channel,
  onMove,
}: {
  open: boolean;
  onClose: () => void;
  channel: ChannelJson;
  /** Swap this channel with its sibling above/below, within its category. */
  onMove: (direction: "up" | "down") => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(channel.name ?? "");
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tab, setTab] = useState<ChannelSettingsTab>("general");
  const [, navigate] = useLocation();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setName(channel.name ?? "");
      setTopic(channel.topic ?? "");
      setError(null);
      setConfirmingDelete(false);
      setTab("general");
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, channel.name, channel.topic]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (channel.type !== "category") {
      const parsed = channelNameSchema.safeParse(name);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "This name is not valid.");
        return;
      }
    }
    setPending(true);
    setError(null);
    try {
      const updated = await updateChannel(session.apiClient, channel.id, {
        name,
        topic: channel.type === "text" ? (topic.trim() === "" ? null : topic) : undefined,
      });
      realtimeStore.getState().applyDispatch({ t: "CHANNEL_UPDATE", d: updated });
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function handleDelete() {
    setPending(true);
    setError(null);
    try {
      await deleteChannel(session.apiClient, channel.id);
      realtimeStore.getState().applyDispatch({
        t: "CHANNEL_DELETE",
        d: { id: channel.id, guildId: channel.guildId },
      });
      onClose();
      navigate(`/app/${channel.guildId}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  const showPermissionsTab = channel.type !== "category";

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      // No "flex" (or other display-changing) class here: see the note
      // in GuildSettingsDialog.tsx. The flex layout lives on the wrapper
      // div just inside instead.
      className="w-full max-w-2xl overflow-hidden p-0"
      style={{ height: showPermissionsTab ? "min(32rem, 80vh)" : undefined }}
      aria-label="Channel settings"
    >
      <div className="flex h-full min-h-0">
        {showPermissionsTab && (
          <nav className="flex w-40 flex-shrink-0 flex-col gap-0.5 border-r border-line bg-sidebar p-3">
            {(
              [
                { id: "general", label: "General" },
                { id: "permissions", label: "Permissions" },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className="nav-row rounded-lg px-2.5 py-1.5 text-left text-sm"
              >
                {t.label}
              </button>
            ))}
          </nav>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
          {tab === "permissions" && showPermissionsTab ? (
            <Suspense fallback={<p className="text-sm">Loading...</p>}>
              <ChannelPermissionsTab channel={channel} />
            </Suspense>
          ) : (
            <>
              <h2 className="mb-4 text-lg font-semibold">Channel settings</h2>

              <form onSubmit={handleSave}>
                <label htmlFor="channel-settings-name" className="mb-1 block text-sm font-medium">
                  Name
                </label>
                <input
                  id="channel-settings-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="field mb-4 w-full px-3 py-2 text-sm"
                />

                {channel.type === "text" && (
                  <>
                    <label
                      htmlFor="channel-settings-topic"
                      className="mb-1 block text-sm font-medium"
                    >
                      Topic
                    </label>
                    <input
                      id="channel-settings-topic"
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      className="field mb-4 w-full px-3 py-2 text-sm"
                    />
                  </>
                )}

                <div className="mb-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => onMove("up")}
                    className="rounded border px-3 py-2 text-sm border-line"
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove("down")}
                    className="rounded border px-3 py-2 text-sm border-line"
                  >
                    Move down
                  </button>
                </div>

                {error && (
                  <p role="alert" className="mb-4 text-sm text-danger-text">
                    {error}
                  </p>
                )}

                <div className="flex justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    className="btn btn-danger-ghost"
                  >
                    Delete channel
                  </button>
                  <div className="flex gap-2">
                    <button type="button" onClick={onClose} className="btn btn-ghost">
                      Cancel
                    </button>
                    <button type="submit" disabled={pending} className="btn btn-primary">
                      {pending ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              </form>

              {confirmingDelete && (
                <div className="mt-4 border-t border-line pt-4">
                  <p className="mb-3 text-sm">Delete #{channel.name}? This cannot be undone.</p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      className="btn btn-ghost"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={handleDelete}
                      className="btn btn-danger"
                    >
                      {pending ? "Deleting..." : "Delete channel"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
