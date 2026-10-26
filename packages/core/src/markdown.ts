import { Lexer, type Token, type Tokens } from "marked";
import { inlineText, type PMMark, type PMNode } from "./blocks";

/** Items that could not be represented exactly; shown to the user after import/export. */
export interface ConversionReport {
  warnings: string[];
}

const SAFE_URL = /^(https?:|mailto:|\/api\/attachments\/|\/p\/[^/?#]+$)/i;

// ---------- Export: ProseMirror JSON -> Markdown ----------

export function toMarkdown(doc: PMNode, report: ConversionReport = { warnings: [] }): string {
  return blocksToMd(doc.content ?? [], report).join("\n\n") + "\n";
}

function blocksToMd(nodes: PMNode[], report: ConversionReport): string[] {
  return nodes.map((n) => blockToMd(n, report)).filter((s) => s !== null) as string[];
}

function indent(text: string, prefix: string, first = prefix): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? first : line ? prefix : prefix.trimEnd()) + line)
    .join("\n");
}

function listItemToMd(item: PMNode, marker: string, report: ConversionReport): string {
  const [first, ...rest] = item.content ?? [];
  const head = first ? blockToMd(first, report) ?? "" : "";
  const body = [head, ...blocksToMd(rest, report)].join("\n\n");
  return indent(body, " ".repeat(marker.length), marker);
}

