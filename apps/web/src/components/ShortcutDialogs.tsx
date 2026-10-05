// The two dialogs of the keyboard shortcuts: the quick switcher and the help
// list. They load only when a shortcut opens them.
import { useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "wouter/use-browser-location";
import { dmDisplayName, sortDmChannels } from "@mortium/client-core";
import { realtimeStore } from "../lib/realtime.js";
import { dmPath } from "../lib/dms.js";
import { fuzzyFilter } from "../lib/fuzzy.js";
import { SHORTCUT_HELP, isMacPlatform, keysLabel, orderedTextChannelIds } from "../lib/shortcuts.js";

const dialogStyle = {
  borderColor: "var(--color-border)",
  backgroundColor: "var(--color-bg-sidebar)",
  color: "var(--color-text-primary)",
};

/** Open a native modal dialog when it mounts. */
function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return { ref };
}

interface SwitchTarget {
  key: string;
  label: string;
  hint: string;
  path: string;
}

function buildTargets(currentGuildId: string | null): SwitchTarget[] {
  const state = realtimeStore.getState();
  const guildIds = Object.keys(state.guilds).sort((a, b) => (a === currentGuildId ? -1 : b === currentGuildId ? 1 : 0));
  const channels: SwitchTarget[] = [];
  const servers: SwitchTarget[] = [];
  for (const guildId of guildIds) {
    const guild = state.guilds[guildId]!;
    const ids = orderedTextChannelIds(state.channelIdsByGuild[guildId] ?? [], state.channels);
    for (const id of ids) {
      channels.push({ key: `c:${id}`, label: `#${state.channels[id]!.name}`, hint: guild.name, path: `/app/${guildId}/${id}` });
    }
    servers.push({ key: `g:${guildId}`, label: guild.name, hint: "Server", path: ids[0] ? `/app/${guildId}/${ids[0]}` : `/app/${guildId}` });
  }
  const directs = sortDmChannels(Object.values(state.privateChannels)).map((channel) => ({
    key: `d:${channel.id}`,
    label: dmDisplayName(channel, state.selfUserId),
    hint: "Direct message",
    path: dmPath(channel.id),
  }));
  return [...channels, ...directs, ...servers];
}

export function QuickSwitcher({ guildId, onClose }: { guildId: string | null; onClose: () => void }) {
  const { ref } = useModal();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const targets = useMemo(() => buildTargets(guildId), [guildId]);
  const results = useMemo(() => fuzzyFilter(query, targets, (t) => `${t.label} ${t.hint}`, 10), [query, targets]);
  const current = Math.min(active, results.length - 1);

  function choose(target: SwitchTarget | undefined): void {
    if (!target) return;
    ref.current?.close();
    navigate(target.path);
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((value) => (Math.min(value, results.length - 1) + step + results.length) % Math.max(results.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[current]);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label="Quick switcher"
      className="mt-24 w-full max-w-md rounded-lg border p-3"
      style={dialogStyle}
    >
      <input
        autoFocus
        role="combobox"
        aria-label="Go to a channel, a direct message or a server"
        aria-expanded="true"
        aria-controls="quick-switcher-list"
        aria-activedescendant={results[current] ? `quick-switcher-${results[current]!.key}` : undefined}
        placeholder="Go to a channel, a direct message or a server"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="field mb-2 w-full px-3 py-2 text-sm"
      />
      <ul id="quick-switcher-list" role="listbox" aria-label="Results" className="max-h-72 overflow-y-auto">
        {results.map((target, index) => (
          <li
            key={target.key}
            id={`quick-switcher-${target.key}`}
            role="option"
            aria-selected={index === current}
            data-switcher-result={target.label}
            onClick={() => choose(target)}
            onMouseMove={() => setActive(index)}
            className="flex cursor-pointer items-center justify-between gap-2 rounded px-3 py-2 text-sm"
            style={{ backgroundColor: index === current ? "var(--color-bg-main)" : "transparent" }}
          >
            <span className="truncate">{target.label}</span>
            <span className="shrink-0 text-xs text-muted">
              {target.hint}
            </span>
          </li>
        ))}
      </ul>
      <div role="status" className="px-3 pt-1 text-xs text-muted">
        {results.length === 0 ? "No match." : ""}
      </div>
    </dialog>
  );
}

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const { ref } = useModal();
  const mac = isMacPlatform();
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label="Keyboard shortcuts"
      className="w-full max-w-md rounded-lg border p-6"
      style={dialogStyle}
    >
      <h2 className="mb-4 text-lg font-semibold">Keyboard shortcuts</h2>
      <p className="mb-3 text-xs text-muted">
        Only Quick switcher and Escape work while the focus is in a text field.
      </p>
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {SHORTCUT_HELP.map((row) => (
          <div key={row.id} className="contents">
            <dt className="font-mono text-xs">{keysLabel(row.keys, mac)}</dt>
            <dd>{row.description}</dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="btn btn-primary"
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
