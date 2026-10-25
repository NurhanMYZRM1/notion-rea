import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  agentCan,
  assignIds,
  can,
  FRAGMENT,
  findBlock,
  fromMarkdown,
  jsonToY,
  parseCsv,
  plainText,
  toCsv,
  toMarkdown,
  yToJSON,
  type PMNode,
} from "../src";

const sample: PMNode = {
  type: "doc",
  content: [
    { type: "heading", attrs: { id: "h1", level: 1 }, content: [{ type: "text", text: "Plan" }] },
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
        { type: "text", text: " and " },
        { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
      ],
    },
    {
      type: "taskList",
      attrs: { id: "t" },
      content: [{ type: "taskItem", attrs: { id: "t1", checked: true }, content: [{ type: "paragraph", attrs: { id: "tp" }, content: [{ type: "text", text: "done" }] }] }],
    },
    { type: "codeBlock", attrs: { id: "c", language: "ts" }, content: [{ type: "text", text: "const a = `x`;" }] },
    { type: "horizontalRule", attrs: { id: "hr" } },
  ],
};

describe("Y <-> JSON", () => {
  it("round-trips nodes, attrs and marks", () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(FRAGMENT);
    frag.insert(0, sample.content!.map(jsonToY));
    expect(yToJSON(frag)).toEqual(sample);
  });

  it("finds nested blocks by id", () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(FRAGMENT);
    frag.insert(0, sample.content!.map(jsonToY));
    const loc = findBlock(frag, "tp");
    expect(loc?.element.nodeName).toBe("paragraph");
    expect(loc?.index).toBe(0);
    expect(findBlock(frag, "missing")).toBeNull();
  });

  it("extracts plain text for search", () => {
    expect(plainText(sample)).toBe("Plan\nbold and link\ndone\nconst a = `x`;");
  });

  it("assigns ids only where missing", () => {
    let n = 0;
    const out = assignIds({ type: "paragraph", content: [{ type: "text", text: "x" }] }, () => `b${++n}`);
    expect(out.attrs).toEqual({ id: "b1" });
  });
});

describe("markdown", () => {
  it("exports and re-imports common blocks", () => {
    const md = toMarkdown(sample);
    expect(md).toContain("# Plan");
    expect(md).toContain("**bold** and [link](https://example.com)");
    expect(md).toContain("- [x] done");
    const back = fromMarkdown(md);
    const types = back.content!.map((n) => n.type);
    expect(types).toEqual(["heading", "paragraph", "taskList", "codeBlock", "horizontalRule"]);
    expect(plainText(back)).toBe(plainText(sample));
  });

  it("handles unicode, nested lists and toggles", () => {
    const md = "## Überblick 日本語 🚀\n\n- one\n  - nested\n- two\n\n1. first\n2. second\n\n> quote\n\n<details>\n<summary>More</summary>\n\nhidden text\n\n</details>\n";
    const doc = fromMarkdown(md);
    expect(doc.content!.map((n) => n.type)).toEqual(["heading", "bulletList", "orderedList", "blockquote", "details"]);
    expect(plainText(doc)).toContain("Überblick 日本語 🚀");
    expect(plainText(doc)).toContain("nested");
    expect(plainText(doc)).toContain("hidden text");
    expect(toMarkdown(doc)).toContain("<summary>More</summary>");
  });

  it("reports unsupported content instead of dropping it silently", () => {
    const report = { warnings: [] as string[] };
    const doc = fromMarkdown("#### deep\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![x](https://evil.example/p.png)\n\n[js](javascript:alert(1))\n", report);
    expect(report.warnings.join("\n")).toMatch(/level 4/);
    expect(report.warnings.join("\n")).toMatch(/Table/);
    expect(report.warnings.join("\n")).toMatch(/External image/);
    expect(report.warnings.join("\n")).toMatch(/unsupported URL scheme/);
    expect(JSON.stringify(doc)).not.toContain("javascript:");
  });

  it("escapes markdown syntax in plain text", () => {
    const doc: PMNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "1. not a list *nor bold*" }] }] };
    const back = fromMarkdown(toMarkdown(doc));
    expect(back.content![0]!.type).toBe("paragraph");
    expect(plainText(back)).toBe("1. not a list *nor bold*");
  });
});

describe("csv", () => {
  it("parses quoted fields, escaped quotes and newlines", () => {
    const rows = parseCsv('﻿Name,Notes\r\n"Smith, J","said ""hi""\nthen left"\r\nÅsa,日本\n');
    expect(rows).toEqual([["Name", "Notes"], ["Smith, J", 'said "hi"\nthen left'], ["Åsa", "日本"]]);
  });
  it("rejects unterminated quotes", () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/unterminated/);
  });
  it("round-trips and neutralises formulas", () => {
    const csv = toCsv([["a", "b,c", '"q"'], ["=SUM(A1)", -5, true]]);
    expect(parseCsv(csv)).toEqual([["a", "b,c", '"q"'], ["'=SUM(A1)", "-5", "true"]]);
  });
});

describe("permissions", () => {
  it("maps roles to capabilities", () => {
    expect(can("viewer", "read")).toBe(true);
    expect(can("viewer", "write")).toBe(false);
    expect(can("editor", "manage_members")).toBe(false);
    expect(can("owner", "manage_members")).toBe(true);
    expect(can(null, "read")).toBe(false);
  });
  it("requires both scope and role for agents", () => {
    expect(agentCan("editor", ["workspace:read"], "write")).toBe(false);
    expect(agentCan("viewer", ["workspace:write"], "write")).toBe(false);
    expect(agentCan("editor", ["workspace:read", "workspace:write"], "write")).toBe(true);
    expect(agentCan("editor", ["workspace:write"], "archive")).toBe(false);
  });
});
