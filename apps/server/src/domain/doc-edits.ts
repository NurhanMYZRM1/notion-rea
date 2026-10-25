import { getSchema } from "@tiptap/core";
import {
  assignIds,
  blockId,
  collectIds,
  elementToJSON,
  FRAGMENT,
  findBlock,
  fromMarkdown,
  isTextblock,
  jsonToY,
  type PMNode,
  yToJSON,
} from "@workspace/core";
import { schemaExtensions } from "@workspace/editor/schema";
import * as Y from "yjs";
import { z } from "zod";
import { AppError } from "../errors";

let schemaCache: ReturnType<typeof getSchema> | null = null;
export function docSchema() {
  return (schemaCache ??= getSchema(schemaExtensions()));
}

const content = z
  .object({
    markdown: z.string().max(200_000).optional(),
    blocks: z.array(z.any()).max(500).optional(),
  })
  .refine((v) => (v.markdown === undefined) !== (v.blocks === undefined), "give exactly one of markdown or blocks");

const where = z.union([
  z.object({ afterBlockId: z.string().max(64) }),
  z.object({ beforeBlockId: z.string().max(64) }),
  z.object({ position: z.enum(["start", "end"]) }),
]);

export const EditOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), at: where, content }),
  z.object({ op: z.literal("replace"), blockId: z.string().max(64), content }),
  z.object({ op: z.literal("update_text"), blockId: z.string().max(64), markdown: z.string().max(50_000) }),
  z.object({ op: z.literal("delete"), blockId: z.string().max(64) }),
  z.object({ op: z.literal("move"), blockId: z.string().max(64), at: where }),
  z.object({ op: z.literal("set_checked"), blockId: z.string().max(64), checked: z.boolean() }),
]);
export type EditOp = z.infer<typeof EditOp>;

/** Operations that discard or overwrite existing content must name the revision they were based on. */
export function needsExpectedRevision(ops: EditOp[]): boolean {
  return ops.some((o) => o.op === "replace" || o.op === "update_text" || o.op === "delete");
}

function toNodes(c: z.infer<typeof content>, warnings: string[]): PMNode[] {
  const nodes = c.markdown !== undefined ? (fromMarkdown(c.markdown, { warnings }).content ?? []) : (c.blocks as PMNode[]);
  // Server-generated ids: callers may not choose ids (avoids duplicates/collisions with live blocks).
  return nodes.map((n) => assignIds(stripIds(n), blockId));
}

function stripIds(node: PMNode): PMNode {
  const out: PMNode = { ...node };
  if (out.attrs) {
    const { id: _ignored, ...rest } = out.attrs;
    out.attrs = Object.keys(rest).length ? rest : undefined;
    if (!out.attrs) delete out.attrs;
  }
  if (out.content) out.content = out.content.map((c) => (c.type === "text" ? c : stripIds(c)));
  return out;
}

function missing(blockIdValue: string): AppError {
  return new AppError("not_found", `Block ${blockIdValue} not found`, { blockId: blockIdValue });
}

function resolveWhere(fragment: Y.XmlFragment, at: z.infer<typeof where>): { parent: Y.XmlFragment | Y.XmlElement; index: number } {
  if ("position" in at) return { parent: fragment, index: at.position === "start" ? 0 : fragment.length };
  const target = "afterBlockId" in at ? at.afterBlockId : at.beforeBlockId;
  const loc = findBlock(fragment, target);
  if (!loc) throw missing(target);
  return { parent: loc.parent, index: "afterBlockId" in at ? loc.index + 1 : loc.index };
}

/**
 * Apply structured edits to a Y.Doc in one transaction and validate the result against the editor
 * schema. Runs on a scratch copy first so invalid edits never touch the live document.
 * Returns the Yjs update to apply to the live doc (empty if nothing changed).
 */
