import type { AnyExtension } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import UniqueID from "@tiptap/extension-unique-id";
import StarterKit from "@tiptap/starter-kit";
import { blockId, ID_NODE_TYPES } from "@workspace/core";
import { FileAttachment } from "./file-attachment";
import { ChildPage } from "./child-page";

const SAFE_PROTOCOLS = ["http", "https", "mailto"];

/**
 * The document schema. Shared by the web editor, the mobile editor (DOM component) and the server
 * (MCP edits are validated against `getSchema(schemaExtensions())`). Changing node names or attrs
 * is a data migration.
 */
export function schemaExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: false, // Yjs owns history (per-user undo) via the Collaboration extension
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: SAFE_PROTOCOLS,
        isAllowedUri: (url) => /^(https?:|mailto:|\/api\/attachments\/|\/p\/[^/?#]+$)/i.test(url),
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      },
      trailingNode: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Details.configure({ persist: true, HTMLAttributes: { class: "toggle" } }),
    DetailsSummary,
    DetailsContent,
    Image.configure({ inline: false, allowBase64: false }),
    FileAttachment,
    ChildPage,
    UniqueID.configure({
      types: [...ID_NODE_TYPES],
      attributeName: "id",
      generateID: blockId,
      filterTransaction: (tr) => !isChangeOrigin(tr),
    }),
  ];
}
