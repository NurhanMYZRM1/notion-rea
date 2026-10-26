import type { Editor as TiptapEditor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import DragHandle from "@tiptap/extension-drag-handle-react";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { blockId, FRAGMENT } from "@workspace/core";
import { FileText, GripVertical, Link as LinkIcon, Image as ImageIcon, ChevronDown, Plus, CheckSquare, IndentIncrease, IndentDecrease } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { BlockActions, currentBlock } from "./block-actions";
import { childPageIds, type ChildPageHost } from "./child-page";
import { fileWithView, imageWithView, type MediaOptions } from "./media";
import { schemaExtensions } from "./schema";
import { childPageWithView } from "./child-page-view";
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
  childPages?: ChildPageHost;
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingPage, setCreatingPage] = useState(false);
  const creatingRef = useRef(false);

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

  const archiveChildPages = (ids: string[]) => {
    const host = propsRef.current.childPages;
    if (!host) return;
    void (async () => {
      for (const id of ids) await host.archive(id);
    })().catch((err: unknown) => propsRef.current.onError?.(err instanceof Error ? err.message : "Could not move page to Trash"));
  };

  const createPage = async () => {
    const e = editorRef.current;
    const host = propsRef.current.childPages;
    if (!e?.isEditable || !host || creatingRef.current) return;
    creatingRef.current = true;
    setCreatingPage(true);
    try {
      const { $from } = e.state.selection;
      const anchor = $from.depth > 0 ? { node: $from.node(1), pos: $from.before(1) } : currentBlock(e);
      let afterBlockId: string | undefined = anchor?.node.attrs.id || undefined;
      if (anchor && !afterBlockId) {
        afterBlockId = blockId();
        e.view.dispatch(e.state.tr.setNodeMarkup(anchor.pos, undefined, { ...anchor.node.attrs, id: afterBlockId }));
      }
      // The slash deletion and its stable anchor are now in Yjs. The host awaits the ACK and
      // asks the server to insert exactly one owning block; never insert a second local node.
      const page = await host.create({ afterBlockId });
      host.open(page.id);
    } catch (err) {
      propsRef.current.onError?.(err instanceof Error ? err.message : "Could not create subpage");
    } finally {
      creatingRef.current = false;
      setCreatingPage(false);
    }
  };

  const getSlashItems = () => slashItems({
    ...(canUpload ? { pickImage: () => pick("image"), pickFile: () => pick("file") } : {}),
    ...(propsRef.current.childPages ? { createPage: () => void createPage() } : {}),
  });

  const editor = useEditor(
    {
      editable: props.editable,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      extensions: [
        ...schemaExtensions().map((e) => (e.name === "image" ? imageWithView(props) : e.name === "fileAttachment" ? fileWithView(props) : e.name === "childPage" ? childPageWithView(() => propsRef.current.childPages, (message) => propsRef.current.onError?.(message)) : e)),
        Collaboration.configure({ document: props.doc, field: FRAGMENT }),
        // UniqueID waits for provider "synced"; callers load the local doc before mounting, so it is already synced.
        CollaborationCaret.configure({ provider: { awareness: props.awareness, on: (event: string, cb: () => void) => event === "synced" && cb(), off: () => {} }, user: props.user }),
        Placeholder.configure({ placeholder: props.placeholder ?? "Type / for blocks", showOnlyCurrent: true }),
        BlockActions.configure({ archiveChildPages }),
        SlashCommand(getSlashItems),
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
        <LinkIcon size={16} />
      </ToolButton>
      {linkOpen && <LinkInput editor={editor} close={() => setLinkOpen(false)} />}
    </>
  );

  return (
    <div className={`ws-editor ${props.toolbar === "fixed" ? "has-fixed-toolbar" : ""}`}>
      {props.editable && (
        <DragHandle editor={editor} onNodeChange={({ pos }) => (hoverPos.current = pos)}>
          <BlockHandle editor={editor} childPages={() => propsRef.current.childPages} focusHovered={() => {
            if (hoverPos.current < 0) return;
            if (editor.state.doc.nodeAt(hoverPos.current)?.isAtom) editor.commands.setNodeSelection(hoverPos.current);
            else editor.commands.setTextSelection(hoverPos.current + 1);
          }} />
        </DragHandle>
      )}
      {props.editable && props.toolbar !== "fixed" && (
        <BubbleMenu editor={editor} className="ws-bubble" shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive("codeBlock") && !e.isActive("image") && !e.isActive("childPage")}>
          {marks}
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {creatingPage && <div className="ws-page-pending" role="status">Creating page…</div>}
      {props.editable && props.toolbar === "fixed" && (
        <div className="ws-fixed-toolbar" role="toolbar" aria-label="Formatting">
          {marks}
          <ToolButton label="Insert block" shortcut="/" active={() => pickerOpen} run={() => { editor.commands.blur(); setPickerOpen(true); }}>
            <Plus size={20} />
          </ToolButton>
          <ToolButton label="To-do" shortcut="" active={() => editor.isActive("taskList")} run={() => editor.chain().focus().toggleTaskList().run()}>
            <CheckSquare size={19} />
          </ToolButton>
          <ToolButton label="Indent" shortcut="Tab" active={() => false} run={() => editor.chain().focus().sinkListItem(editor.isActive("taskItem") ? "taskItem" : "listItem").run()}>
            <IndentIncrease size={19} />
          </ToolButton>
          <ToolButton label="Outdent" shortcut="Shift+Tab" active={() => false} run={() => editor.chain().focus().liftListItem(editor.isActive("taskItem") ? "taskItem" : "listItem").run()}>
            <IndentDecrease size={19} />
          </ToolButton>
          {canUpload && (
            <ToolButton label="Image" shortcut="" active={() => false} run={() => pick("image")}>
              <ImageIcon size={19} />
            </ToolButton>
          )}
          <ToolButton label="Hide keyboard" shortcut="" active={() => false} run={() => editor.commands.blur()}>
            <ChevronDown size={20} />
          </ToolButton>
        </div>
      )}
      {pickerOpen && <BlockPicker items={getSlashItems()} editor={editor} close={() => setPickerOpen(false)} />}
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
function BlockHandle({ editor, focusHovered, childPages }: { editor: TiptapEditor; focusHovered: () => void; childPages: () => ChildPageHost | undefined }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const block = currentBlock(editor);
  const pageIds = block ? childPageIds(block.node) : [];
  const ownsPages = pageIds.length > 0;
  const rect = buttonRef.current?.getBoundingClientRect();
  const act = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof globalThis.Node && !menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div className="ws-handle">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Block actions (drag to move)"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) focusHovered();
          setOpen((o) => !o);
        }}
      >
        <GripVertical size={18} />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="ws-block-menu" role="menu" aria-label="Block actions" style={{ position: "fixed", left: Math.max(8, Math.min((rect?.right ?? 8) + 4, window.innerWidth - 204)), top: Math.max(8, Math.min(rect?.top ?? 8, window.innerHeight - (ownsPages ? 170 : 296))), maxHeight: "calc(100dvh - 16px)", overflowY: "auto" }} onMouseLeave={() => setOpen(false)} onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") { setOpen(false); buttonRef.current?.focus(); }
          if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (at + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
            buttons[index]?.focus();
          }
        }}>
          <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().moveBlockUp().run())}>Move up</button>
          <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().moveBlockDown().run())}>Move down</button>
          {ownsPages && pageIds.length === 1 && childPages()?.move && <button role="menuitem" type="button" onClick={act(() => childPages()?.move?.(pageIds[0]!))}>Move to</button>}
          {!ownsPages && <>
            <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().duplicateBlock().run())}>Duplicate</button>
            <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().setParagraph().run())}>Turn into text</button>
            <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().setHeading({ level: 2 }).run())}>Turn into heading</button>
            <button role="menuitem" type="button" onClick={act(() => editor.chain().focus().toggleTaskList().run())}>Turn into to-do</button>
          </>}
          <button role="menuitem" type="button" className="danger" onClick={act(() => editor.chain().focus().deleteBlock().run())}>{ownsPages ? "Move to Trash" : "Delete"}</button>
        </div>, document.body
      )}
    </div>
  );
}

function BlockPicker({ editor, items, close }: { editor: TiptapEditor; items: ReturnType<typeof slashItems>; close: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const buttons = Array.from(sheet.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
        event.preventDefault(); next?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);
  return createPortal(<div className="ws-picker-backdrop" onClick={close}>
    <div className="ws-block-picker" role="dialog" aria-modal="true" aria-labelledby="ws-picker-title" ref={sheet} onClick={(event) => event.stopPropagation()}>
      <div className="ws-picker-heading"><h2 id="ws-picker-title">Insert block</h2><button type="button" onClick={close} aria-label="Close block picker">×</button></div>
      <div className="ws-picker-list">{items.map((item) => <button key={item.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => {
        close();
        const { from, to } = editor.state.selection;
        item.run(editor, { from, to });
      }}><span className="ws-picker-icon" aria-hidden="true">{item.id === "page" ? <FileText size={20} /> : item.id.startsWith("h") ? item.id.toUpperCase() : item.id === "text" ? "T" : item.id === "todo" ? <CheckSquare size={20} /> : "≡"}</span><span><strong>{item.title}</strong><small>{item.hint}</small></span></button>)}</div>
    </div>
  </div>, document.body);
}
