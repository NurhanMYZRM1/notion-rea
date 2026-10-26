import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { api, errorMessage } from "../api";
import { navigate } from "../router";
import { Dialog, useDebounced, useOnline } from "../ui";

/** Server snippets mark matches with [ and ]. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("[") && p.endsWith("]") ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

export function SearchDialog({ ws, onClose }: { ws: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const query = useDebounced(q.trim(), 220);
  const online = useOnline();
  const listId = useId();
  const res = useQuery({
    queryKey: ["search", ws, query],
    queryFn: () => api.search(ws, query),
    enabled: query.length > 0 && online,
    staleTime: 5_000,
    gcTime: 60_000,
  });
  const results = query ? (res.data?.results ?? []) : [];
  const open = (i: number) => {
    const hit = results[i];
    if (!hit) return;
    onClose();
    navigate(`/p/${hit.pageId}`);
  };
  const optId = (i: number) => `${listId}-${i}`;

  return (
    <Dialog title="Search" onClose={onClose} className="search-dialog">
      <input
        data-autofocus
        type="search"
        className="search-input"
        role="combobox"
        aria-label="Search pages"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={results.length ? optId(Math.min(active, results.length - 1)) : undefined}
        placeholder="Search pages and content…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter") open(Math.min(active, results.length - 1));
          else return;
          e.preventDefault();
        }}
      />
      <div className="search-state" aria-live="polite">
        {!online
          ? "Search needs a connection."
          : !query
            ? "Type to search titles and page text."
            : res.isFetching && !res.data
              ? "Searching…"
              : res.isError
                ? `Search failed: ${errorMessage(res.error)}`
                : results.length === 0
                  ? "No results."
                  : `${results.length} result${results.length === 1 ? "" : "s"}`}
      </div>
      <ul id={listId} role="listbox" aria-label="Search results" className="search-results">
        {results.map((hit, i) => (
          <li
            key={hit.pageId}
            id={optId(i)}
            role="option"
            aria-selected={i === active}
            className={i === active ? "is-active" : ""}
            onMouseEnter={() => setActive(i)}
            onClick={() => open(i)}
          >
            <span className="search-title">{hit.title || "Untitled"}</span>
            {hit.snippet && (
              <span className="search-snippet">
                <Snippet text={hit.snippet} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
