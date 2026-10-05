// The search box of the chat header. Enter opens the results panel. The
// panel and the search code load only then, to keep the main bundle small.
import { lazy, Suspense, useState } from "react";
import { SearchIcon } from "./icons.js";

const SearchPanel = lazy(() => import("./SearchPanel.js"));

export function SearchBox({ guildId }: { guildId: string | null }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  return (
    <div className="ml-auto shrink-0 px-2">
      <div className="relative">
        <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          aria-label="Search messages"
          placeholder="Search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && text.trim()) {
              setQuery(text.trim());
            } else if (event.key === "Escape") {
              setQuery(null);
            }
          }}
          className="field w-52 py-1 pl-8 text-[13px]"
        />
      </div>
      {query !== null && (
        <Suspense fallback={null}>
          <SearchPanel query={query} guildId={guildId} onClose={() => setQuery(null)} />
        </Suspense>
      )}
    </div>
  );
}
