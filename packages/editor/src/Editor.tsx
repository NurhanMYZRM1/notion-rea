import type { Editor as TiptapEditor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { FRAGMENT } from "@workspace/core";
import { memo, useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { BlockActions } from "./block-actions";
import { fileWithView, imageWithView, type MediaOptions } from "./media";
import { schemaExtensions } from "./schema";
import { SlashCommand, slashItems } from "./slash";

export interface Uploaded {
  src: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface WorkspaceEditorProps extends MediaOptions {
  doc: Y.Doc;
  awareness: Awareness;
  user: { name: string; color: string };
  editable: boolean;
  /** Web: upload a dropped/pasted/picked file. */
  upload?: (file: File) => Promise<Uploaded>;
  /** Native: pick and upload through the system picker; resolves to the uploaded file or null. */
  pickAndUpload?: (kind: "image" | "file") => Promise<Uploaded | null>;
  onError?: (message: string) => void;
  /** "bubble" (desktop) or "fixed" (touch: toolbar pinned above the keyboard). */
  toolbar?: "bubble" | "fixed";
  onReady?: (editor: TiptapEditor) => void;
  placeholder?: string;
}

const isImage = (type: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type);

/**
 * The shared rich-text editor. Renders only the document; all app chrome lives outside so typing
 * never re-renders unrelated UI (Tiptap v3 does not re-render React on every transaction).
 */
export const WorkspaceEditor = memo(function WorkspaceEditor(props: WorkspaceEditorProps) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const [linkOpen, setLinkOpen] = useState(false);

  const insertUploaded = (editor: TiptapEditor, file: Uploaded, at?: number) => {
    const node = isImage(file.mimeType)
      ? { type: "image", attrs: { src: file.src, alt: file.name } }
      : { type: "fileAttachment", attrs: { src: file.src, name: file.name, size: file.size, mimeType: file.mimeType } };
    const chain = editor.chain().focus();
    (at !== undefined ? chain.insertContentAt(at, node) : chain.insertContent(node)).run();
  };

  const uploadFiles = async (editor: TiptapEditor, files: File[], at?: number) => {
    const { upload, onError } = propsRef.current;
    if (!upload) return;
    for (const file of files.slice(0, 10)) {
      try {
        insertUploaded(editor, await upload(file), at);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : "Upload failed");
      }
    }
  };

  const pick = (kind: "image" | "file") => {
    const editor = editorRef.current;
    if (!editor) return;
    const { pickAndUpload, upload, onError } = propsRef.current;
    if (pickAndUpload) {
      pickAndUpload(kind)
        .then((f) => f && insertUploaded(editor, f))
        .catch((err) => onError?.(err instanceof Error ? err.message : "Upload failed"));
      return;
    }
    if (!upload) return;
    const input = document.createElement("input");
    input.type = "file";
    if (kind === "image") input.accept = "image/png,image/jpeg,image/gif,image/webp,image/avif";
    input.onchange = () => void uploadFiles(editor, Array.from(input.files ?? []));
    input.click();
  };

  const editorRef = useRef<TiptapEditor | null>(null);
  const hoverPos = useRef(-1);
  const canUpload = !!(props.upload || props.pickAndUpload);

  const editor = useEditor(
    {
      editable: props.editable,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      extensions: [
        ...schemaExtensions().map((e) => (e.name === "image" ? imageWithView(props) : e.name === "fileAttachment" ? fileWithView(props) : e)),
        Collaboration.configure({ document: props.doc, field: FRAGMENT }),
        // UniqueID waits for provider "synced"; callers load the local doc before mounting, so it is already synced.
        CollaborationCaret.configure({ provider: { awareness: props.awareness, on: (event: string, cb: () => void) => event === "synced" && cb(), off: () => {} }, user: props.user }),
        Placeholder.configure({ placeholder: props.placeholder ?? "Type / for blocks", showOnlyCurrent: true }),
        BlockActions,
        SlashCommand(() => slashItems(canUpload ? { pickImage: () => pick("image"), pickFile: () => pick("file") } : {})),
      ],
      editorProps: {
        attributes: { class: "ws-doc", role: "textbox", "aria-multiline": "true", "aria-label": "Page content", spellcheck: "true" },
        handleDrop: (view, event, _slice, moved) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (moved || !files.length || !propsRef.current.upload) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void uploadFiles(editorRef.current!, files, pos);
          return true;
        },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.length || !propsRef.current.upload) return false;
          event.preventDefault();
          void uploadFiles(editorRef.current!, files);
          return true;
        },
      },
      onCreate: ({ editor }) => {
        editorRef.current = editor;
        propsRef.current.onReady?.(editor);
      },
    },
    [props.doc],
  );

  useEffect(() => {
    if (editor && editor.isEditable !== props.editable) editor.setEditable(props.editable);
  }, [editor, props.editable]);

  useEffect(() => {
    if (!editor) return;
    editor.commands.updateUser(props.user);
  }, [editor, props.user.name, props.user.color]);

  if (!editor) return null;

  const marks = (
    <>
      <ToolButton label="Bold" shortcut="Mod+B" active={() => editor.isActive("bold")} run={() => editor.chain().focus().toggleBold().run()}>
        <b>B</b>
      </ToolButton>
      <ToolButton label="Italic" shortcut="Mod+I" active={() => editor.isActive("italic")} run={() => editor.chain().focus().toggleItalic().run()}>
        <i>I</i>
      </ToolButton>
      <ToolButton label="Strikethrough" shortcut="Mod+Shift+S" active={() => editor.isActive("strike")} run={() => editor.chain().focus().toggleStrike().run()}>
        <s>S</s>
      </ToolButton>
      <ToolButton label="Inline code" shortcut="Mod+E" active={() => editor.isActive("code")} run={() => editor.chain().focus().toggleCode().run()}>
        {"</>"}
      </ToolButton>
      <ToolButton label="Link" shortcut="" active={() => editor.isActive("link")} run={() => setLinkOpen((o) => !o)}>
        🔗
      </ToolButton>
      {linkOpen && <LinkInput editor={editor} close={() => setLinkOpen(false)} />}
    </>
  );

  return (
    <div className={`ws-editor ${props.toolbar === "fixed" ? "has-fixed-toolbar" : ""}`}>
      {props.editable && (
        <DragHandle editor={editor} onNodeChange={({ pos }) => (hoverPos.current = pos)}>
          <BlockHandle editor={editor} focusHovered={() => hoverPos.current >= 0 && editor.commands.setTextSelection(hoverPos.current + 1)} />
        </DragHandle>
      )}
      {props.editable && props.toolbar !== "fixed" && (
        <BubbleMenu editor={editor} className="ws-bubble" shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive("codeBlock") && !e.isActive("image")}>
          {marks}
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {props.editable && props.toolbar === "fixed" && (
        <div className="ws-fixed-toolbar" role="toolbar" aria-label="Formatting">
          {marks}
          <ToolButton label="Insert block" shortcut="/" active={() => false} run={() => editor.chain().focus().insertContent("/").run()}>
            +
          </ToolButton>
          <ToolButton label="To-do" shortcut="" active={() => editor.isActive("taskList")} run={() => editor.chain().focus().toggleTaskList().run()}>
            ☑
          </ToolButton>
          <ToolButton label="Indent" shortcut="Tab" active={() => false} run={() => editor.chain().focus().sinkListItem(editor.isActive("taskItem") ? "taskItem" : "listItem").run()}>
            ⇥
          </ToolButton>
          <ToolButton label="Outdent" shortcut="Shift+Tab" active={() => false} run={() => editor.chain().focus().liftListItem(editor.isActive("taskItem") ? "taskItem" : "listItem").run()}>
            ⇤
          </ToolButton>
          {canUpload && (
            <ToolButton label="Image" shortcut="" active={() => false} run={() => pick("image")}>
              🖼
            </ToolButton>
          )}
          <ToolButton label="Hide keyboard" shortcut="" active={() => false} run={() => editor.commands.blur()}>
            ⌄
          </ToolButton>
        </div>
      )}
    </div>
  );
});

