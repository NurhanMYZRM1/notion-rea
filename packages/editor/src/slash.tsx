import { type Editor, Extension, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface SlashItem {
  id: string;
  title: string;
  hint: string;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

export function slashItems(opts: { pickImage?: () => void; pickFile?: () => void }): SlashItem[] {
  const chain = (e: Editor, r: Range) => e.chain().focus().deleteRange(r);
  const items: SlashItem[] = [
    { id: "text", title: "Text", hint: "Plain paragraph", keywords: "paragraph p", run: (e, r) => chain(e, r).setParagraph().run() },
    { id: "h1", title: "Heading 1", hint: "Large section heading  #", keywords: "h1 title", run: (e, r) => chain(e, r).setHeading({ level: 1 }).run() },
    { id: "h2", title: "Heading 2", hint: "Medium heading  ##", keywords: "h2 subtitle", run: (e, r) => chain(e, r).setHeading({ level: 2 }).run() },
    { id: "h3", title: "Heading 3", hint: "Small heading  ###", keywords: "h3", run: (e, r) => chain(e, r).setHeading({ level: 3 }).run() },
    { id: "bullet", title: "Bulleted list", hint: "Simple list  -", keywords: "ul unordered bullet", run: (e, r) => chain(e, r).toggleBulletList().run() },
    { id: "numbered", title: "Numbered list", hint: "Ordered list  1.", keywords: "ol ordered number", run: (e, r) => chain(e, r).toggleOrderedList().run() },
    { id: "todo", title: "To-do list", hint: "Track tasks  []", keywords: "task checkbox check", run: (e, r) => chain(e, r).toggleTaskList().run() },
    { id: "toggle", title: "Toggle", hint: "Collapsible section", keywords: "details collapse", run: (e, r) => chain(e, r).setDetails().run() },
    { id: "quote", title: "Quote", hint: "Capture a quote  \"", keywords: "blockquote", run: (e, r) => chain(e, r).toggleBlockquote().run() },
    { id: "code", title: "Code", hint: "Code block  ```", keywords: "pre snippet", run: (e, r) => chain(e, r).toggleCodeBlock().run() },
    { id: "divider", title: "Divider", hint: "Separate sections  ---", keywords: "hr rule line", run: (e, r) => chain(e, r).setHorizontalRule().run() },
  ];
  if (opts.pickImage) items.push({ id: "image", title: "Image", hint: "Upload an image", keywords: "picture photo", run: (e, r) => (chain(e, r).run(), opts.pickImage!()) });
  if (opts.pickFile) items.push({ id: "file", title: "File", hint: "Attach a file", keywords: "attachment upload pdf", run: (e, r) => (chain(e, r).run(), opts.pickFile!()) });
  return items;
}

interface MenuHandle {
  onKeyDown: (p: SuggestionKeyDownProps) => boolean;
}

const SlashMenu = forwardRef<MenuHandle, SuggestionProps<SlashItem>>(function SlashMenu(props, ref) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [props.items]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const choose = (i: number) => {
    const item = props.items[i];
    if (item) props.command(item);
  };
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!props.items.length) return false;
      if (event.key === "ArrowDown") return setActive((a) => (a + 1) % props.items.length), true;
      if (event.key === "ArrowUp") return setActive((a) => (a - 1 + props.items.length) % props.items.length), true;
      if (event.key === "Enter" || event.key === "Tab") return choose(active), true;
      return false;
    },
  }));
  const rect = props.clientRect?.();
  if (!rect) return null;
  return (
    <div
      ref={listRef}
      className="ws-slash"
      role="listbox"
      aria-label="Insert block"
      style={{ position: "fixed", left: Math.min(rect.left, window.innerWidth - 300), top: rect.bottom + 6 }}
    >
      {props.items.length === 0 && <div className="ws-slash-empty">No matching blocks</div>}
      {props.items.map((item, i) => (
        <button
          type="button"
          key={item.id}
          data-index={i}
          role="option"
          aria-selected={i === active}
          className={i === active ? "is-active" : ""}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            choose(i);
          }}
        >
          <span className="ws-slash-title">{item.title}</span>
          <span className="ws-slash-hint">{item.hint}</span>
        </button>
      ))}
    </div>
  );
});

/** `/` opens a filterable block menu (Notion-style slash commands). */
export function SlashCommand(getItems: () => SlashItem[]) {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: "/",
          allowSpaces: false,
          startOfLine: false,
          allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
          items: ({ query }) => {
            const q = query.toLowerCase();
            return getItems().filter((i) => !q || i.title.toLowerCase().includes(q) || i.keywords.includes(q)).slice(0, 20);
          },
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => {
            let renderer: ReactRenderer<MenuHandle, SuggestionProps<SlashItem>> | null = null;
            return {
              onStart: (props) => {
                renderer = new ReactRenderer(SlashMenu, { props, editor: props.editor });
                document.body.appendChild(renderer.element);
              },
              onUpdate: (props) => renderer?.updateProps(props),
              onKeyDown: (props) => {
                if (props.event.key === "Escape") {
                  renderer?.destroy();
                  renderer?.element.remove();
                  renderer = null;
                  return true;
                }
                return renderer?.ref?.onKeyDown(props) ?? false;
              },
              onExit: () => {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
              },
            };
          },
        }),
      ];
    },
  });
}