function blockToMd(node: PMNode, report: ConversionReport): string | null {
  switch (node.type) {
    case "paragraph":
      return inlineToMd(node.content ?? [], report);
    case "heading":
      return "#".repeat(Math.min(3, Number(node.attrs?.level ?? 1))) + " " + inlineToMd(node.content ?? [], report);
    case "bulletList":
      return (node.content ?? []).map((li) => listItemToMd(li, "- ", report)).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? []).map((li, i) => listItemToMd(li, `${start + i}. `, report)).join("\n");
    }
    case "taskList":
      return (node.content ?? [])
        .map((li) => listItemToMd(li, li.attrs?.checked ? "- [x] " : "- [ ] ", report))
        .join("\n");
    case "blockquote":
      return indent(blocksToMd(node.content ?? [], report).join("\n\n"), "> ");
    case "codeBlock": {
      const code = inlineText(node);
      const fence = code.includes("```") ? "````" : "```";
      return `${fence}${String(node.attrs?.language ?? "")}\n${code}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    case "image":
      return `![${escapeText(String(node.attrs?.alt ?? ""))}](${String(node.attrs?.src ?? "")})`;
    case "fileAttachment":
      return `[${escapeText(String(node.attrs?.name ?? "file"))}](${String(node.attrs?.src ?? "")})`;
    case "childPage":
      return `[${escapeText(String(node.attrs?.title || "Untitled"))}](/p/${encodeURIComponent(String(node.attrs?.pageId ?? ""))})`;
    case "details": {
      const [summary, content] = node.content ?? [];
      const inner = blocksToMd(content?.content ?? [], report).join("\n\n");
      return `<details>\n<summary>${escapeHtml(inlineText(summary ?? { type: "x" }))}</summary>\n\n${inner}\n\n</details>`;
    }
    default:
      report.warnings.push(`Unsupported block "${node.type}" exported as plain text.`);
      return inlineText(node) || null;
  }
}

function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]<>#~|])/g, "\\$1").replace(/^(\d+)\./gm, "$1\\.").replace(/^([-+]) /gm, "\\$1 ");
}
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const MARK_ORDER = ["link", "bold", "italic", "strike", "code"];

function inlineToMd(nodes: PMNode[], report: ConversionReport): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "hardBreak") {
      out += "\\\n";
      continue;
    }
    if (n.type !== "text") {
      report.warnings.push(`Unsupported inline "${n.type}" exported as text.`);
      out += inlineText(n);
      continue;
    }
    const marks = [...(n.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    let text = marks.some((m) => m.type === "code") ? codeSpan(n.text ?? "") : escapeText(n.text ?? "");
    for (const m of marks.reverse()) {
      if (m.type === "bold") text = `**${text}**`;
      else if (m.type === "italic") text = `_${text}_`;
      else if (m.type === "strike") text = `~~${text}~~`;
      else if (m.type === "link") text = `[${text}](${String(m.attrs?.href ?? "")})`;
      else if (m.type === "underline") report.warnings.push("Underline has no Markdown form and was dropped.");
    }
    out += text;
  }
  return out;
}

function codeSpan(text: string): string {
  const ticks = text.includes("`") ? "``" : "`";
  return `${ticks}${ticks.length > 1 ? " " : ""}${text}${ticks.length > 1 ? " " : ""}${ticks}`;
}

// ---------- Import: Markdown -> ProseMirror JSON ----------

const MAX_IMPORT_BYTES = 2_000_000;

export function fromMarkdown(markdown: string, report: ConversionReport = { warnings: [] }): PMNode {
  if (new TextEncoder().encode(markdown).length > MAX_IMPORT_BYTES) throw new Error("Markdown file is larger than 2 MB");
  const tokens = new Lexer({ gfm: true }).lex(markdown.replace(/\r\n?/g, "\n"));
  const content = tokensToBlocks(tokens, report);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function tokensToBlocks(tokens: Token[], report: ConversionReport): PMNode[] {
  const out: PMNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.type) {
      case "space":
        break;
      case "heading": {
        const h = t as Tokens.Heading;
        if (h.depth > 3) report.warnings.push(`Heading level ${h.depth} became level 3.`);
        out.push({ type: "heading", attrs: { level: Math.min(3, h.depth) }, content: inline(h.tokens, report) });
        break;
      }
      case "paragraph":
      case "text": {
        const p = t as Tokens.Paragraph;
        const children = p.tokens ?? [{ type: "text", raw: p.text, text: p.text } as Tokens.Text];
        const only = children.filter((c) => c.type !== "space");
        if (only.length === 1 && only[0]!.type === "image") {
          const img = only[0] as Tokens.Image;
          if (img.href.startsWith("/api/attachments/")) {
            out.push({ type: "image", attrs: { src: img.href, alt: img.text } });
            break;
          }
          report.warnings.push(`External image ${truncate(img.href)} became a link; upload it as an attachment.`);
        }
        out.push({ type: "paragraph", content: inline(children, report) });
        break;
      }
      case "list": {
        const list = t as Tokens.List;
        const isTask = list.items.length > 0 && list.items.every((it) => it.task);
        if (!isTask && list.items.some((it) => it.task)) report.warnings.push("Mixed task/bullet list imported as bullets.");
        const type = isTask ? "taskList" : list.ordered ? "orderedList" : "bulletList";
        const itemType = isTask ? "taskItem" : "listItem";
        const items = list.items.map((it) => {
          const blocks = tokensToBlocks(it.tokens.filter((x) => x.type !== "checkbox"), report);
          if (!blocks.length || blocks[0]!.type !== "paragraph") blocks.unshift({ type: "paragraph" });
          return { type: itemType, attrs: isTask ? { checked: !!it.checked } : undefined, content: blocks } as PMNode;
        });
        const node: PMNode = { type, content: items };
        if (list.ordered && typeof list.start === "number" && list.start !== 1) node.attrs = { start: list.start };
        out.push(node);
        break;
      }
      case "blockquote": {
        const content = tokensToBlocks((t as Tokens.Blockquote).tokens, report);
        out.push({ type: "blockquote", content: content.length ? content : [{ type: "paragraph" }] });
        break;
      }
      case "code": {
        const c = t as Tokens.Code;
        out.push({
          type: "codeBlock",
          attrs: c.lang ? { language: c.lang.slice(0, 40) } : undefined,
          content: c.text ? [{ type: "text", text: c.text }] : undefined,
        });
        break;
      }
      case "hr":
        out.push({ type: "horizontalRule" });
        break;
      case "html": {
        const consumed = parseDetails(tokens, i, report, out);
        if (consumed > 0) {
          i += consumed - 1;
          break;
        }
        report.warnings.push("Raw HTML imported as plain text.");
        const text = (t as Tokens.HTML).text.trim();
        if (text) out.push({ type: "paragraph", content: [{ type: "text", text }] });
        break;
      }
      case "table": {
        const table = t as Tokens.Table;
        report.warnings.push("Table imported as one paragraph per row (tables are not supported).");
        for (const row of [table.header, ...table.rows]) {
          const text = row.map((cell) => cell.text).join(" | ");
          if (text) out.push({ type: "paragraph", content: [{ type: "text", text }] });
        }
        break;
      }
      default:
        report.warnings.push(`Unsupported Markdown "${t.type}" imported as text.`);
        if ("text" in t && typeof t.text === "string" && t.text)
          out.push({ type: "paragraph", content: [{ type: "text", text: t.text }] });
    }
  }
  return out;
}

/** `<details><summary>…</summary> … </details>` → toggle block. Returns tokens consumed (0 = not a toggle). */
function parseDetails(tokens: Token[], start: number, report: ConversionReport, out: PMNode[]): number {
  const first = tokens[start] as Tokens.HTML;
  const open = /^<details[^>]*>\s*(?:<summary>([\s\S]*?)<\/summary>)?/i.exec(first.text.trim());
  if (!open) return 0;
  const inner: Token[] = [];
  let end = start + 1;
  let closed = /<\/details>\s*$/i.test(first.text.trim());
  for (; !closed && end < tokens.length; end++) {
    const tok = tokens[end]!;
    if (tok.type === "html" && /^<\/details>/i.test((tok as Tokens.HTML).text.trim())) {
      closed = true;
      break;
    }
    inner.push(tok);
  }
  if (!closed) report.warnings.push("Unclosed <details> imported as a toggle up to the end of the file.");
  const summary = decodeEntities((open[1] ?? "").replace(/<[^>]+>/g, "").trim());
  const content = tokensToBlocks(inner, report);
  out.push({
    type: "details",
    content: [
      { type: "detailsSummary", content: summary ? [{ type: "text", text: summary }] : undefined },
      { type: "detailsContent", content: content.length ? content : [{ type: "paragraph" }] },
    ],
  });
  return end - start + 1;
}

function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

function truncate(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

function inline(tokens: Token[] | undefined, report: ConversionReport, marks: PMMark[] = []): PMNode[] {
  const out: PMNode[] = [];
  const text = (value: string, extra: PMMark[] = marks) => {
    if (!value) return;
    const node: PMNode = { type: "text", text: value };
    if (extra.length) node.marks = extra;
    out.push(node);
  };
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inline(tt.tokens, report, marks));
        else text(decodeEntities(tt.text));
        break;
      }
      case "escape":
        text((t as Tokens.Escape).text);
        break;
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, report, [...marks, { type: "bold" }]));
        break;
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, report, [...marks, { type: "italic" }]));
        break;
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, report, [...marks, { type: "strike" }]));
        break;
      case "codespan":
        text(decodeEntities((t as Tokens.Codespan).text), [...marks, { type: "code" }]);
        break;
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "link": {
        const l = t as Tokens.Link;
        if (SAFE_URL.test(l.href)) out.push(...inline(l.tokens, report, [...marks, { type: "link", attrs: { href: l.href } }]));
        else {
          report.warnings.push(`Link with unsupported URL scheme kept as text: ${truncate(l.href)}`);
          out.push(...inline(l.tokens, report, marks));
        }
        break;
      }
      case "image": {
        const img = t as Tokens.Image;
        if (SAFE_URL.test(img.href)) text(img.text || img.href, [...marks, { type: "link", attrs: { href: img.href } }]);
        else text(img.text);
        break;
      }
      case "html":
        if (/^<br\s*\/?>$/i.test((t as Tokens.HTML).text)) out.push({ type: "hardBreak" });
        else text((t as Tokens.HTML).text);
        break;
      default:
        if ("text" in t && typeof t.text === "string") text(t.text);
    }
  }
  return out;
}