function ToolButton(p: { label: string; shortcut: string; active: () => boolean; run: () => void; children: React.ReactNode }) {
  const title = p.shortcut ? `${p.label} (${p.shortcut.replace("Mod", /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl")})` : p.label;
  return (
    <button type="button" className={p.active() ? "is-active" : ""} aria-label={p.label} aria-pressed={p.active()} title={title} onMouseDown={(e) => e.preventDefault()} onClick={p.run}>
      {p.children}
    </button>
  );
}

function LinkInput({ editor, close }: { editor: TiptapEditor; close: () => void }) {
  const [href, setHref] = useState<string>(editor.getAttributes("link").href ?? "");
  const apply = () => {
    const value = href.trim();
    if (!value) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else {
      const url = /^(https?:|mailto:)/i.test(value) ? value : `https://${value}`;
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    close();
  };
  return (
    <form
      className="ws-link-input"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <input autoFocus aria-label="Link address" placeholder="Paste a link" value={href} onChange={(e) => setHref(e.target.value)} onKeyDown={(e) => e.key === "Escape" && close()} />
    </form>
  );
}

/** ⋮⋮ handle: drag to reorder; click for block actions. */
function BlockHandle({ editor, focusHovered }: { editor: TiptapEditor; focusHovered: () => void }) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  return (
    <div className="ws-handle">
      <button
        type="button"
        aria-label="Block actions (drag to move)"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) focusHovered();
          setOpen((o) => !o);
        }}
      >
        ⋮⋮
      </button>
      {open && (
        <div className="ws-block-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().moveBlockUp().run())}>Move up</button>
          <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().moveBlockDown().run())}>Move down</button>
          <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().duplicateBlock().run())}>Duplicate</button>
          <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().setParagraph().run())}>Turn into text</button>
          <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().setHeading({ level: 2 }).run())}>Turn into heading</button>
          <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().toggleTaskList().run())}>Turn into to-do</button>
          <button role="menuitem" type="button" className="danger" onClick={act(() => editor.chain().focus().deleteBlock().run())}>Delete</button>
        </div>
      )}
    </div>
  );
}
