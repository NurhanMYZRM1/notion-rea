import { type Editor, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";

const ITEM_TYPES = new Set(["listItem", "taskItem"]);

/** The block the cursor is in: a list item, or the top-level block. */
export function currentBlock(editor: Editor): { node: PMNode; pos: number; depth: number; offset: number } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (ITEM_TYPES.has(node.type.name) || d === 1) {
      const pos = $from.before(d);
      return { node, pos, depth: d, offset: $from.pos - pos };
    }
  }
  return null;
}

function move(editor: Editor, dir: -1 | 1, dispatch?: (tr: Transaction) => void): boolean {
  const block = currentBlock(editor);
  if (!block) return false;
  const { $from } = editor.state.selection;
  const parent = $from.node(block.depth - 1);
  const index = $from.index(block.depth - 1);
  const siblingIndex = index + dir;
  if (siblingIndex < 0 || siblingIndex >= parent.childCount) return false;
  if (!dispatch) return true;
  const sibling = parent.child(siblingIndex);
  const tr = editor.state.tr;
  const start = block.pos;
  const end = start + block.node.nodeSize;
  tr.delete(start, end);
  const target = dir === -1 ? start - sibling.nodeSize : start + sibling.nodeSize;
  tr.insert(target, block.node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target + block.offset, tr.doc.content.size))));
  dispatch(tr.scrollIntoView());
  return true;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockActions: {
      moveBlockUp: () => ReturnType;
      moveBlockDown: () => ReturnType;
      duplicateBlock: () => ReturnType;
      deleteBlock: () => ReturnType;
    };
  }
}

/** Keyboard-accessible block reordering and duplication (the drag handle is the pointer equivalent). */
export const BlockActions = Extension.create({
  name: "blockActions",
  addCommands() {
    return {
      moveBlockUp:
        () =>
        ({ editor, dispatch }) =>
          move(editor, -1, dispatch),
      moveBlockDown:
        () =>
        ({ editor, dispatch }) =>
          move(editor, 1, dispatch),
      duplicateBlock:
        () =>
        ({ editor, tr, dispatch }) => {
          const block = currentBlock(editor);
          if (!block) return false;
          if (dispatch) tr.insert(block.pos + block.node.nodeSize, block.node.copy(block.node.content));
          return true;
        },
      deleteBlock:
        () =>
        ({ editor, tr, dispatch }) => {
          const block = currentBlock(editor);
          if (!block) return false;
          if (dispatch) tr.delete(block.pos, block.pos + block.node.nodeSize);
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-ArrowUp": () => this.editor.commands.moveBlockUp(),
      "Mod-Shift-ArrowDown": () => this.editor.commands.moveBlockDown(),
      "Alt-Shift-ArrowUp": () => this.editor.commands.moveBlockUp(),
      "Alt-Shift-ArrowDown": () => this.editor.commands.moveBlockDown(),
      "Mod-d": () => this.editor.commands.duplicateBlock(),
    };
  },
});
