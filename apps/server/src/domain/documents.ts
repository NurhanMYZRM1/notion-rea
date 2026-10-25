import { type ConversionReport, fromMarkdown, type PageSummary, type PMNode, toMarkdown } from "@workspace/core";
import { AppError } from "../errors";
import { type Actor, audit, requirePageAccess } from "./access";
import { type EditOp, needsExpectedRevision, validateDoc } from "./doc-edits";
import { createPage, page } from "./pages";

export async function readDocument(env: Env, actor: Actor, pageId: string): Promise<{ doc: PMNode; revision: number }> {
  await requirePageAccess(env, actor, pageId, "read");
  return page(env, pageId).read(pageId);
}

export async function exportMarkdown(env: Env, actor: Actor, pageId: string): Promise<{ markdown: string; warnings: string[]; revision: number }> {
  const { doc, revision } = await readDocument(env, actor, pageId);
  const title = await env.DB.prepare("SELECT title FROM pages WHERE id = ?").bind(pageId).first<{ title: string }>();
  const report: ConversionReport = { warnings: [] };
  const body = toMarkdown(doc, report);
  return { markdown: `# ${title?.title || "Untitled"}\n\n${body}`, warnings: [...new Set(report.warnings)], revision };
}

/** Import Markdown as a new page. A leading `# Title` becomes the page title. */
export async function importMarkdown(
  env: Env,
  actor: Actor,
  workspaceId: string,
  input: { markdown: string; parentId: string | null; title?: string; id?: string },
): Promise<{ page: PageSummary; warnings: string[] }> {
  const report: ConversionReport = { warnings: [] };
  let markdown = input.markdown;
  let title = input.title;
  const heading = /^#\s+(.+)\n/.exec(markdown);
  if (!title && heading) {
    title = heading[1]!.trim();
    markdown = markdown.slice(heading[0].length);
  }
  let doc: PMNode;
  try {
    doc = validateDoc(fromMarkdown(markdown, report));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("invalid_input", (err as Error).message);
  }
  const summary = await createPage(env, actor, workspaceId, { parentId: input.parentId, title: (title ?? "Imported page").slice(0, 500), id: input.id }, doc);
  return { page: summary, warnings: [...new Set(report.warnings)] };
}

export async function editDocument(
  env: Env,
  actor: Actor,
  pageId: string,
  ops: EditOp[],
  expectedRevision: number | null,
) {
  const access = await requirePageAccess(env, actor, pageId, "write");
  if (needsExpectedRevision(ops) && expectedRevision === null) {
    throw new AppError("invalid_input", "replace, update_text and delete need expectedRevision (from the last read)");
  }
  const result = await page(env, pageId).edit(pageId, ops, expectedRevision, access.page.state);
  if ("error" in result) throw new AppError(result.error.code, result.error.message, result.error.details);
  if (result.changed) await audit(env, access, "document.edit", pageId, { ops: ops.map((o) => o.op) });
  return result;
}
