// Create a channel (text or voice, optionally inside a category) or a
// category (no parent, no type choice).
import { useEffect, useRef, useState } from "react";
import { channelNameSchema, type ChannelJson } from "@mortium/shared";
import { createChannel } from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";

export function CreateChannelDialog({
  open,
  onClose,
  guildId,
  kind,
  defaultParentId,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  guildId: string;
  kind: "channel" | "category";
  defaultParentId: string | null;
  categories: ChannelJson[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<"text" | "voice">("text");
  const [parentId, setParentId] = useState<string>(defaultParentId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setName("");
      setType("text");
      setParentId(defaultParentId ?? "");
      setError(null);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, defaultParentId]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (kind === "category") {
      if (name.trim() === "") {
        setError("Enter a name.");
        return;
      }
    } else {
      const parsed = channelNameSchema.safeParse(name);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? "This name is not valid.");
        return;
      }
    }
    setPending(true);
    setError(null);
    try {
      const channel = await createChannel(session.apiClient, guildId, {
        name,
        type: kind === "category" ? "category" : type,
        parentId: kind === "category" ? null : parentId || null,
      });
      realtimeStore.getState().applyDispatch({ t: "CHANNEL_CREATE", d: channel });
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="w-full max-w-sm p-6"
      aria-label={kind === "category" ? "Create a category" : "Create a channel"}
    >
      <h2 className="mb-4 text-lg font-semibold">
        {kind === "category" ? "Create a category" : "Create a channel"}
      </h2>
      <form onSubmit={handleCreate}>
        <label htmlFor="new-channel-name" className="mb-1 block text-sm font-medium">
          Name
        </label>
        <input
          id="new-channel-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="field mb-4 w-full px-3 py-2 text-sm"
        />

        {kind === "channel" && (
          <>
            <fieldset className="mb-4">
              <legend className="mb-1 text-sm font-medium">Channel type</legend>
              <label className="mr-4 text-sm">
                <input
                  type="radio"
                  name="channel-type"
                  checked={type === "text"}
                  onChange={() => setType("text")}
                />{" "}
                Text
              </label>
              <label className="text-sm">
                <input
                  type="radio"
                  name="channel-type"
                  checked={type === "voice"}
                  onChange={() => setType("voice")}
                />{" "}
                Voice
              </label>
            </fieldset>

            <label htmlFor="new-channel-parent" className="mb-1 block text-sm font-medium">
              Category
            </label>
            <select
              id="new-channel-parent"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="field mb-4 w-full px-3 py-2 text-sm"
            >
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </>
        )}

        {error && (
          <p role="alert" className="mb-4 text-sm text-danger-text">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={pending} className="btn btn-primary">
            {pending ? "Creating..." : "Create"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
