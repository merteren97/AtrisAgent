import assert from 'node:assert/strict';
import {
  clearElkLayoutCache,
  computeFallbackLayeredLayout,
  computeLayeredGraphLayout,
  computeStructuralHash,
} from './elk-layout';

clearElkLayoutCache();

const nodes = [
  { id: '__orchestrator__', width: 248, height: 108 },
  { id: 'task-a', width: 272, height: 132 },
  { id: 'task-b', width: 272, height: 132 },
  { id: '__verification_gate__', width: 216, height: 76 },
];

const edges = [
  { id: 'e1', source: '__orchestrator__', target: 'task-a' },
  { id: 'e2', source: 'task-a', target: 'task-b' },
  { id: 'e3', source: 'task-b', target: '__verification_gate__' },
];

// 1. Structural hash is invariant to node order and edge order
const hash1 = computeStructuralHash(nodes, edges, 'RIGHT');
const hash2 = computeStructuralHash([...nodes].reverse(), [...edges].reverse(), 'RIGHT');
assert.equal(hash1, hash2, 'structural hash is order-independent');
assert.notEqual(
  hash1,
  computeStructuralHash(nodes, edges, 'DOWN'),
  'direction changes structural hash',
);

// 2. ELK layout produces valid coordinates for all nodes and memoizes by structural hash
const pos1 = await computeLayeredGraphLayout(nodes, edges, { direction: 'RIGHT' });
assert.equal(Object.keys(pos1).length, nodes.length, 'every node receives a position');
for (const node of nodes) {
  assert.equal(typeof pos1[node.id]?.x, 'number');
  assert.equal(typeof pos1[node.id]?.y, 'number');
}
assert.ok(
  pos1['__orchestrator__']!.x < pos1['task-a']!.x &&
    pos1['task-a']!.x < pos1['task-b']!.x &&
    pos1['task-b']!.x < pos1['__verification_gate__']!.x,
  'RIGHT direction places downstream nodes to the right',
);

const pos2 = await computeLayeredGraphLayout([...nodes].reverse(), [...edges].reverse(), {
  direction: 'RIGHT',
});
assert.equal(pos1, pos2, 'identical structure returns exact memoized layout object');

// 3. Fallback deterministic layout orders layers cleanly
const fallback = computeFallbackLayeredLayout(nodes, edges, { direction: 'RIGHT' });
assert.equal(Object.keys(fallback).length, nodes.length);
assert.ok(fallback['__orchestrator__']!.x < fallback['task-a']!.x);
assert.ok(fallback['task-a']!.x < fallback['task-b']!.x);

console.log('elk-layout tests passed');