export function planEdits(live: Y.Doc, ops: EditOp[]): { update: Uint8Array; insertedIds: string[]; warnings: string[] } {
  const scratch = new Y.Doc({ gc: false });
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(live));
  const fragment = scratch.getXmlFragment(FRAGMENT);
  const insertedIds: string[] = [];
  const warnings: string[] = [];

  scratch.transact(() => {
    for (const op of ops) {
      switch (op.op) {
        case "insert": {
          const nodes = toNodes(op.content, warnings);
          const { parent, index } = resolveWhere(fragment, op.at);
          parent.insert(index, nodes.map(jsonToY));
          nodes.forEach((n) => insertedIds.push(String(n.attrs?.id)));
          break;
        }
        case "replace": {
          const loc = findBlock(fragment, op.blockId);
          if (!loc) throw missing(op.blockId);
          const nodes = toNodes(op.content, warnings);
          loc.parent.delete(loc.index, 1);
          loc.parent.insert(loc.index, nodes.map(jsonToY));
          nodes.forEach((n) => insertedIds.push(String(n.attrs?.id)));
          break;
        }
        case "update_text": {
          const loc = findBlock(fragment, op.blockId);
          if (!loc) throw missing(op.blockId);
          // A list item / to-do carries its text in its first paragraph.
          const inner = isTextblock(loc.element.nodeName) ? null : firstTextblockChild(loc.element);
          const target = inner ? { parent: loc.element as Y.XmlElement | Y.XmlFragment, index: 0, el: inner } : { ...loc, el: loc.element };
          if (!isTextblock(target.el.nodeName)) throw new AppError("unsupported", `Block ${op.blockId} (${loc.element.nodeName}) has no text to update`);
          const parsed: PMNode[] =
            target.el.nodeName === "codeBlock"
              ? op.markdown ? [{ type: "text", text: op.markdown }] : []
              : (fromMarkdown(op.markdown, { warnings }).content?.[0]?.content ?? []);
          const attrs = target.el.getAttributes() as Record<string, unknown>;
          target.parent.delete(target.index, 1);
          target.parent.insert(target.index, [jsonToY({ type: target.el.nodeName, attrs, content: parsed })]);
          break;
        }
        case "delete": {
          const loc = findBlock(fragment, op.blockId);
          if (!loc) throw missing(op.blockId);
          loc.parent.delete(loc.index, 1);
          break;
        }
        case "move": {
          const loc = findBlock(fragment, op.blockId);
          if (!loc) throw missing(op.blockId);
          const json = elementToJSON(loc.element);
          if (collectIds(json).has(targetOf(op.at) ?? "")) throw new AppError("invalid_input", "Cannot move a block into itself");
          loc.parent.delete(loc.index, 1);
          const { parent, index } = resolveWhere(fragment, op.at);
          parent.insert(index, [jsonToY(json)]);
          break;
        }
        case "set_checked": {
          const loc = findBlock(fragment, op.blockId);
          if (!loc) throw missing(op.blockId);
          if (loc.element.nodeName !== "taskItem") throw new AppError("unsupported", `Block ${op.blockId} is not a to-do`);
          loc.element.setAttribute("checked", op.checked as unknown as string);
          break;
        }
      }
    }
  });

  const json = yToJSON(fragment);
  try {
    docSchema().nodeFromJSON(json).check();
  } catch (err) {
    throw new AppError("invalid_input", `Edit would produce an invalid document: ${(err as Error).message}`);
  }
  const ids = collectIds(json);
  if (ids.size !== countIds(json)) throw new AppError("invalid_input", "Edit would duplicate block ids");
  return { update: Y.encodeStateAsUpdate(scratch, Y.encodeStateVector(live)), insertedIds, warnings };
}

function targetOf(at: z.infer<typeof where>): string | null {
  return "afterBlockId" in at ? at.afterBlockId : "beforeBlockId" in at ? at.beforeBlockId : null;
}

function firstTextblockChild(el: Y.XmlElement): Y.XmlElement | null {
  const first = el.toArray()[0];
  return first instanceof Y.XmlElement && isTextblock(first.nodeName) ? first : null;
}

function countIds(node: PMNode): number {
  return (typeof node.attrs?.id === "string" ? 1 : 0) + (node.content ?? []).reduce((n, c) => n + countIds(c), 0);
}

/** Validate an imported/created document before it becomes a page body. */
export function validateDoc(json: PMNode): PMNode {
  const withIds = assignIds(json, blockId);
  try {
    docSchema().nodeFromJSON(withIds).check();
  } catch (err) {
    throw new AppError("invalid_input", `Invalid document: ${(err as Error).message}`);
  }
  return withIds;
}
