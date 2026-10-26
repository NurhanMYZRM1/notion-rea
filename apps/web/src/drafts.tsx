import { useEffect, useState } from "react";
import { download, errorMessage } from "./api";
import { type DocMeta, hasPending, listDocs } from "./sync/cache-db";
import { toast } from "./ui";

/** One Markdown file with every unsynced draft (browsers block bursts of downloads). Yjs loads lazily. */
export async function exportDrafts(docs: DocMeta[]) {
  const { draftMarkdown } = await import("./sync/idb-store");
  const parts: string[] = [];
  for (const d of docs) parts.push(`# ${d.title || "Untitled"}\n\n${await draftMarkdown(d.key)}`);
  download(`unsynced-drafts-${new Date().toISOString().slice(0, 10)}.md`, parts.join("\n\n---\n\n"));
}

/** Shown where the editor is unreachable (e.g. after losing access): drafts on this device can still be exported. */
export function UnsyncedDrafts() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  useEffect(() => {
    listDocs()
      .then((all) => setDocs(all.filter(hasPending)))
      .catch(() => {});
  }, []);
  if (!docs.length) return null;
  return (
    <div className="banner banner-warn" role="region" aria-label="Unsynced drafts">
      <span>
        {docs.length} page{docs.length === 1 ? " has" : "s have"} changes that never reached the server. They're kept on this device.
      </span>
      <button type="button" className="btn btn-small" onClick={() => void exportDrafts(docs).catch((err) => toast(errorMessage(err), "error"))}>
        Export drafts (Markdown)
      </button>
    </div>
  );
}
