// Server settings > Roles: the role list (drag-and-drop and keyboard
// reorder), and an editor for the selected role's name, color, hoist,
// mentionable and grouped permission toggles. Loaded only when the Roles
// tab opens (see GuildSettingsDialog), per the bundle-size rule in
// CLAUDE.md.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_ROLES_PER_GUILD,
  Permission,
  type PermissionName,
  type RoleJson,
} from "@mortium/shared";
import {
  buildSelfContext,
  canManageRole,
  createRole,
  deleteRole,
  reorderRoles,
  updateRole,
} from "@mortium/client-core";
import type { RealtimeState } from "@mortium/client-core";
import { session } from "../lib/session.js";
import { describeError } from "../lib/errors.js";
import { realtimeStore } from "../lib/realtime.js";
import { useRealtime } from "../lib/useRealtime.js";
import { ChevronDownIcon, ChevronUpIcon } from "./icons.js";
import {
  PERMISSION_GROUPS,
  PERMISSION_DESCRIPTIONS,
  permissionLabel,
} from "../lib/permission-meta.js";

const SWATCHES = [
  0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6,
  0x99aab5,
];

function toHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function fromHex(hex: string): number | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  return parseInt(match[1]!, 16);
}

interface Draft {
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: bigint;
}

function draftFromRole(role: RoleJson): Draft {
  return {
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: BigInt(role.permissions),
  };
}

function isDirty(draft: Draft, role: RoleJson): boolean {
  return (
    draft.name !== role.name ||
    draft.color !== role.color ||
    draft.hoist !== role.hoist ||
    draft.mentionable !== role.mentionable ||
    draft.permissions !== BigInt(role.permissions)
  );
}

