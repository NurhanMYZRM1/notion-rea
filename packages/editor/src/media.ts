import Image from "@tiptap/extension-image";
import { FileAttachment } from "./file-attachment";

export interface MediaOptions {
  /** Map a stored src (`/api/attachments/…`) to something the view can load (mobile: a cached file URI). */
  resolveSrc?: (src: string) => Promise<string> | string;
  /** Open a file attachment (mobile: native viewer). Defaults to a normal link. */
  openFile?: (src: string, name: string) => void;
}

/** Image with lazy loading and an async src resolver. Stored attrs are unchanged (same schema). */
export function imageWithView(opts: MediaOptions) {
  return Image.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement("figure");
        dom.className = "ws-image";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.alt = node.attrs.alt ?? "";
        img.draggable = false;
        const load = async (src: string | null) => {
          if (!src) return;
          try {
            img.src = opts.resolveSrc ? await opts.resolveSrc(src) : src;
          } catch {
            dom.classList.add("is-missing");
            img.alt = "Image unavailable offline";
          }
        };
        void load(node.attrs.src);
        dom.appendChild(img);
        return {
          dom,
          update: (next) => {
            if (next.type.name !== "image") return false;
            if (next.attrs.src !== node.attrs.src) void load(next.attrs.src);
            img.alt = next.attrs.alt ?? "";
            return true;
          },
        };
      };
    },
  }).configure({ inline: false, allowBase64: false });
}

export function fileWithView(opts: MediaOptions) {
  return FileAttachment.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement("div");
        dom.className = "file-attachment";
        dom.contentEditable = "false";
        const a = document.createElement("a");
        a.href = node.attrs.src ?? "#";
        a.textContent = `📎 ${node.attrs.name ?? "file"}`;
        a.rel = "noopener";
        a.setAttribute("download", node.attrs.name ?? "file");
        if (opts.openFile) {
          a.addEventListener("click", (e) => {
            e.preventDefault();
            opts.openFile!(node.attrs.src, node.attrs.name);
          });
        }
        const size = document.createElement("span");
        size.className = "file-size";
        if (node.attrs.size) size.textContent = ` ${(node.attrs.size / 1024 / 1024).toFixed(1)} MB`;
        dom.append(a, size);
        return { dom };
      };
    },
  });
}
