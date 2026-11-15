import assert from 'node:assert/strict';
import type { PlanningBoard } from '@/stores/planning-store';
import { boardChanges, boardProgress, flattenBoard, searchBoard, sectionAt, validBoardPath } from './planning-board-model';

const board: PlanningBoard = { schemaVersion: 1, planId: 'p', updatedAt: 'now', sections: [
  { id: 'design', title: 'Design', kind: 'section', status: 'done', children: [
    { id: 'screens', title: 'Ekranlar', kind: 'gallery', summary: 'Long Turkish description', items: [
      { id: 'screen', title: 'Welcome', status: 'done', body: 'Keyboard accessible', source: 'https://source.test/evidence' },
      { id: 'flow', title: 'Flow', status: 'blocked', prompt: 'Confirm navigation' },
      { id: 'reference', title: 'Untracked note' },
    ] },
  ] },
] };
const entries = flattenBoard(board.sections);
assert.deepEqual(boardProgress(entries), { total: 3, tracked: 2, done: 1, blocked: 1 }, 'sections do not inflate item progress and untracked notes do not inflate tracked denominator');
assert.equal(searchBoard(entries, 'SOURCE evidence', '')[0].item?.id, 'screen', 'search includes sources and is case-insensitive');
assert.equal(searchBoard(entries, 'confirm', 'blocked')[0].item?.id, 'flow', 'prompt and status filters combine');
assert.equal(searchBoard(entries, 'confirm', 'done').length, 0);
assert.deepEqual(validBoardPath(board.sections, ['design', 'removed', 'screens']), ['design'], 'deleted selection recovers to valid ancestor');
assert.equal(sectionAt(board.sections, ['missing', 'screens']), undefined, 'missing parents cannot resolve a similarly named child from another branch');
const changed = structuredClone(board);
changed.sections[0].children![0].items![0].title = 'Welcome v2';
changed.sections[0].children![0].items![1].status = 'review';
changed.sections[0].children![0].items!.splice(2, 1);
changed.sections.push({ id: 'research', title: 'Research', kind: 'research' });
const diff = boardChanges(board, changed);
assert(diff.includes('Renamed “Welcome” to “Welcome v2”'));
assert(diff.includes('Flow: blocked → review'));
assert(diff.includes('Removed item: Untracked note'));
assert(diff.includes('Added section: Research'));
assert(!diff.includes('Updated content: Design'), 'descendant changes do not duplicate parent content changes');
assert.deepEqual(boardChanges(board, { ...board, updatedAt: 'later' }), [], 'timestamps alone do not appear as content changes');
assert(boardChanges(board, { ...board, appearance: { font: 'editorial', accent: 'sage', density: 'comfortable' } }).includes('Updated typography, accent or spacing'));
console.log('Planning board search, progress, selection recovery and semantic changes passed.');
