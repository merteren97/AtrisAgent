import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ManualChangeReview } from './manual-change-review';

function fixture(run: (review: ManualChangeReview, project: string, id: string, work: string, data: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-test-'));
  try {
    const project = path.join(root, 'project'), data = path.join(root, 'data');
    fs.mkdirSync(data); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.env'), 'private fixture');
    fs.writeFileSync(path.join(project, 'a.ts'), 'dirty at start\n');
    fs.writeFileSync(path.join(project, 'b.ts'), 'keep\n');
    const review = new ManualChangeReview(data), id = randomUUID();
    review.initialize(id, project);
    run(review, project, id, review.scope(id, project).work, data);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('keeps changes private, shares the copy by conversation ID, and applies only the selected files', () => fixture((review, project, id, work, data) => {
  assert.equal(fs.existsSync(path.join(work, '.env')), false);
  assert.deepEqual(review.list(id, project).files, []);
  fs.writeFileSync(path.join(work, 'a.ts'), 'new\n');
  fs.unlinkSync(path.join(work, 'b.ts'));
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'src', 'new file.ts'), 'export {};\n');
  const other = randomUUID();
  review.initialize(other, project);
  assert.deepEqual(review.list(other, project).files, []);
  const afterRestart = new ManualChangeReview(data);
  afterRestart.initialize(id, project);
  const files = afterRestart.list(id, project).files;
  assert.deepEqual(files.map(file => file.status), ['modified', 'deleted', 'added']);
  assert.deepEqual(afterRestart.preview(id, project, files[0].path, files[0].revision), { before: 'dirty at start\n', after: 'new\n' });
  assert.equal(fs.readFileSync(path.join(project, 'a.ts'), 'utf8'), 'dirty at start\n');
  assert.deepEqual(review.resolve(id, project, 'apply', [files[0], files[2]]), { completed: ['a.ts', 'src/new file.ts'] });
  assert.equal(fs.readFileSync(path.join(project, 'a.ts'), 'utf8'), 'new\n');
  assert.equal(fs.readFileSync(path.join(project, 'b.ts'), 'utf8'), 'keep\n');
  assert.equal(fs.readFileSync(path.join(project, 'src/new file.ts'), 'utf8'), 'export {};\n');
  assert.deepEqual(review.resolve(id, project, 'discard', review.list(id, project).files), { completed: ['b.ts'] });
  assert.equal(fs.readFileSync(path.join(work, 'b.ts'), 'utf8'), 'keep\n');
  fs.writeFileSync(path.join(work, 'a.ts'), 'changed again\n');
  fs.writeFileSync(path.join(work, 'temporary'), 'to be discarded\n');
  review.resolve(id, project, 'discard', review.list(id, project).files);
  assert.equal(fs.readFileSync(path.join(work, 'a.ts'), 'utf8'), 'new\n');
  assert.equal(fs.existsSync(path.join(work, 'temporary')), false);
  assert.deepEqual(review.list(id, project).files, []);
}));

test('rejects stale approvals and preflights all selected files before any overwrite', () => fixture((review, project, id, work) => {
  fs.writeFileSync(path.join(work, 'a.ts'), 'agent a');
  fs.writeFileSync(path.join(work, 'b.ts'), 'agent b');
  const first = review.list(id, project).files;
  fs.writeFileSync(path.join(work, 'b.ts'), 'later b');
  assert.throws(() => review.resolve(id, project, 'apply', first), /Changed since review: b\.ts/);
  assert.throws(() => review.preview(id, project, first[1].path, first[1].revision), /changed/i);
  fs.writeFileSync(path.join(project, 'b.ts'), 'user b');
  const next = review.list(id, project).files;
  assert.throws(() => review.resolve(id, project, 'apply', next), /different changes: b\.ts/);
  assert.equal(fs.readFileSync(path.join(project, 'a.ts'), 'utf8'), 'dirty at start\n');
  assert.equal(fs.readFileSync(path.join(project, 'b.ts'), 'utf8'), 'user b');
  assert.throws(() => review.preview(id, project, '../owner.json', ''), /outside the review scope/);
}));

test('reviews deletions and refuses writes through redirected directories', () => fixture((review, project, id, work, data) => {
  fs.unlinkSync(path.join(work, 'a.ts'));
  assert.deepEqual(review.resolve(id, project, 'apply', review.list(id, project).files), { completed: ['a.ts'] });
  assert.equal(fs.existsSync(path.join(project, 'a.ts')), false);
  const external = path.join(data, 'external');
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(project, 'alias'), 'junction');
  fs.mkdirSync(path.join(work, 'alias'));
  fs.writeFileSync(path.join(work, 'alias', 'new.ts'), 'must not escape');
  assert.throws(() => review.resolve(id, project, 'apply', review.list(id, project).files), /parent path has changed/i);
  assert.deepEqual(fs.readdirSync(external), []);
}));
