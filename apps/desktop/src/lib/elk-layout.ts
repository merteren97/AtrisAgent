export type ElkDirection = 'RIGHT' | 'DOWN';

export interface LayoutNodeInput {
  id: string;
  width?: number;
  height?: number;
}

export interface LayoutEdgeInput {
  id?: string;
  source: string;
  target: string;
}

export interface ComputeLayeredGraphLayoutOptions {
  direction?: ElkDirection;
  nodeSpacing?: number;
  layerSpacing?: number;
  defaultWidth?: number;
  defaultHeight?: number;
}

export interface LayoutPosition {
  x: number;
  y: number;
}

export type LayoutPositionMap = Record<string, LayoutPosition>;

const DEFAULT_NODE_WIDTH = 272;
const DEFAULT_NODE_HEIGHT = 132;
const DEFAULT_NODE_SPACING = 44;
const DEFAULT_LAYER_SPACING = 92;

const layoutCache = new Map<string, LayoutPositionMap>();
const inFlightCache = new Map<string, Promise<LayoutPositionMap>>();

export function computeStructuralHash(
  nodes: ReadonlyArray<LayoutNodeInput>,
  edges: ReadonlyArray<LayoutEdgeInput>,
  direction: ElkDirection,
): string {
  const nodePart = nodes
    .map((n) => n.id)
    .slice()
    .sort()
    .join(',');
  const edgePart = edges
    .map((e) => `${e.source}->${e.target}`)
    .slice()
    .sort()
    .join(',');
  return `${direction}|N:[${nodePart}]|E:[${edgePart}]`;
}

export function clearElkLayoutCache(): void {
  layoutCache.clear();
  inFlightCache.clear();
}

/**
 * Deterministic topological layer fallback if ELK fails or returns empty coordinates.
 */
export function computeFallbackLayeredLayout(
  nodes: ReadonlyArray<LayoutNodeInput>,
  edges: ReadonlyArray<LayoutEdgeInput>,
  options: ComputeLayeredGraphLayoutOptions = {},
): LayoutPositionMap {
  if (nodes.length === 0) return {};
  const direction = options.direction ?? 'RIGHT';
  const nodeWidth = options.defaultWidth ?? DEFAULT_NODE_WIDTH;
  const nodeHeight = options.defaultHeight ?? DEFAULT_NODE_HEIGHT;
  const nodeSpacing = options.nodeSpacing ?? DEFAULT_NODE_SPACING;
  const layerSpacing = options.layerSpacing ?? DEFAULT_LAYER_SPACING;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
  }

  const layerByNode = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if ((incoming.get(node.id) || 0) === 0) {
      layerByNode.set(node.id, 0);
      queue.push(node.id);
    }
  }

  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    const currentLayer = layerByNode.get(current) || 0;
    for (const next of outgoing.get(current) || []) {
      const candidateLayer = currentLayer + 1;
      if ((layerByNode.get(next) ?? -1) < candidateLayer) {
        layerByNode.set(next, candidateLayer);
      }
      const nextIn = (incoming.get(next) || 1) - 1;
      incoming.set(next, nextIn);
      if (nextIn === 0) queue.push(next);
    }
  }

  for (const node of nodes) {
    if (!layerByNode.has(node.id)) layerByNode.set(node.id, 0);
  }

  const layers = new Map<number, LayoutNodeInput[]>();
  for (const node of nodes) {
    const layer = layerByNode.get(node.id) || 0;
    const list = layers.get(layer) || [];
    list.push(node);
    layers.set(layer, list);
  }

  const positions: LayoutPositionMap = {};
  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);
  for (const layerIndex of sortedLayers) {
    const bucket = layers.get(layerIndex) || [];
    bucket.forEach((node, indexInLayer) => {
      const w = node.width ?? nodeWidth;
      const h = node.height ?? nodeHeight;
      if (direction === 'RIGHT') {
        positions[node.id] = {
          x: layerIndex * (w + layerSpacing),
          y: indexInLayer * (h + nodeSpacing),
        };
      } else {
        positions[node.id] = {
          x: indexInLayer * (w + nodeSpacing),
          y: layerIndex * (h + layerSpacing),
        };
      }
    });
  }
  return positions;
}

export async function computeLayeredGraphLayout(
  nodes: ReadonlyArray<LayoutNodeInput>,
  edges: ReadonlyArray<LayoutEdgeInput>,
  options: ComputeLayeredGraphLayoutOptions = {},
): Promise<LayoutPositionMap> {
  if (nodes.length === 0) return {};
  const direction: ElkDirection = options.direction ?? 'RIGHT';
  const hash = computeStructuralHash(nodes, edges, direction);

  const cached = layoutCache.get(hash);
  if (cached) return cached;

  const pending = inFlightCache.get(hash);
  if (pending) return pending;

  const nodeSpacing = options.nodeSpacing ?? DEFAULT_NODE_SPACING;
  const layerSpacing = options.layerSpacing ?? DEFAULT_LAYER_SPACING;
  const defaultWidth = options.defaultWidth ?? DEFAULT_NODE_WIDTH;
  const defaultHeight = options.defaultHeight ?? DEFAULT_NODE_HEIGHT;

  const task = (async (): Promise<LayoutPositionMap> => {
    try {
      const elkModule = await import('elkjs/lib/elk.bundled.js');
      const ELKConstructor = (elkModule as { default?: new () => { layout: (graph: unknown) => Promise<any> } }).default
        ?? (elkModule as unknown as new () => { layout: (graph: unknown) => Promise<any> });
      const elk = new ELKConstructor();

      const nodeIdSet = new Set(nodes.map((n) => n.id));
      const validEdges = edges.filter(
        (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target) && e.source !== e.target,
      );

      const graph = {
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': direction,
          'elk.spacing.nodeNode': String(nodeSpacing),
          'elk.layered.spacing.nodeNodeBetweenLayers': String(layerSpacing),
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        },
        children: nodes.map((node) => ({
          id: node.id,
          width: node.width ?? defaultWidth,
          height: node.height ?? defaultHeight,
        })),
        edges: validEdges.map((edge, idx) => ({
          id: edge.id || `e-${idx}-${edge.source}-${edge.target}`,
          sources: [edge.source],
          targets: [edge.target],
        })),
      };

      const laidOut = await elk.layout(graph);
      const children: Array<{ id: string; x?: number; y?: number }> = Array.isArray(laidOut?.children)
        ? laidOut.children
        : [];
      const positions: LayoutPositionMap = {};
      for (const child of children) {
        if (typeof child.x === 'number' && typeof child.y === 'number') {
          positions[child.id] = { x: child.x, y: child.y };
        }
      }

      if (Object.keys(positions).length === nodes.length) {
        layoutCache.set(hash, positions);
        return positions;
      }

      const fallback = computeFallbackLayeredLayout(nodes, edges, options);
      layoutCache.set(hash, fallback);
      return fallback;
    } catch {
      const fallback = computeFallbackLayeredLayout(nodes, edges, options);
      layoutCache.set(hash, fallback);
      return fallback;
    } finally {
      inFlightCache.delete(hash);
    }
  })();

  inFlightCache.set(hash, task);
  return task;
}
