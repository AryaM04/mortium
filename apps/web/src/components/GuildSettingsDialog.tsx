// Server settings: rename, change or remove the icon, delete the server
// (owner only, with a typed-name confirmation), and the Roles, Members
// and Bans tabs. Each of those three tabs is a separate lazy chunk (see
// CLAUDE.md's bundle-size rule), loaded only the first time it is opened.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { guildNameSchema, hasPermission, Permission, type GuildJson } from "@mortium/shared";
import {
  deleteGuild,
  removeGuildIcon,
  selfGuildPermissions,
  updateGuild,
  uploadGuildIcon,
} from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";
import { serverUrl } from "../lib/server-url.js";

const RolesTab = lazy(() => import("./RolesTab.js").then((mod) => ({ default: mod.RolesTab })));
const MembersTab = lazy(() =>
  import("./MembersTab.js").then((mod) => ({ default: mod.MembersTab })),
);
const BansTab = lazy(() => import("./BansTab.js").then((mod) => ({ default: mod.BansTab })));

type SettingsTab = "general" | "roles" | "members" | "bans";

const MAX_ICON_BYTES = 1024 * 1024;
const ALLOWED_ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function GuildSettingsDialog({
  open,
  onClose,
  guild,
  isOwner,
}: {
  open: boolean;
  onClose: () => void;
  guild: GuildJson;
  isOwner: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(guild.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmDeleteText, setConfirmDeleteText] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [, navigate] = useLocation();

  const permissions = useRealtime((s) => selfGuildPermissions(s, guild.id));
  const canManageRoles = isOwner || hasPermission(permissions, Permission.MANAGE_ROLES);
  const canBan = isOwner || hasPermission(permissions, Permission.BAN_MEMBERS);
  const canManageMembers =
    isOwner || canManageRoles || canBan || hasPermission(permissions, Permission.KICK_MEMBERS);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setName(guild.name);
      setError(null);
      setConfirmingDelete(false);
      setConfirmDeleteText("");
      setTab("general");
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, guild.name]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    const parsed = guildNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "This name is not valid.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const updated = await updateGuild(session.apiClient, guild.id, { name: parsed.data });
      realtimeStore.getState().applyDispatch({ t: "GUILD_UPDATE", d: updated });
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function handleIconChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!ALLOWED_ICON_TYPES.has(file.type)) {
      setError("The icon must be a PNG, JPEG or WEBP image.");
      return;
    }
    if (file.size > MAX_ICON_BYTES) {
      setError("The icon must be at most 1 MB.");
      return;
    }
    try {
      const updated = await uploadGuildIcon(session.apiClient, guild.id, file);
      realtimeStore.getState().applyDispatch({ t: "GUILD_UPDATE", d: updated });
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function handleRemoveIcon() {
    try {
      const updated = await removeGuildIcon(session.apiClient, guild.id);
      realtimeStore.getState().applyDispatch({ t: "GUILD_UPDATE", d: updated });
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function handleDelete() {
    if (confirmDeleteText !== guild.name) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await deleteGuild(session.apiClient, guild.id);
      onClose();
      navigate("/app");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  const tabs: Array<{ id: SettingsTab; label: string; hidden?: boolean }> = [
    { id: "general", label: "General" },
    { id: "roles", label: "Roles", hidden: !canManageRoles },
    { id: "members", label: "Members", hidden: !canManageMembers },
    { id: "bans", label: "Bans", hidden: !canBan },
  ];

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      // No "flex" (or other display-changing) class here: the browser's
      // own `dialog:not([open]) { display: none }` rule only wins while
      // an author style does not set `display` at all, so a display
      // utility on the <dialog> itself would keep it visible, and
      // clickable, even while closed. The flex layout lives on the
      // wrapper div just inside instead.
      className="w-full max-w-3xl overflow-hidden p-0"
      style={{ height: "min(38rem, 85vh)" }}
      aria-label="Server settings"
    >
      <div className="flex h-full min-h-0">
        <nav className="flex w-40 flex-shrink-0 flex-col gap-0.5 border-r p-3 border-line">
          {tabs
            .filter((t) => !t.hidden)
            .map((t) => (
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

        <div className="flex min-h-0 flex-1 flex-col p-6">
          {tab === "general" && (
            <>
              <h2 className="mb-4 text-lg font-semibold">Server settings</h2>

              <div className="mb-4 flex items-center gap-3">
                {guild.iconKey ? (
                  <img
                    src={serverUrl(`/api/v1/icons/${guild.id}/${guild.iconKey}`)}
                    alt=""
                    className="h-14 w-14 rounded-[14px] object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-[14px] border border-line-strong bg-hover" />
                )}
                <div className="flex flex-col gap-1">
                  <label className="cursor-pointer text-sm link">
                    Change icon
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      onChange={handleIconChange}
                    />
                  </label>
                  {guild.iconKey && (
                    <button
                      type="button"
                      onClick={handleRemoveIcon}
                      className="text-left text-sm link"
                    >
                      Remove icon
                    </button>
                  )}
                </div>
              </div>

              <form onSubmit={handleSave}>
                <label htmlFor="guild-settings-name" className="mb-1 block text-sm font-medium">
                  Server name
                </label>
                <input
                  id="guild-settings-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="field mb-4 w-full px-3 py-2 text-sm"
                />
                {error && (
                  <p role="alert" className="mb-4 text-sm text-danger-text">
                    {error}
                  </p>
                )}
                <div className="flex justify-between gap-2">
                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(true)}
                      className="btn btn-danger-ghost"
                    >
                      Delete server
                    </button>
                  )}
                  <div className="ml-auto flex gap-2">
                    <button type="button" onClick={onClose} className="btn btn-ghost">
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={pending}
                      className="btn btn-primary"
                    >
                      {pending ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              </form>

              {confirmingDelete && (
                <div className="mt-4 border-t border-line pt-4">
                  <p className="mb-2 text-sm">
                    Deleting this server cannot be undone. Type <strong>{guild.name}</strong> to
                    confirm.
                  </p>
                  <input
                    aria-label={`Type ${guild.name} to confirm deletion`}
                    value={confirmDeleteText}
                    onChange={(e) => setConfirmDeleteText(e.target.value)}
                    className="field mb-3 w-full px-3 py-2 text-sm"
                  />
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
                      disabled={pending || confirmDeleteText !== guild.name}
                      onClick={handleDelete}
                      className="btn btn-danger"
                    >
                      {pending ? "Deleting..." : "Delete server"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "roles" && canManageRoles && (
            <Suspense fallback={<p className="text-sm">Loading...</p>}>
              <RolesTab guildId={guild.id} />
            </Suspense>
          )}

          {tab === "members" && canManageMembers && (
            <Suspense fallback={<p className="text-sm">Loading...</p>}>
              <MembersTab guildId={guild.id} />
            </Suspense>
          )}

          {tab === "bans" && canBan && (
            <Suspense fallback={<p className="text-sm">Loading...</p>}>
              <BansTab guildId={guild.id} />
            </Suspense>
          )}
        </div>
      </div>
    </dialog>
  );
}