export function RolesTab({ guildId }: { guildId: string }) {
  const guild = useRealtime((s) => s.guilds[guildId]);
  const selfMember = useRealtime((s) => s.selfMemberByGuild[guildId]);
  const selfUserId = useRealtime((s) => s.selfUserId);
  const roles = useRealtime((s) => s.rolesByGuild[guildId]);

  const context = useMemo(() => {
    if (!guild || !selfMember || !roles || !selfUserId) return null;
    const fakeState = {
      guilds: { [guildId]: guild },
      selfMemberByGuild: { [guildId]: selfMember },
      rolesByGuild: { [guildId]: roles },
      selfUserId,
    } as unknown as RealtimeState;
    return buildSelfContext(fakeState, guildId);
  }, [guild, selfMember, roles, selfUserId, guildId]);

  const orderedRoles = useMemo(
    () => [...(roles ?? [])].sort((a, b) => b.position - a.position),
    [roles],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dragIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedId && orderedRoles.length > 0) {
      setSelectedId(orderedRoles[0]!.id);
    }
  }, [orderedRoles, selectedId]);

  const selectedRole = orderedRoles.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    const role = orderedRoles.find((r) => r.id === selectedId) ?? null;
    setDraft(role ? draftFromRole(role) : null);
    setError(null);
    setConfirmingDelete(false);
    // Reset only when the selected role identity changes, not on every
    // remote update to its fields (that would clobber an in-progress edit).
  }, [selectedId]);

  const dirty = selectedRole && draft ? isDirty(draft, selectedRole) : false;
  const canEditSelected = selectedRole ? canManageRole(context, selectedRole) : false;
  const grantableMask = context?.guildPermissions ?? 0n;
  const isOwner = context?.isOwner ?? false;

  async function handleCreate() {
    setError(null);
    try {
      const created = await createRole(session.apiClient, guildId, {});
      realtimeStore
        .getState()
        .applyDispatch({ t: "GUILD_ROLE_CREATE", d: { guildId, role: created } });
      setSelectedId(created.id);
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function handleSave() {
    if (!selectedRole || !draft) return;
    setPending(true);
    setError(null);
    try {
      const updated = await updateRole(session.apiClient, guildId, selectedRole.id, {
        name: draft.name,
        color: draft.color,
        hoist: draft.hoist,
        mentionable: draft.mentionable,
        permissions: draft.permissions.toString(),
      });
      realtimeStore
        .getState()
        .applyDispatch({ t: "GUILD_ROLE_UPDATE", d: { guildId, role: updated } });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  function handleReset() {
    if (selectedRole) setDraft(draftFromRole(selectedRole));
  }

  async function handleDelete() {
    if (!selectedRole) return;
    setPending(true);
    setError(null);
    try {
      await deleteRole(session.apiClient, guildId, selectedRole.id);
      realtimeStore
        .getState()
        .applyDispatch({ t: "GUILD_ROLE_DELETE", d: { guildId, roleId: selectedRole.id } });
      setSelectedId(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function applyOrder(nextOrder: RoleJson[]) {
    const previous = orderedRoles;
    const nonEveryone = nextOrder.filter((role) => role.id !== guildId);
    const entries = nonEveryone.map((role, index) => ({
      id: role.id,
      position: nonEveryone.length - index,
    }));
    // Optimistic local update.
    for (const entry of entries) {
      const role = nextOrder.find((r) => r.id === entry.id);
      if (role) {
        realtimeStore.getState().applyDispatch({
          t: "GUILD_ROLE_UPDATE",
          d: { guildId, role: { ...role, position: entry.position } },
        });
      }
    }
    try {
      await reorderRoles(session.apiClient, guildId, entries);
    } catch (err) {
      setError(describeError(err));
      // Rollback to the previous known positions.
      for (const role of previous) {
        realtimeStore.getState().applyDispatch({ t: "GUILD_ROLE_UPDATE", d: { guildId, role } });
      }
    }
  }

  function moveRole(roleId: string, direction: "up" | "down") {
    const index = orderedRoles.findIndex((r) => r.id === roleId);
    if (index === -1) return;
    const swapWith = direction === "up" ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= orderedRoles.length) return;
    if (orderedRoles[swapWith]!.id === guildId || orderedRoles[index]!.id === guildId) return;
    const next = [...orderedRoles];
    [next[index], next[swapWith]] = [next[swapWith]!, next[index]!];
    void applyOrder(next);
  }

  function handleDrop(targetId: string) {
    const draggedId = dragIdRef.current;
    dragIdRef.current = null;
    if (!draggedId || draggedId === targetId || draggedId === guildId || targetId === guildId)
      return;
    const next = [...orderedRoles];
    const fromIndex = next.findIndex((r) => r.id === draggedId);
    const toIndex = next.findIndex((r) => r.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    void applyOrder(next);
  }

  function togglePermission(name: PermissionName) {
    if (!draft || !canEditSelected) return;
    const bit = Permission[name];
    const grantable = isOwner || (grantableMask & bit) !== 0n;
    if (!grantable) return;
    setDraft({
      ...draft,
      permissions:
        (draft.permissions & bit) !== 0n ? draft.permissions & ~bit : draft.permissions | bit,
    });
  }

  if (!guild || !roles) {
    return <p className="p-4 text-sm text-muted">Loading roles...</p>;
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex w-52 flex-shrink-0 flex-col gap-1 overflow-y-auto">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={roles.length >= MAX_ROLES_PER_GUILD}
          className="btn btn-primary mb-2 justify-start px-2.5 py-1.5"
        >
          + Create role
        </button>
        <ul aria-label="Roles" className="flex flex-col gap-0.5">
          {orderedRoles.map((role, index) => {
            const isEveryone = role.id === guildId;
            return (
              <li
                key={role.id}
                draggable={!isEveryone}
                onDragStart={() => {
                  dragIdRef.current = role.id;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(role.id);
                }}
                data-active={role.id === selectedId}
                className="nav-row group flex h-8 items-center gap-1 rounded-lg px-2"
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(role.id)}
                  className="flex flex-1 items-center gap-2 truncate text-left text-sm"
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: toHex(role.color) }}
                  />
                  <span className="truncate">{isEveryone ? "@everyone" : role.name}</span>
                </button>
                {!isEveryone && (
                  <span className="hidden gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      aria-label={`Move ${role.name} up`}
                      disabled={index === 0}
                      onClick={() => moveRole(role.id, "up")}
                      className="icon-btn h-6 w-6"
                    >
                      <ChevronUpIcon size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${role.name} down`}
                      disabled={index >= orderedRoles.length - 2}
                      onClick={() => moveRole(role.id, "down")}
                      className="icon-btn h-6 w-6"
                    >
                      <ChevronDownIcon size={14} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
        {!selectedRole || !draft ? (
          <p className="text-sm text-muted">Select a role to edit it.</p>
        ) : (
          <>
            {!canEditSelected && (
              <p className="mb-3 rounded-lg bg-hover px-3 py-2 text-sm text-muted">
                Your highest role must be above this role to edit it.
              </p>
            )}
            <div className="mb-4 flex items-end gap-3">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-sm font-medium">Role name</span>
                <input
                  value={draft.name}
                  disabled={selectedRole.id === guildId || !canEditSelected}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="field px-3 py-2 text-sm"
                />
              </label>
            </div>

            <fieldset className="mb-4" disabled={!canEditSelected}>
              <legend className="mb-1 text-sm font-medium">Color</legend>
              <div className="mb-2 flex gap-1">
                {SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={`Set color ${toHex(swatch)}`}
                    onClick={() => setDraft({ ...draft, color: swatch })}
                    className={`h-6 w-6 rounded-full ${draft.color === swatch ? "ring-2 ring-primary ring-offset-2 ring-offset-elevated" : ""}`}
                    style={{ backgroundColor: toHex(swatch) }}
                  />
                ))}
              </div>
              <input
                aria-label="Role color hex value"
                value={toHex(draft.color)}
                onChange={(e) => {
                  const parsed = fromHex(e.target.value);
                  if (parsed !== null) setDraft({ ...draft, color: parsed });
                }}
                className="field w-28 px-2 py-1 text-sm"
              />
            </fieldset>

            <label className="mb-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.hoist}
                disabled={!canEditSelected}
                onChange={(e) => setDraft({ ...draft, hoist: e.target.checked })}
              />
              Show members separately
            </label>
            <label className="mb-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.mentionable}
                disabled={!canEditSelected}
                onChange={(e) => setDraft({ ...draft, mentionable: e.target.checked })}
              />
              Allow anyone to @mention
            </label>

            <div className="flex flex-col gap-4">
              {PERMISSION_GROUPS.map((group) => (
                <fieldset key={group.label}>
                  <legend className="mb-1 eyebrow">{group.label}</legend>
                  <div className="flex flex-col gap-1.5">
                    {group.permissions.map((name) => {
                      const bit = Permission[name];
                      const checked = (draft.permissions & bit) !== 0n;
                      const grantable = isOwner || (grantableMask & bit) !== 0n;
                      const disabled = !canEditSelected || !grantable;
                      return (
                        <label
                          key={name}
                          className="flex items-start gap-2 text-sm"
                          title={
                            !grantable
                              ? "You cannot grant a permission you do not have."
                              : undefined
                          }
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => togglePermission(name)}
                            className="mt-0.5"
                          />
                          <span>
                            <span className="font-medium">{permissionLabel(name)}</span>
                            <span className="block text-xs text-muted">
                              {PERMISSION_DESCRIPTIONS[name]}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>

            {error && (
              <p role="alert" className="mt-4 text-sm text-danger-text">
                {error}
              </p>
            )}

            {selectedRole.id !== guildId && canEditSelected && (
              <div className="mt-4 border-t border-line pt-4">
                {!confirmingDelete ? (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    className="text-sm text-danger-text"
                  >
                    Delete role
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">Delete "{selectedRole.name}"?</span>
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(false)}
                      className="btn btn-ghost px-3 py-1"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void handleDelete()}
                      className="btn btn-danger px-2 py-1"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )}

            {dirty && (
              <div className="menu sticky bottom-0 mt-4 flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-sm">Careful — you have unsaved changes.</span>
                <div className="flex gap-2">
                  <button type="button" onClick={handleReset} className="btn btn-ghost">
                    Reset
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void handleSave()}
                    className="btn btn-primary px-3 py-1.5"
                  >
                    {pending ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
