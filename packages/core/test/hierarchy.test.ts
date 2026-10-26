import { describe, expect, it } from "vitest";
import type { HierarchyNode } from "../src/contracts";
import { hierarchyEdgePath, layoutHierarchy } from "../src/hierarchy";

const node = (id: string, parentId: string | null, position = "a0", kind: HierarchyNode["kind"] = "page"): HierarchyNode => ({
  id, parentId, position, kind, workspaceId: "ws_test", databaseId: kind === "record" ? parentId : null,
  isDatabase: kind === "database", title: id, icon: null, state: "active", hasChildren: true,
  revision: 1, updatedAt: 0, url: `/p/${id}`,
});
const options = { rootId: "workspace", rootTitle: "Workspace" };

describe("hierarchy layout", () => {
  it("shows only expanded branches and preserves the full database-record-page ancestry", () => {
    const input = [node("database", null, "a0", "database"), node("record", "database", "a0", "record"), node("subpage", "record")];
    expect(layoutHierarchy(input, new Set(), options).nodes.map((n) => n.id)).toEqual(["workspace", "database"]);
    const full = layoutHierarchy(input, new Set(["database", "record"]), options);
    expect(full.nodes.map((n) => n.id)).toEqual(["workspace", "database", "record", "subpage"]);
    expect(full.edges).toHaveLength(3);
    expect(full.nodes.every((n) => n.x >= 0 && n.y >= 0)).toBe(true);
    expect(full.nodes[3]!.x).toBeGreaterThan(full.nodes[2]!.x);
    expect(hierarchyEdgePath(full.edges[0]!)).toMatch(/^M.+C/);
  });

  it("returns accessible depth-first order across multiple expanded roots", () => {
    const input = [node("A", null, "a0"), node("B", null, "a1"), node("A-child", "A"), node("A-grandchild", "A-child")];
    expect(layoutHierarchy(input, new Set(["A", "A-child"]), options).nodes.map((n) => n.id)).toEqual(["workspace", "A", "A-child", "A-grandchild", "B"]);
  });

  it("deduplicates focused-path and branch results and uses binary sibling ordering", () => {
    const a = node("upper", null, "Z"), b = node("lower", null, "a");
    const layout = layoutHierarchy([b, a, { ...a, title: "Renamed" }], new Set(), options);
    expect(layout.nodes.map((n) => n.id)).toEqual(["workspace", "upper", "lower"]);
    expect(layout.nodes[1]!.node?.title).toBe("Renamed");
  });

  it("keeps large collapsed databases cheap and does not invent parents for orphaned metadata", () => {
    const input = [node("database", null, "a0", "database"), ...Array.from({ length: 10_000 }, (_, i) => node(`record${i}`, "database", String(i), "record")), node("orphan", "missing")];
    const layout = layoutHierarchy(input, new Set(), options);
    expect(layout.nodes.map((n) => n.id)).toEqual(["workspace", "database"]);
    expect(layout.edges).toHaveLength(1);
  });
});
