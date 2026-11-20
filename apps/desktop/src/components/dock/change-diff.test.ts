import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textRows, unifiedRows } from './change-diff';

test('renders additions, deletions and matched context with independent line numbers', () => {
  const rows = textRows('one\nold\ntail\n', 'first\none\nnew\ntail\n');
  assert.deepEqual(rows.map(row => [row.kind, row.text, row.before, row.after]), [
    ['add', 'first', undefined, 1], ['context', 'one', 1, 2], ['remove', 'old', 2, undefined],
    ['add', 'new', undefined, 3], ['context', 'tail', 3, 4],
  ]);
  assert.deepEqual(textRows(null, 'new\n'), [{ kind: 'add', text: 'new', after: 1 }]);
});

test('interprets hunk ranges and does not confuse edited header-like content with filenames', () => {
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -10,2 +12,2 @@', '--- literal', '+++ literal', ' tail',
    'diff --git a/y b/y', '--- /dev/null', '+++ "b/space name"', '@@ -0,0 +1 @@', '+new'].join('\n');
  const result = unifiedRows(diff);
  assert.deepEqual([...result.keys()], ['x', 'space name']);
  assert.deepEqual(result.get('x')?.slice(1).map(row => [row.text, row.before, row.after]), [['-- literal', 10, undefined], ['++ literal', undefined, 12], ['tail', 11, 13]]);
  const added = result.get('space name')!;
  assert.deepEqual(added[added.length - 1], { kind: 'add', after: 1, text: 'new' });
});
