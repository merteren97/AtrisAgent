import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { StagedChanges } from './staged-changes';

const files = (path: string) => [{ path, status: 'modified' as const }];

test('task and mission readers coalesce by worktree and share a short-lived result', async () => {
  let now = 0;
  let version = 0;
  const changes = new StagedChanges(async path => files(`${path}-${++version}`), () => now);
  const [task, mission] = await Promise.all([changes.list('worktree'), changes.list('worktree')]);
  assert.deepEqual(task, files('worktree-1'));
  assert.deepEqual(mission, task);
  now = 5_000;
  assert.deepEqual(await changes.list('worktree'), task);
  assert.deepEqual(await changes.list('other'), files('other-2'));
  now = 10_000;
  assert.deepEqual(await changes.list('worktree'), files('worktree-3'));
  assert.deepEqual(await changes.list('worktree', true), files('worktree-4'));
});

test('a refresh after a preview invalidates an in-flight scan without overlapping it', async () => {
  let finishPoll!: (result: ReturnType<typeof files>) => void;
  let calls = 0;
  const changes = new StagedChanges(async () => ++calls === 1
    ? new Promise(resolve => { finishPoll = resolve; })
    : files('fresh'));
  const poll = changes.list('worktree');
  await setImmediate();
  changes.invalidate('worktree');
  const refresh = changes.list('worktree', true);
  const otherReader = changes.list('worktree');
  assert.equal(refresh, otherReader);
  await setImmediate();
  assert.equal(calls, 1);
  finishPoll(files('stale'));
  assert.deepEqual(await poll, files('stale'));
  assert.deepEqual(await refresh, files('fresh'));
  assert.deepEqual(await changes.list('worktree'), files('fresh'));
  assert.equal(calls, 2);
});

test('staged scans bound distinct worktree fanout and recover slots after errors', async () => {
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const changes = new StagedChanges(async path => {
    peak = Math.max(peak, ++active);
    try {
      await gate;
      if (path === 'failed') throw new Error('scan failed');
      return files(path);
    } finally { active--; }
  });
  const failed = assert.rejects(changes.list('failed'), /scan failed/);
  const all = Promise.all(Array.from({ length: 31 }, (_, index) => changes.list(`worktree-${index}`)));
  await assert.rejects(changes.list('overflow'), { status: 503 });
  await setImmediate();
  assert.equal(active, 2);
  release();
  await failed;
  assert.equal((await all).length, 31);
  assert.equal(peak, 2);
  await assert.rejects(changes.list('failed'), /scan failed/);
  assert.equal(changes.lastKnown('failed'), undefined);
  assert.deepEqual(await changes.list('overflow'), files('overflow'));
});

test('Changes routes share staged results, refresh explicitly, and reject undo for staged files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atris-staged-changes-'));
  const hub = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer staged-test-user') return void res.writeHead(401).end();
    const body = req.url === '/api/apps/agent/access' ? { access: { appId: 'agent', mode: 'PREMIUM', allowed: true } } : {
      user: { id: 'staged-test-user', email: 'staged@example.test' },
      membership: { status: 'active', plan: 'Premium' },
      entitlement: { product: 'AtrisAgent', status: 'active', plan: 'Premium' },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    hub.closeAllConnections();
    await new Promise<void>(resolve => hub.close(() => resolve()));
  });
  process.env.ATRIS_AUTH_API_URL = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  process.env.ATRIS_AGENT_DATA_DIR = path.join(root, 'data');
  process.env.ATRIS_RUNTIME_TOKEN = 'staged-changes-test';
  delete process.env.ATRIS_RUNTIME_MODE;
  const { server, db, workspaceManager, startupRecovery } = await import('./index');
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    (db as unknown as { $client: Database.Database }).$client.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await startupRecovery;
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'original.txt'), 'before');
  const workspace = await workspaceManager.createWorkspace({ name: 'Staged test', path: project });
  const planId = 'staged-plan';
  const mission = await workspaceManager.createMission({ workspaceId: workspace.id, title: 'Staged test', planId });
  const task = await workspaceManager.createTask({ missionId: mission.id, title: 'Builder', assignedRole: 'builder', planId });
  const worktree = await workspaceManager.createWorktreeForTask(task.id);
  await fs.writeFile(path.join(worktree, 'original.txt'), 'first');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (url: string, init?: RequestInit) => fetch(origin + url, {
    ...init, headers: { Authorization: 'Bearer staged-test-user', 'X-Atris-Runtime-Token': 'staged-changes-test', 'Content-Type': 'application/json' },
  });
  const taskRoute = `/tasks/${task.id}/changes`;
  const missionRoute = `/missions/${mission.id}/changes`;
  assert.deepEqual(await (await request(taskRoute)).json(), { mode: 'staged', files: files('original.txt') });
  await fs.writeFile(path.join(worktree, 'added.txt'), 'new');
  assert.deepEqual(await (await request(missionRoute)).json(), { files: [{ ...files('original.txt')[0], taskId: task.id }] });
  const refreshed = await (await request(`${missionRoute}?refresh=1`)).json();
  assert.ok(refreshed.files.some((file: { path: string }) => file.path === 'added.txt'));
  await fs.writeFile(path.join(worktree, 'original.txt'), 'second');
  await fs.rm(path.join(worktree, 'added.txt'));
  const preview = await request(`${taskRoute}/file?path=original.txt`);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await preview.json(), { before: 'before', after: 'second' });
  assert.deepEqual(await (await request(taskRoute)).json(), { mode: 'staged', files: files('original.txt') });
  const undo = await request(`${taskRoute}/resolve`, {
    method: 'POST', body: JSON.stringify({ action: 'undo', files: [{ path: 'original.txt', revision: crypto.randomUUID() }] }),
  });
  assert.equal(undo.status, 409);
  assert.equal(await fs.readFile(path.join(project, 'original.txt'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(worktree, 'original.txt'), 'utf8'), 'second');
});
