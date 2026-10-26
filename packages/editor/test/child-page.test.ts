import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { FRAGMENT, fromMarkdown, jsonToY, plainText, toMarkdown, yToJSON } from "@workspace/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockActions, currentBlock } from "../src/block-actions";
import { ChildPage, type ChildPageHost } from "../src/child-page";
import { childPageWithView } from "../src/child-page-view";
import { schemaExtensions } from "../src/schema";
import { slashItems } from "../src/slash";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));
const child = { type: "childPage", attrs: { id: "child-block", pageId: "pg_child", title: "Project [notes]", icon: "📄" } };
const paragraph = { type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text: "Keep my text" }] };
function mount(host?: ChildPageHost) {
  const editor = new Editor({
    content: { type: "doc", content: [paragraph, child, { type: "paragraph", attrs: { id: "p2" } }] },
    extensions: [
      ...schemaExtensions().map((e) => e.name === "childPage" ? ChildPage.configure({ host: () => host }) : e),
      BlockActions.configure({ archiveChildPages: (ids) => ids.forEach((id) => void host?.archive(id)) }),
    ],
  });
  editors.push(editor);
  return editor;
}

describe("owning subpage blocks", () => {
  it("roundtrips server Yjs content through the editor schema and Markdown navigation links", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment(FRAGMENT).insert(0, [jsonToY(paragraph), jsonToY(child)]);
    const editor = new Editor({ extensions: [...schemaExtensions(), Collaboration.configure({ document: doc, field: FRAGMENT })] });
    editors.push(editor);
    const json = yToJSON(doc.getXmlFragment(FRAGMENT));
    expect(editor.schema.nodeFromJSON(json).lastChild?.attrs.pageId).toBe("pg_child");
    expect(editor.getText()).toContain("Project [notes]");
    expect(plainText(json)).toBe("Keep my text\nProject [notes]");
    const md = toMarkdown(json);
    expect(md).toContain("[Project \\[notes\\]](/p/pg_child)");
    const imported = fromMarkdown(md);
    expect(imported.content?.[1]?.content?.[0]?.marks?.[0]?.attrs?.href).toBe("/p/pg_child");
    expect(imported.content?.[1]?.type).toBe("paragraph"); // importing a link cannot forge ownership
  });

  it("blocks duplicate, generic deletion, transform, and cross-page paste while allowing reorder", () => {
    const editor = mount();
    const pos = editor.state.doc.child(0).nodeSize;
    editor.commands.setNodeSelection(pos);
    expect(currentBlock(editor)?.node.type.name).toBe("childPage");
    expect(editor.commands.duplicateBlock()).toBe(false);
    editor.commands.deleteSelection();
    expect(editor.state.doc.childCount).toBe(3);
    editor.commands.insertContent({ type: "paragraph", content: [{ type: "text", text: "replace" }] });
    expect(editor.state.doc.child(1).type.name).toBe("childPage");
    editor.commands.insertContentAt(editor.state.doc.content.size, child);
    expect(editor.state.doc.childCount).toBe(3);
    editor.commands.setNodeSelection(pos);
    expect(editor.commands.moveBlockUp()).toBe(true);
    expect(editor.state.doc.child(0).attrs.pageId).toBe("pg_child");
    expect(editor.getText()).toContain("Keep my text");
  });

  it("routes keyboard deletion to archive and blocks range cuts without removing content", async () => {
    const archive = vi.fn(async () => {});
    const host: ChildPageHost = { archive, resolve: async () => [], create: async () => ({ id: "new", title: "Untitled" }), open: () => {} };
    const editor = mount(host);
    const pos = editor.state.doc.child(0).nodeSize;
    editor.commands.setNodeSelection(pos);
    const event = new KeyboardEvent("keydown", { key: "Backspace", cancelable: true });
    editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, event));
    await Promise.resolve();
    expect(archive).toHaveBeenCalledWith("pg_child");
    expect(editor.state.doc.childCount).toBe(3);
    archive.mockClear();
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    const cut = new Event("cut", { cancelable: true });
    editor.view.someProp("handleDOMEvents", (handlers) => handlers.cut?.(editor.view, cut as ClipboardEvent));
    expect(cut.defaultPrevented).toBe(true);
    expect(archive).not.toHaveBeenCalled();
    expect(editor.getText()).toContain("Keep my text");
  });

  it("cleans the slash command before asking the host to create without inserting a local node", () => {
    const editor = new Editor({ extensions: schemaExtensions(), content: "<p>/page</p>" });
    editors.push(editor);
    const create = vi.fn(() => expect(editor.getText()).toBe(""));
    slashItems({ createPage: create }).find((item) => item.id === "page")!.run(editor, { from: 1, to: 6 });
    expect(create).toHaveBeenCalledOnce();
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(toMarkdown({ type: "doc", content: [{ type: "childPage", attrs: { pageId: "pg_blank" } }] })).toBe("[Untitled](/p/pg_blank)\n");
  });

  it("renders live authorized titles, uses host navigation, and hides unavailable metadata", async () => {
    let title = "Live title";
    let available = true;
    let invalidate = () => {};
    const open = vi.fn();
    const unsubscribe = vi.fn();
    const host: ChildPageHost = {
      resolve: async () => available ? [{ id: "pg_child", title }] : [],
      open,
      create: async () => ({ id: "new", title: "Untitled" }),
      archive: async () => {},
      subscribe: (fn) => { invalidate = fn; return unsubscribe; },
    };
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({ element, content: { type: "doc", content: [child] }, extensions: schemaExtensions().map((e) => e.name === "childPage" ? childPageWithView(() => host, () => {}) : e) });
    editors.push(editor);
    await Promise.resolve();
    const button = element.querySelector<HTMLButtonElement>(".ws-child-page button")!;
    expect(button.textContent).toContain("Live title");
    expect(button.querySelector(".ws-child-page-icon")?.textContent).toBe("");
    button.click();
    expect(open).toHaveBeenCalledWith("pg_child");
    title = "Renamed child";
    invalidate(); await Promise.resolve();
    expect(button.textContent).toContain("Renamed child");
    expect(editor.getJSON().content?.[0]?.attrs?.title).toBe("Project [notes]");
    available = false;
    invalidate(); await Promise.resolve();
    expect(button.textContent).toContain("Page unavailable");
    expect(button.disabled).toBe(true);
    editor.destroy();
    expect(unsubscribe).toHaveBeenCalled();
    editors.pop(); element.remove();
  });

  it("the native Page picker sends a stable anchor and opens the result without a duplicate local block", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const [{ act, createElement }, { createRoot }, { Awareness }, { WorkspaceEditor }] = await Promise.all([
      import("react"), import("react-dom/client"), import("y-protocols/awareness"), import("../src/Editor"),
    ]);
    const doc = new Y.Doc();
    doc.getXmlFragment(FRAGMENT).insert(0, [jsonToY(paragraph)]);
    const awareness = new Awareness(doc);
    const open = vi.fn();
    const create = vi.fn(async ({ afterBlockId }: { afterBlockId?: string }) => {
      expect(afterBlockId).toBe("p1");
      return { id: "pg_new", title: "Untitled" };
    });
    let ready = false;
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    await act(async () => root.render(createElement(WorkspaceEditor, {
      doc, awareness, user: { name: "Test", color: "#000" }, editable: true, toolbar: "fixed", onReady: () => { ready = true; },
      childPages: { resolve: async () => [], create, open, archive: async () => {} },
    })));
    for (let i = 0; i < 50 && !ready; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Insert block"]')!.click());
    const pageButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".ws-picker-list button")).find((button) => button.textContent?.startsWith("Page"))!;
    expect(pageButton).toBeDefined();
    await act(async () => pageButton.click());
    expect(create).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("pg_new");
    expect(yToJSON(doc.getXmlFragment(FRAGMENT)).content?.map((node) => node.type)).toEqual(["paragraph"]);
    await act(async () => root.unmount());
    awareness.destroy(); doc.destroy(); container.remove();
  });
});
