import { Node, mergeAttributes } from "@tiptap/core";

/** A downloadable file stored as a private workspace attachment. */
export const FileAttachment = Node.create({
  name: "fileAttachment",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      name: { default: "file" },
      size: { default: null },
      mimeType: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-file-attachment]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-file-attachment": "", class: "file-attachment" }),
      ["a", { href: node.attrs.src, download: node.attrs.name, rel: "noopener" }, `📎 ${node.attrs.name}`],
    ];
  },
});
