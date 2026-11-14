import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { PlanningStore } from './planning-store';
import { createPlanningMediaAccess, installPlanningRoutes, planningByteRange } from './planning-routes';

async function fixture(t: TestContext, maxAssetBytes = 1024) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-planning-routes-'));
  for (const id of ['one', 'two']) fs.mkdirSync(path.join(root, id));
  const store = new PlanningStore((id) => ['one', 'two'].includes(id) ? { id, path: path.join(root, id) } : undefined, { maxAssetBytes });
  store.create('one', { id: 'plan-one', title: 'Media plan' });
  let clock = Date.now();
  let fenced = false;
  const media = createPlanningMediaAccess(store, { clock: () => clock, ttlMs: 1000, fenced: () => fenced });
  const app = express();
  app.use(media.middleware);
  app.use((req, res, next) => { if (req.headers.authorization !== 'Bearer local-test') res.status(401).json({ error: 'Runtime token required' }); else next(); });
  app.use(express.json({ limit: '5mb' }));
  installPlanningRoutes(app, store, { mediaAccess: media, fenced: () => fenced });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = '/api/workspaces/one/plans/plan-one';
  const request = (relative: string, init: RequestInit = {}) => fetch(`${origin}${relative}`, { ...init, headers: { Authorization: 'Bearer local-test', ...init.headers } });
  return { store, origin, base, request, advance: () => { clock += 1001; }, fence: () => { fenced = true; } };
}
const jsonBody = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('Markdown can be imported atomically as a new plan with its original content', async (t) => {
  const { store, request } = await fixture(t);
  const content = '# Existing plan\n\n![Portable reference](assets/diagram.png)\n';
  const imported = await request('/api/workspaces/one/plans/import', jsonBody({ id: 'imported-plan', title: 'Existing plan', content }));
  assert.equal(imported.status, 201);
  assert.equal((await imported.json() as any).id, 'imported-plan');
  assert.equal(store.readDocument('one', 'imported-plan', 'plan.md').content, content);
  assert.equal((await request('/api/workspaces/one/plans/import', jsonBody({ id: 'invalid-plan', title: 'Invalid', content: 'bad\u0000text' }))).status, 400);
  assert(!store.list('one').some((plan) => plan.id === 'invalid-plan'));
});

test('document routes expose real revisions and reject stale saves and scoped escapes', async (t) => {
  const { base, origin, request } = await fixture(t);
  assert.equal((await fetch(`${origin}${base}/document?path=plan.md`)).status, 401);
  const original = await (await request(`${base}/document?path=plan.md`)).json() as any;
  const save = { content: '# Saved from HTTP', expectedRevision: original.revision };
  const response = await request(`${base}/document?path=plan.md`, { ...jsonBody(save), method: 'PUT' });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).content, save.content);
  const stale = await request(`${base}/document?path=plan.md`, { ...jsonBody(save), method: 'PUT' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as any).code, 'REVISION_CONFLICT');
  assert.equal((await request(`${base}/document?path=research%2F..%2Fplan.md`)).status, 400);
  assert.equal((await request('/api/workspaces/two/plans/plan-one/document?path=plan.md')).status, 404);
  const imported = await request(`${base}/import`, jsonBody({ filename: 'notes.md', content: 'Portable import' }));
  assert.equal(imported.status, 201);
  assert.equal((await imported.json() as any).path, 'research/notes.md');
  const files = await (await request(`${base}/files`)).json() as any[];
  assert(files.some((file) => file.path === 'research/notes.md'));
});

