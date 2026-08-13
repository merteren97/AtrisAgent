import { buildMemoryGraphLayout, connectedMemoryNodeIds } from './memory-graph';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[FAIL] ${message}`);
  console.log(`[PASS] ${message}`);
}

const nodes = [
  { id: 'project', type: 'project', importance: 1, pinned: true, updatedAt: '2026-08-13T10:00:00.000Z' },
  { id: 'decision', type: 'decision', importance: 0.9, pinned: true, updatedAt: '2026-08-13T10:01:00.000Z' },
  { id: 'research', type: 'research_finding', importance: 0.8, pinned: false, updatedAt: '2026-08-13T10:02:00.000Z' },
  { id: 'file', type: 'file', importance: 0.5, pinned: false, updatedAt: '2026-08-13T10:03:00.000Z' },
];
const edges = [
  { fromNodeId: 'project', toNodeId: 'decision' },
  { fromNodeId: 'decision', toNodeId: 'research' },
];

const first = buildMemoryGraphLayout(nodes, edges, 3);
const second = buildMemoryGraphLayout(nodes, edges, 3);
assert(first.truncated, 'layout reports truncation when the graph exceeds the render budget');
assert(first.points.length === 3, 'layout respects the render budget');
assert(JSON.stringify(first.points) === JSON.stringify(second.points), 'layout is stable across refreshes for the same graph');
assert(first.renderedNodeIds.has('project'), 'high-value project root remains in a truncated graph');
assert(first.renderedNodeIds.has('decision'), 'connected high-importance memory remains visible');

const connected = connectedMemoryNodeIds('decision', edges);
assert(connected.has('project') && connected.has('research') && connected.size === 3, 'selected-node neighborhood contains direct graph neighbors only');

console.log('--- Memory Graph Tests Complete ---');
