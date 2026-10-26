import * as Y from "yjs";

/**
 * Document model shared by the editor (Tiptap/ProseMirror), the server (page Durable Object, MCP)
 * and import/export. A page body is one Y.XmlFragment named `default`, encoded the same way
 * y-prosemirror / @tiptap/y-tiptap encode it: elements carry node attrs as attributes, text runs
 * are Y.XmlText with marks as formatting attributes `{ [markName]: markAttrs }`.
 */
export const FRAGMENT = "default";

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}

/** Node types that get a stable `id` attribute (Tiptap UniqueID uses the same list). */
export const ID_NODE_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "image",
  "fileAttachment",
  "childPage",
  "details",
] as const;

export const TEXTBLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock", "detailsSummary"]);
const LEAF_BLOCK_TYPES = new Set(["horizontalRule", "image", "fileAttachment", "childPage"]);

// ---------- Y <-> JSON ----------

export function yToJSON(fragment: Y.XmlFragment): PMNode {
  return { type: "doc", content: childrenToJSON(fragment) };
}

function childrenToJSON(parent: Y.XmlFragment | Y.XmlElement): PMNode[] {
  const out: PMNode[] = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) out.push(elementToJSON(child));
    else if (child instanceof Y.XmlText) out.push(...textToJSON(child));
  }
  return out;
}

export function elementToJSON(el: Y.XmlElement): PMNode {
  const node: PMNode = { type: el.nodeName };
  const attrs = el.getAttributes() as Record<string, unknown>;
  if (Object.keys(attrs).length) node.attrs = attrs;
  const content = childrenToJSON(el);
  if (content.length) node.content = content;
  return node;
}

function textToJSON(text: Y.XmlText): PMNode[] {
  const delta = text.toDelta() as { insert: unknown; attributes?: Record<string, Record<string, unknown>> }[];
  const out: PMNode[] = [];
  for (const op of delta) {
    if (typeof op.insert !== "string" || op.insert === "") continue;
    const node: PMNode = { type: "text", text: op.insert };
    if (op.attributes) {
      node.marks = Object.entries(op.attributes).map(([name, attrs]) => {
        // y-prosemirror stores overlapping marks of one type as `name--hash`.
        const mark: PMMark = { type: name.split("--")[0]! };
        if (attrs && typeof attrs === "object" && Object.keys(attrs).length) mark.attrs = attrs;
        return mark;
      });
    }
    out.push(node);
  }
  return out;
}

/** Build detached Y types for a ProseMirror JSON node (insert them into a fragment to integrate). */
export function jsonToY(node: PMNode): Y.XmlElement {
  const el = new Y.XmlElement(node.type);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value !== null && value !== undefined) el.setAttribute(key, value as string);
  }
  const children: (Y.XmlElement | Y.XmlText)[] = [];
  let run: PMNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const text = new Y.XmlText();
    let index = 0;
    for (const t of run) {
      const attrs: Record<string, unknown> = {};
      for (const m of t.marks ?? []) attrs[m.type] = m.attrs ?? {};
      text.insert(index, t.text ?? "", attrs);
      index += (t.text ?? "").length;
    }
    children.push(text);
    run = [];
  };
  for (const child of node.content ?? []) {
    if (child.type === "text") run.push(child);
    else {
      flush();
      children.push(jsonToY(child));
    }
  }
  flush();
  if (children.length) el.insert(0, children);
  return el;
}

export function replaceFragment(fragment: Y.XmlFragment, doc: PMNode): void {
  fragment.doc!.transact(() => {
    if (fragment.length) fragment.delete(0, fragment.length);
    fragment.insert(0, (doc.content ?? []).map(jsonToY));
  });
}

// ---------- Text ----------

export function inlineText(node: PMNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(inlineText).join("");
}

/** Plain text of a document, one line per text block. Used for search projection. */
export function plainText(doc: PMNode): string {
  const lines: string[] = [];
  const walk = (n: PMNode) => {
    if (TEXTBLOCK_TYPES.has(n.type)) lines.push(inlineText(n));
    else if (n.type === "image") lines.push(String(n.attrs?.alt ?? ""));
    else if (n.type === "fileAttachment") lines.push(String(n.attrs?.name ?? ""));
    else if (n.type === "childPage") lines.push(String(n.attrs?.title || "Untitled"));
    else (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return lines.filter(Boolean).join("\n");
}

// ---------- Block addressing (MCP) ----------

export interface BlockLocation {
  /** The Y element that carries `id`. */
  element: Y.XmlElement;
  parent: Y.XmlFragment | Y.XmlElement;
  index: number;
}

export function findBlock(fragment: Y.XmlFragment, blockId: string): BlockLocation | null {
  const visit = (parent: Y.XmlFragment | Y.XmlElement): BlockLocation | null => {
    const children = parent.toArray();
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.getAttribute("id") === blockId) return { element: child, parent, index };
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(fragment);
}

export function isTextblock(type: string): boolean {
  return TEXTBLOCK_TYPES.has(type);
}
export function isLeafBlock(type: string): boolean {
  return LEAF_BLOCK_TYPES.has(type);
}

/** Give every id-bearing node without an id a fresh one (server-side inserts). */
export function assignIds(node: PMNode, makeId: () => string): PMNode {
  const attrs = { ...node.attrs };
  if ((ID_NODE_TYPES as readonly string[]).includes(node.type) && !attrs.id) attrs.id = makeId();
  const out: PMNode = { ...node, attrs };
  if (!Object.keys(attrs).length) delete out.attrs;
  if (node.content) out.content = node.content.map((c) => (c.type === "text" ? c : assignIds(c, makeId)));
  return out;
}

/** Collect all block ids (to detect duplicates when inserting content). */
export function collectIds(node: PMNode, into = new Set<string>()): Set<string> {
  const value = node.attrs?.id;
  if (typeof value === "string") into.add(value);
  for (const c of node.content ?? []) collectIds(c, into);
  return into;
}

export function blockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return "b" + Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}
