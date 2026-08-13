export interface MemoryGraphNodeLike {
  id: string;
  type: string;
  importance: number;
  pinned: boolean;
  updatedAt: string;
}

export interface MemoryGraphEdgeLike {
  fromNodeId: string;
  toNodeId: string;
}

export interface MemoryGraphPoint {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface MemoryGraphLayout {
  points: MemoryGraphPoint[];
  renderedNodeIds: Set<string>;
  truncated: boolean;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nodePriority(node: MemoryGraphNodeLike): number {
  const updated = Number.isFinite(Date.parse(node.updatedAt)) ? Date.parse(node.updatedAt) : 0;
  return (node.pinned ? 10_000_000_000_000 : 0) + node.importance * 1_000_000_000_000 + updated;
}

/**
 * Produces a deterministic, dependency-free graph layout suitable for the
 * Inspector's SVG renderer. Nodes are grouped by memory type, with high-value
 * and pinned nodes closer to each group center. The same snapshot therefore
 * keeps stable positions across refreshes instead of visually jumping around.
 */
export function buildMemoryGraphLayout(
  nodes: MemoryGraphNodeLike[],
  edges: MemoryGraphEdgeLike[],
  maxNodes = 500,
): MemoryGraphLayout {
  if (nodes.length === 0) return { points: [], renderedNodeIds: new Set(), truncated: false };

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) || 0) + 1);
    degree.set(edge.toNodeId, (degree.get(edge.toNodeId) || 0) + 1);
  }

  const selected = [...nodes]
    .sort((a, b) => {
      const degreeDelta = (degree.get(b.id) || 0) - (degree.get(a.id) || 0);
      if (degreeDelta !== 0) return degreeDelta;
      return nodePriority(b) - nodePriority(a);
    })
    .slice(0, Math.max(1, maxNodes));
  const renderedNodeIds = new Set(selected.map((node) => node.id));

  const groups = new Map<string, MemoryGraphNodeLike[]>();
  for (const node of selected) {
    const values = groups.get(node.type) || [];
    values.push(node);
    groups.set(node.type, values);
  }

  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const groupCount = orderedGroups.length;
  const canvasRadius = groupCount <= 1 ? 0 : 270;
  const points: MemoryGraphPoint[] = [];

  orderedGroups.forEach(([type, groupNodes], groupIndex) => {
    const groupAngle = groupCount <= 1 ? 0 : (groupIndex / groupCount) * Math.PI * 2 - Math.PI / 2;
    const centerX = Math.cos(groupAngle) * canvasRadius;
    const centerY = Math.sin(groupAngle) * canvasRadius;
    const sorted = [...groupNodes].sort((a, b) => nodePriority(b) - nodePriority(a));

    sorted.forEach((node, index) => {
      const seed = hashString(`${type}:${node.id}`);
      const angleJitter = (seed % 1000) / 1000 * 0.45;
      const angle = index * GOLDEN_ANGLE + angleJitter;
      const ringRadius = index === 0 ? 0 : Math.min(205, 34 + Math.sqrt(index) * 32);
      const x = centerX + Math.cos(angle) * ringRadius;
      const y = centerY + Math.sin(angle) * ringRadius;
      const nodeDegree = degree.get(node.id) || 0;
      const radius = Math.max(5, Math.min(15, 6 + node.importance * 5 + Math.sqrt(nodeDegree) * 1.35 + (node.pinned ? 1.5 : 0)));
      points.push({ id: node.id, x, y, radius });
    });
  });

  return {
    points,
    renderedNodeIds,
    truncated: selected.length < nodes.length,
  };
}

export function connectedMemoryNodeIds(
  nodeId: string,
  edges: MemoryGraphEdgeLike[],
): Set<string> {
  const connected = new Set<string>([nodeId]);
  for (const edge of edges) {
    if (edge.fromNodeId === nodeId) connected.add(edge.toNodeId);
    if (edge.toNodeId === nodeId) connected.add(edge.fromNodeId);
  }
  return connected;
}