test('raw asset uploads stream and validated media supports bounded and suffix ranges', async (t) => {
  const { store, base, request } = await fixture(t);
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from('0123456789abcdefghijklmnopqrstuv')]);
  const upload = await request(`${base}/assets?filename=clip.mp4&mimeType=video%2Fmp4`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(upload.status, 201, await upload.clone().text());
  assert.equal((await upload.json() as any).path, 'assets/clip.mp4');
  const content = `${base}/content?path=assets%2Fclip.mp4`;
  const first = await request(content, { headers: { Range: 'bytes=4-11' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), `bytes 4-11/${bytes.length}`);
  assert.equal(first.headers.get('content-type'), 'video/mp4');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes.subarray(4, 12));
  const suffix = await request(content, { headers: { Range: 'bytes=-5' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-5));
  const unsatisfiable = await request(content, { headers: { Range: 'bytes=10000-' } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${bytes.length}`);
  assert.equal((await request(content, { headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
  const head = await request(content, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(await head.text(), '');
  assert.equal(store.listFiles('one', 'plan-one').find((file) => file.path === 'assets/clip.mp4')?.byteSize, bytes.length);
});

test('opaque grants allow one exact media path without cookies and expire', async (t) => {
  const { store, origin, base, request, advance } = await fixture(t);
  for (const filename of ['one.txt', 'two.txt']) await store.importAsset('one', 'plan-one', { filename, mimeType: 'text/plain', stream: Readable.from([filename]) });
  const issued = await request(`${base}/media-grant`, jsonBody({ path: 'assets/one.txt' }));
  assert.equal(issued.status, 200);
  const grant = await issued.json() as any;
  assert(!grant.url.includes('local-test'));
  const allowed = await fetch(`${origin}${grant.url}`);
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'one.txt');
  assert.equal((await fetch(`${origin}${grant.url.replace('one.txt', 'two.txt')}`)).status, 401);
  assert.equal((await fetch(`${origin}${grant.url.replace('/one/', '/two/')}`)).status, 401);
  assert.equal((await fetch(`${origin}${grant.url.replace('/plan-one/', '/other-plan/')}`)).status, 401);
  assert.equal((await fetch(`${origin}${grant.url}`, { method: 'POST' })).status, 401);
  const token = new URL(grant.url, origin).searchParams.get('grant');
  assert.equal((await fetch(`${origin}/api/workspaces/one/plans?grant=${token}`)).status, 401);
  assert.equal((await fetch(`${origin}${base}/document?path=plan.md&grant=${token}`)).status, 401);
  advance();
  assert.equal((await fetch(`${origin}${grant.url}`)).status, 401);
});

test('media grants respect a workspace deletion fence even after issuance', async (t) => {
  const { origin, base, request, fence } = await fixture(t);
  const grant = await (await request(`${base}/media-grant`, jsonBody({ path: 'plan.md' }))).json() as any;
  fence();
  assert.equal((await fetch(`${origin}${grant.url}`)).status, 401);
  assert.equal((await request(`${base}/files`)).status, 409);
});

test('a file changed to HTML after a grant was issued is not streamed as media', async (t) => {
  const { store, origin, base, request } = await fixture(t);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const file = await store.importAsset('one', 'plan-one', { filename: 'safe.png', mimeType: 'image/png', stream: Readable.from([bytes]) });
  const grant = await (await request(`${base}/media-grant`, jsonBody({ path: file.path }))).json() as any;
  fs.writeFileSync(store.resolveFile('one', 'plan-one', file.path).absolutePath, '<script>unsafe()</script>');
  const response = await fetch(`${origin}${grant.url}`);
  assert.equal(response.status, 400);
  assert(response.headers.get('content-type')?.startsWith('application/json'));
  assert(!((await response.text()).includes('<script>')));
});

test('unsupported MIME, mismatched bytes and oversized uploads cannot publish assets', async (t) => {
  const { store, base, request } = await fixture(t, 64);
  const upload = (filename: string, mime: string, bytes: Buffer) => request(`${base}/assets?filename=${filename}&mimeType=${encodeURIComponent(mime)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  assert.equal((await upload('fake.png', 'image/png', Buffer.from('<html>'))).status, 400);
  assert.equal((await upload('page.html', 'text/html', Buffer.from('<html>'))).status, 400);
  assert.equal((await upload('large.mp4', 'video/mp4', Buffer.alloc(65))).status, 413);
  assert.equal(store.listFiles('one', 'plan-one').filter((file) => file.path.startsWith('assets/')).length, 0);
});

test('chunked uploads enforce limits with a structured 413 and no partial asset', async (t) => {
  const { store, origin, base } = await fixture(t, 64);
  const result = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = http.request(`${origin}${base}/assets?filename=large.mp4&mimeType=video%2Fmp4`, { method: 'POST', headers: { Authorization: 'Bearer local-test', 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(Buffer.alloc(40));
    req.end(Buffer.alloc(40));
  });
  assert.equal(result.status, 413, result.body);
  assert.equal(store.listFiles('one', 'plan-one').filter((file) => file.path.startsWith('assets/')).length, 0);
});

test('execution routes prepare immutable snapshots and persist an idempotent target link', async (t) => {
  const { base, request } = await fixture(t);
  const input = { id: 'execution-one', target: 'orchestrator' };
  const created = await request(`${base}/executions`, jsonBody(input));
  assert.equal(created.status, 201);
  const receipt = await created.json() as any;
  assert.equal(receipt.status, 'prepared');
  assert.equal(receipt.files[0].path, 'plan.md');
  const retry = await request(`${base}/executions`, jsonBody(input));
  assert.deepEqual(await retry.json(), receipt);
  const linked = await request(`${base}/executions/execution-one`, { ...jsonBody({ targetId: 'mission-one' }), method: 'PATCH' });
  assert.equal((await linked.json() as any).targetId, 'mission-one');
  const conflict = await request(`${base}/executions/execution-one`, { ...jsonBody({ targetId: 'mission-two' }), method: 'PATCH' });
  assert.equal(conflict.status, 409);
  assert.equal((await (await request(`${base}/executions/execution-one`)).json() as any).status, 'linked');
});

test('board routes persist Markdown bodies and reject stale revisions', async (t) => {
  const { base, request } = await fixture(t);
  const empty = await (await request(`${base}/board`)).json() as any;
  assert.deepEqual(empty.board.sections, []);
  const board = { schemaVersion: 1, planId: 'plan-one', updatedAt: '', sections: [{ id: 'scope', title: 'Scope', kind: 'section', body: 'Keep it focused.', items: [{ id: 'item-one', title: 'First', body: 'One next step.' }] }] };
  const saved = await request(`${base}/board`, { ...jsonBody({ board, expectedRevision: empty.revision }), method: 'PUT' });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as any;
  assert.equal(savedBody.board.sections[0].body, 'Keep it focused.');
  assert.equal(savedBody.board.sections[0].items[0].body, 'One next step.');
  const stale = await request(`${base}/board`, { ...jsonBody({ board, expectedRevision: empty.revision }), method: 'PUT' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as any).code, 'REVISION_CONFLICT');
  const outline = await (await request(`${base}/outline`)).json() as any;
  assert.equal(outline.sourceDocument, 'plan.md');
  const malformed = { ...board, sections: [{ id: 'x', title: 'X', kind: 'section', items: [{ id: 'i', title: 'I', media: [{ path: 'research/note.md' }] }] }] };
  assert.equal((await request(`${base}/board`, { ...jsonBody({ board: malformed, expectedRevision: savedBody.revision }), method: 'PUT' })).status, 400);
  assert.equal((await request(`${base}/board`, { ...jsonBody({ board, expectedRevision: savedBody.revision }), method: 'PUT' })).status, 200);
});

test('Markdown boards can be converted once from an outline', async (t) => {
  const { base, request } = await fixture(t);
  const document = await (await request(`${base}/document?path=plan.md`)).json() as any;
  await request(`${base}/document?path=plan.md`, { ...jsonBody({ content: '# Plan\n\n## Alpha\n\nFirst.\n\n## Beta\n\nSecond.\n', expectedRevision: document.revision }), method: 'PUT' });
  const converted = await request(`${base}/board/convert`, jsonBody({}));
  assert.equal(converted.status, 201);
  const result = await converted.json() as any;
  assert.deepEqual(result.board.sections.map((section: any) => [section.id, section.body]), [['alpha', 'First.'], ['beta', 'Second.']]);
  assert.equal((await request(`${base}/board/convert`, jsonBody({}))).status, 409);
});

test('range parser rejects invalid and unsafe integers', () => {
  assert.deepEqual(planningByteRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(planningByteRange('bytes=-100', 10), { start: 0, end: 9 });
  assert.deepEqual(planningByteRange('bytes=1-100', 10), { start: 1, end: 9 });
  assert.equal(planningByteRange(undefined, 0), null);
  for (const header of ['bytes=-0', 'bytes=-', 'bytes=5-1', 'bytes=9007199254740993-', 'items=0-1']) assert.throws(() => planningByteRange(header, 10));
  assert.throws(() => planningByteRange('bytes=0-0', 0));
});
