import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { FRAGMENT, fromMarkdown, jsonToY, plainText, yToJSON } from "@workspace/core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { schemaExtensions } from "../src/schema";

function mount(doc: Y.Doc) {
  return new Editor({ extensions: [...schemaExtensions(), Collaboration.configure({ document: doc, field: FRAGMENT })] });
}

describe("editor <-> server encoding", () => {
  it("editor output is readable by the server converter, with stable ids", () => {
    const doc = new Y.Doc();
    const editor = mount(doc);
    editor.commands.setContent("<h1>Title</h1><p>Some <strong>bold</strong> <a href=\"https://example.com\">link</a></p><ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><p>done</p></li></ul>");
    const json = yToJSON(doc.getXmlFragment(FRAGMENT));
    expect(json.content!.map((n) => n.type)).toEqual(["heading", "paragraph", "taskList"]);
    expect(json.content![1]!.content![1]!.marks).toEqual([{ type: "bold" }]);
    for (const block of json.content!) expect(typeof block.attrs?.id).toBe("string");
    expect(plainText(json)).toBe("Title\nSome bold link\ndone");
    editor.destroy();
  });

  it("server-inserted content (MCP) renders in the editor and validates against the schema", () => {
    const doc = new Y.Doc();
    const editor = mount(doc);
    const md = fromMarkdown("## From agent\n\n- one\n- two\n\n<details>\n<summary>More</summary>\n\nhidden\n\n</details>\n");
    doc.getXmlFragment(FRAGMENT).insert(0, md.content!.map(jsonToY));
    expect(editor.getText()).toContain("From agent");
    expect(editor.getHTML()).toContain("<li>");
    expect(() => editor.schema.nodeFromJSON(yToJSON(doc.getXmlFragment(FRAGMENT))).check()).not.toThrow();
    editor.destroy();
  });
});
