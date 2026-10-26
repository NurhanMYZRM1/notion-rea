import { hierarchy, tree } from "d3-hierarchy";
import type { HierarchyNode } from "./contracts";

export interface PositionedHierarchyNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  node: HierarchyNode | null;
}
export interface HierarchyEdge {
  id: string;
  source: string;
  target: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface HierarchyLayoutOptions {
  rootId: string;
  rootTitle: string;
  nodeWidth?: number;
  nodeHeight?: number;
  levelGap?: number;
  siblingGap?: number;
}
interface Datum { id: string; node: HierarchyNode | null; children: Datum[] }

/** A deterministic, left-to-right tree over loaded metadata. Collapsed branches never enter the layout. */
export function layoutHierarchy(
  input: readonly HierarchyNode[],
  expanded: ReadonlySet<string>,
  options: HierarchyLayoutOptions,
): { nodes: PositionedHierarchyNode[]; edges: HierarchyEdge[]; width: number; height: number } {
  const nodeWidth = options.nodeWidth ?? 208;
  const nodeHeight = options.nodeHeight ?? 52;
  const byParent = new Map<string | null, HierarchyNode[]>();
  // Page metadata can appear in both an ancestry response and a paginated branch.
  const unique = new Map(input.map((node) => [node.id, node]));
  for (const node of unique.values()) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => compare(a.position, b.position) || compare(a.id, b.id));
  const seen = new Set<string>();
  const branch = (node: HierarchyNode): Datum | null => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const children = expanded.has(node.id) ? (byParent.get(node.id) ?? []).flatMap((child) => {
      const next = branch(child);
      return next ? [next] : [];
    }) : [];
    return { id: node.id, node, children };
  };
  const root: Datum = { id: options.rootId, node: null, children: (byParent.get(null) ?? []).flatMap((node) => {
    const next = branch(node);
    return next ? [next] : [];
  }) };
  const result = tree<Datum>().nodeSize([nodeHeight + (options.siblingGap ?? 24), nodeWidth + (options.levelGap ?? 80)])(hierarchy(root));
  const descendants: typeof result[] = [];
  result.eachBefore((point) => { descendants.push(point); });
  const minVertical = Math.min(...descendants.map((point) => point.x));
  const nodes = descendants.map((point): PositionedHierarchyNode => ({
    id: point.data.id, x: point.y + 24, y: point.x - minVertical + 24,
    width: nodeWidth, height: nodeHeight, depth: point.depth, node: point.data.node,
  }));
  const positioned = new Map(nodes.map((node) => [node.id, node]));
  const edges = result.links().map(({ source, target }): HierarchyEdge => {
    const from = positioned.get(source.data.id)!;
    const to = positioned.get(target.data.id)!;
    return { id: `${from.id}:${to.id}`, source: from.id, target: to.id, x1: from.x + from.width, y1: from.y + from.height / 2, x2: to.x, y2: to.y + to.height / 2 };
  });
  return { nodes, edges, width: Math.max(...nodes.map((node) => node.x + node.width)) + 24, height: Math.max(...nodes.map((node) => node.y + node.height)) + 24 };
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function hierarchyEdgePath(edge: HierarchyEdge): string {
  const middle = (edge.x1 + edge.x2) / 2;
  return `M${edge.x1},${edge.y1}C${middle},${edge.y1} ${middle},${edge.y2} ${edge.x2},${edge.y2}`;
}
