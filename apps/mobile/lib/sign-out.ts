import { choose, confirm } from "@/components/ui";
import { type Draft, loadDoc, pendingDrafts, type Sql } from "./doc-store";
import { docMarkdown, shareMarkdown } from "./export";
import { sqlOf, useSession } from "./session";

/** Share every unsynced draft as one Markdown file (works offline). */
export async function exportDrafts(sql: Sql, drafts: Draft[]): Promise<void> {
  const parts = await Promise.all(drafts.map(async (d) => docMarkdown(await loadDoc(sql, d.pageId), d.title)));
  await shareMarkdown(drafts.length === 1 ? drafts[0]!.title || "Draft" : "Unsynced drafts", parts.join("\n\n---\n\n"));
}

/**
 * Sign out with a warning about unsynced drafts (offering export), then wipe this account's local data.
 * Resolves true only when the account was actually signed out.
 */
export function useSignOut() {
  const { account, signOutAndWipe } = useSession();
  return async (): Promise<boolean> => {
    if (!account) return false;
    const sql = sqlOf(account);
    const drafts = await pendingDrafts(sql);
    if (drafts.length) {
      const n = drafts.length === 1 ? "1 page has" : `${drafts.length} pages have`;
      const choice = await choose(
        `${n} edits that haven't synced`,
        [
          { label: "Export drafts as Markdown", value: "export" as const },
          { label: "Sign out and delete drafts", value: "wipe" as const, destructive: true },
        ],
        "Signing out deletes this account's data from this device, including these edits.",
      );
      if (choice === "export") await exportDrafts(sql, drafts);
      if (choice !== "wipe") return false;
    } else if (!(await confirm("Sign out?", "Your pages and offline copies are removed from this device.", "Sign out"))) return false;
    await signOutAndWipe();
    return true;
  };
}
