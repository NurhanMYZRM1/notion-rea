import { Node, mergeAttributes } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, type EditorState } from "@tiptap/pm/state";

/** Lightweight, authorized page metadata. Fallback node attrs never override a resolved title. */
export interface ChildPageReference {
  id: string;
  title: string;
  icon?: string | null;
}

export interface ChildPageHost {
  resolve(pageIds: string[]): Promise<ChildPageReference[]>;
  /** Await pending parent edits before the server inserts its canonical childPage block. */
  create(input: { afterBlockId?: string }): Promise<ChildPageReference>;
  open(pageId: string): void;
  /** Archive the page and descendants; the host offers Undo. Never permanently delete. */
  archive(pageId: string): Promise<void>;
  move?(pageId: string): void;
  /** Notify mounted blocks after rename, move, archive, restore, or metadata invalidation. */
  subscribe?(listener: () => void): () => void;
}

/** Page references inside a block, including references nested in list/toggle containers. */
export function childPageIds(node: PMNode): string[] {
  const ids: string[] = [];
  if (node.type.name === "childPage") ids.push(String(node.attrs.pageId));
  node.descendants((child) => {
    if (child.type.name === "childPage") ids.push(String(child.attrs.pageId));
  });
  return ids;
}

export function selectedChildPageIds(state: EditorState, direction?: "backward" | "forward"): string[] {
  const { from, to, empty, $from } = state.selection;
  const ids: string[] = [];
  if (!empty) state.doc.nodesBetween(from, to, (node) => {
    if (node.type.name === "childPage") ids.push(String(node.attrs.pageId));
  });
  else if (direction) {
    // At textblock edges the page block is a sibling of the paragraph, not nodeBefore/After.
    const adjacent = direction === "backward"
      ? ($from.parentOffset === 0 && $from.depth > 0 ? state.doc.resolve($from.before()).nodeBefore : $from.nodeBefore)
      : ($from.parentOffset === $from.parent.content.size && $from.depth > 0 ? state.doc.resolve($from.after()).nodeAfter : $from.nodeAfter);
    if (adjacent?.type.name === "childPage") ids.push(String(adjacent.attrs.pageId));
  }
  return [...new Set(ids)];
}

function ownership(node: PMNode): string {
  const refs: string[] = [];
  node.descendants((child, _pos, parent) => {
    if (child.type.name === "childPage") refs.push(JSON.stringify([child.attrs, parent?.type.name, parent?.attrs.id ?? null]));
  });
  return refs.sort().join("\n");
}

export const ChildPage = Node.create<{ host?: () => ChildPageHost | undefined; onError?: (message: string) => void }>({
  name: "childPage",
  priority: 1000,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  isolating: true,
  addOptions() { return {}; },
  addAttributes() {
    return {
      pageId: { default: null, parseHTML: (el) => el.getAttribute("data-page-id"), renderHTML: (attrs) => ({ "data-page-id": attrs.pageId }) },
      title: { default: null },
      icon: { default: null },
    };
  },
  parseHTML() { return [{ tag: "div[data-child-page]" }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-child-page": "", class: "ws-child-page" }),
      ["a", { href: `/p/${encodeURIComponent(String(node.attrs.pageId))}` }, String(node.attrs.title || "Untitled")]];
  },
  renderText({ node }) { return String(node.attrs.title || "Untitled"); },
  addProseMirrorPlugins() {
    const archive = (ids: string[]) => {
      const host = this.options.host?.();
      if (host) void (async () => {
        for (const id of ids) await host.archive(id);
      })().catch((err: unknown) => this.options.onError?.(err instanceof Error ? err.message : "Could not move page to Trash"));
    };
    return [new Plugin({
      // Server reconciliation arrives through the collaboration plugin. Local transforms may
      // reorder owning blocks but cannot create, clone, remove, or change their relationship.
      filterTransaction: (tr, state) => !tr.docChanged || isChangeOrigin(tr) || ownership(tr.doc) === ownership(state.doc),
      props: {
        handleKeyDown: (view, event) => {
          const key = (event as unknown as { key: string }).key;
          if (key !== "Backspace" && key !== "Delete") return false;
          const ids = selectedChildPageIds(view.state, key === "Backspace" ? "backward" : "forward");
          if (!ids.length) return false;
          if (this.editor.isEditable) archive(ids);
          return true;
        },
        handleDOMEvents: {
          beforeinput: (view, event) => {
            const input = event as unknown as { inputType?: string };
            if (!input.inputType?.startsWith("delete")) return false;
            const ids = selectedChildPageIds(view.state, input.inputType.includes("Backward") ? "backward" : "forward");
            if (!ids.length) return false;
            event.preventDefault();
            if (this.editor.isEditable && input.inputType !== "deleteByCut") archive(ids);
            return true;
          },
          cut: (view, event) => {
            if (!selectedChildPageIds(view.state).length) return false;
            event.preventDefault();
            this.options.onError?.("Use Move to to relocate a subpage");
            return true;
          },
        },
      },
    })];
  },
});

