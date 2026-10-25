import { FRAGMENT, toMarkdown, yToJSON } from "@workspace/core";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type * as Y from "yjs";

/** Same conversion the server uses for export.md, run on the local doc so it works offline. */
export function docMarkdown(doc: Y.Doc, title: string): string {
  const body = toMarkdown(yToJSON(doc.getXmlFragment(FRAGMENT)));
  return title.trim() ? `# ${title.trim()}\n\n${body}` : body;
}

/** Write Markdown to a cache file and open the system share sheet. */
export async function shareMarkdown(title: string, markdown: string): Promise<void> {
  const base = (title.trim() || "Untitled").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 80) || "Untitled";
  const file = new File(Paths.cache, `${base}.md`);
  if (file.exists) file.delete();
  file.create();
  await file.write(markdown);
  await Sharing.shareAsync(file.uri, { mimeType: "text/markdown", UTI: "net.daringfireball.markdown", dialogTitle: `Export “${base}”` });
}
