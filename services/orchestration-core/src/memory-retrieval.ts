import type {
  MemoryNode,
  MemoryQuery,
  MemoryRetrievalHit,
} from '@atris-agent-code/domain';

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}_./-]+/gu, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}

export function lexicalMemoryScore(node: MemoryNode, queryText: string): number {
  const queryTokens = tokens(queryText);
  if (queryTokens.size === 0) return 0;
  const nodeTokens = tokens(`${node.title} ${node.summary} ${node.body || ''} ${node.tags.join(' ')}`);
  let matches = 0;
  for (const token of queryTokens) if (nodeTokens.has(token)) matches += 1;
  return clamp01(matches / queryTokens.size);
}

export function recencyMemoryScore(updatedAt: string, now = new Date(), halfLifeDays = 120): number {
  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (now.getTime() - timestamp) / DAY_MS);
  return clamp01(Math.pow(0.5, ageDays / Math.max(1, halfLifeDays)));
}

export function graphDistanceScore(distance?: number): number {
  if (distance === undefined || distance < 0 || !Number.isFinite(distance)) return 0;
  return 1 / (1 + distance);
}

export function rankMemoryNodes(params: {
  nodes: MemoryNode[];
  query: MemoryQuery;
  graphDistances?: Map<string, number>;
  now?: Date;
}): MemoryRetrievalHit[] {
  const now = params.now || new Date();
  const allowedTypes = params.query.nodeTypes ? new Set(params.query.nodeTypes) : null;
  const allowedStatuses: Set<MemoryNode['status']> = params.query.statuses
    ? new Set(params.query.statuses)
    : new Set<MemoryNode['status']>(['active', 'stale', 'disputed']);

  const hits = params.nodes
    .filter((node) => node.projectId === params.query.projectId)
    .filter((node) => !allowedTypes || allowedTypes.has(node.type))
    .filter((node) => params.query.includeArchived || node.status !== 'archived')
    .filter((node) => allowedStatuses.has(node.status))
    .map((node): MemoryRetrievalHit => {
      const lexicalScore = lexicalMemoryScore(node, params.query.text);
      const graphScore = graphDistanceScore(params.graphDistances?.get(node.id));
      const confidenceScore = clamp01(node.confidence);
      const importanceScore = clamp01(node.importance);
      const recencyScore = recencyMemoryScore(node.updatedAt, now);
      const pinnedBoost = node.pinned ? 0.08 : 0;
      const stalePenalty = node.status === 'stale' ? 0.1 : node.status === 'disputed' ? 0.16 : 0;
      const score = clamp01(
        lexicalScore * 0.44
        + graphScore * 0.2
        + confidenceScore * 0.14
        + importanceScore * 0.14
        + recencyScore * 0.08
        + pinnedBoost
        - stalePenalty,
      );
      return {
        node,
        score,
        lexicalScore,
        graphScore,
        confidenceScore,
        importanceScore,
        recencyScore,
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt));

  return hits.slice(0, Math.max(1, params.query.limit || 12));
}
