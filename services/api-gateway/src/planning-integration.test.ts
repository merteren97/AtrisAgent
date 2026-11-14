import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { PlanningStore } from './planning-store';

// Run the actual index.ts composition: no replacement Express app or auth/store mocks.
async function runTests(): Promise<number> {
  let passed = 0;
  let failed = 0;
  function check(condition: boolean, message: string): void {
    if (condition) { passed++; console.log(`[PASS] ${message}`); }
    else { failed++; console.error(`[FAIL] ${message}`); }
  }

  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-planning-integration-')));
  const workspacePath = path.join(root, 'workspace');
  const dataDir = path.join(root, 'gateway');
  fs.mkdirSync(workspacePath);
  fs.mkdirSync(dataDir);
  const runtimeToken = 'planning-integration-runtime';
  const premiumToken = 'planning-integration-premium';
  const freeToken = 'planning-integration-free';
  const hubCalls: Array<{ path: string; authorization?: string }> = [];
  let hubUnavailable = false;
  const hub = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    hubCalls.push({ path: pathname, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (hubUnavailable) { res.writeHead(503).end(JSON.stringify({ error: 'Fixture Hub offline' })); return; }
    const paid = req.headers.authorization === `Bearer ${premiumToken}`;
    const free = req.headers.authorization === `Bearer ${freeToken}`;
    if (!paid && !free) { res.writeHead(401).end(JSON.stringify({ error: 'Invalid session' })); return; }
    if (pathname === '/api/auth/me') {
      res.end(JSON.stringify({
        user: { id: paid ? 'planning-paid-user' : 'planning-free-user', email: 'planning@example.test' },
        membership: { status: 'active', plan: paid ? 'Premium' : 'Free' },
        entitlement: { product: 'AtrisAgent', status: paid ? 'active' : 'inactive', plan: paid ? 'Premium' : 'Free' },
      }));
    } else if (pathname === '/api/apps/agent/access') {
      res.end(JSON.stringify({ access: { appId: 'agent', mode: paid ? 'PREMIUM' : 'FREE', allowed: paid, announcement: '', version: 1 } }));
    } else if (pathname === '/api/apps/agent/activity') {
      res.end(JSON.stringify({ ok: true }));
    } else { res.writeHead(404).end('{}'); }
  });

  let gateway: typeof import('./index') | undefined;
  let fixtureDb: Database.Database | undefined;
  const restores: Array<() => void> = [];
  const launchAttempts: string[] = [];
  try {
    await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
    process.env.NODE_ENV = 'test';
    process.env.ATRIS_RUNTIME_TOKEN = runtimeToken;
    process.env.ATRIS_AGENT_DATA_DIR = dataDir;
    process.env.ATRIS_AUTH_API_URL = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
    delete process.env.ATRIS_PARENT_PID;
    delete process.env.ATRIS_RUNTIME_MODE;

    // Guard all production planning adapters, including PRIVATE instances created
    // by PlanningChatController. A regression must fail, never launch a real CLI.
    const { CodexAdapter, ClaudeCodeAdapter, OpenCodeAdapter, AntigravityAdapter } = await import('@atris-agent-code/runtime-host');
    for (const Adapter of [CodexAdapter, ClaudeCodeAdapter, OpenCodeAdapter, AntigravityAdapter]) {
      const spawn = Adapter.prototype.spawnAgent;
      const probe = Adapter.prototype.probeCapabilities;
      Adapter.prototype.spawnAgent = async () => {
        launchAttempts.push(`${Adapter.name}.spawnAgent`);
        throw new Error('Integration test forbids provider launches');
      };
      Adapter.prototype.probeCapabilities = async () => {
        launchAttempts.push(`${Adapter.name}.probeCapabilities`);
        throw new Error('Integration test forbids provider capability processes');
      };
      restores.push(() => { Adapter.prototype.spawnAgent = spawn; Adapter.prototype.probeCapabilities = probe; });
    }

    gateway = await import('./index');
    await gateway.startupRecovery;
    await new Promise<void>((resolve) => gateway!.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
    type Access = 'local' | 'premium' | 'free' | 'none';
    const request = (relative: string, init: RequestInit = {}, access: Access = 'local') => {
      const headers = new Headers(init.headers);
      if (access !== 'none') headers.set('X-Atris-Runtime-Token', runtimeToken);
      if (access === 'premium' || access === 'free') headers.set('Authorization', `Bearer ${access === 'premium' ? premiumToken : freeToken}`);
      return fetch(`${origin}${relative}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    };
    const json = (value: unknown, method = 'POST'): RequestInit => ({
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    async function expectStatus(relative: string, status: number, init: RequestInit = {}, access: Access = 'local'): Promise<any> {
      const response = await request(relative, init, access);
      const text = await response.text();
      check(response.status === status, `${access} ${init.method || 'GET'} ${relative}: ${status}`);
      if (response.status !== status) console.error(`  Actual ${response.status}: ${text.slice(0, 2000)}`);
      try { return JSON.parse(text); } catch { return text; }
    }

    const workspace = await expectStatus('/api/workspaces', 201, json({ name: 'Planning integration fixture', path: workspacePath }), 'premium');
    if (typeof workspace.id !== 'string') throw new Error('Workspace fixture did not return an ID');
    check((await gateway.workspaceManager.getWorkspace(workspace.id))?.path === workspacePath, 'authorized workspace POST persists only the isolated workspace');
    const plans = `/api/workspaces/${workspace.id}/plans`;
    const planId = 'production-plan';
    const base = `${plans}/${planId}`;
    const chat = `/api/planning/${workspace.id}/plans/${planId}/chat`;
    const sourceRoute = '/api/planning-source/manual/planning-target';

    const offlineCalls = hubCalls.length;
    hubUnavailable = true;
    check((await expectStatus(plans, 200)).length === 0, 'runtime-only local plan library starts empty');
    const created = await expectStatus(plans, 201, json({ id: planId, title: 'Production plan' }));
    check(created.id === planId && created.workspaceId === workspace.id, 'runtime-only plan creation returns scoped metadata');
    check((await expectStatus(plans, 200)).some((plan: any) => plan.id === planId), 'runtime-only plan list includes the new plan');
    await expectStatus(base, 200);
    const original = await expectStatus(`${base}/document?path=plan.md`, 200);
    const content = '# Production document\n\n' + 'x'.repeat(3 * 1024 * 1024);
    const saveBody = { content, expectedRevision: original.revision };
    check(Buffer.byteLength(JSON.stringify(saveBody)) > 2 * 1024 * 1024 && Buffer.byteLength(content) < 4 * 1024 * 1024,
      'large fixture exceeds ordinary 2 MiB parser and stays under 4 MiB document limit');
    const saved = await expectStatus(`${base}/document?path=plan.md`, 200, json(saveBody, 'PUT'));
    check(saved.content === content && saved.revision !== original.revision, 'production 6 MB parser accepts the complete 3 MiB plan write');
    const read = await expectStatus(`${base}/document?path=plan.md`, 200);
    check(read.content === content && read.revision === saved.revision, 'large plan content and revision round-trip through production HTTP');
    const stale = await expectStatus(`${base}/document?path=plan.md`, 409, json({ content: 'stale', expectedRevision: original.revision }, 'PUT'));
    check(stale.code === 'REVISION_CONFLICT', 'production routes preserve optimistic revision protection');

    const importedText = '# Imported plan\n\nPortable Markdown.\n';
    const imported = await expectStatus(`${plans}/import`, 201, json({ id: 'imported-plan', title: 'Imported plan', content: importedText }));
    const research = await expectStatus(`${base}/import`, 201, json({ filename: 'notes.md', content: '# Research\n\nLocal notes.\n' }));
    check(imported.id === 'imported-plan' && research.path === 'research/notes.md', 'both new-plan and research imports work with runtime token only');
    const patched = await expectStatus(base, 200, json({ pinned: true, status: 'ready' }, 'PATCH'));
    check(patched.pinned === true && patched.status === 'ready', 'local metadata updates persist');

    // A known complete 1x1 PNG (not a fabricated MIME signature).
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
    const uploadInit: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(png) };
    const uploadPath = `${base}/assets?filename=pixel.png&mimeType=image%2Fpng`;
    const uploaded = await expectStatus(uploadPath, 201, uploadInit);
    check(uploaded.path === 'assets/pixel.png' && uploaded.byteSize === png.length && uploaded.mimeType === 'image/png',
      'production JSON parsers leave the application/octet-stream upload stream untouched');
    const files = await expectStatus(`${base}/files`, 200);
    check(files.some((file: any) => file.path === 'research/notes.md') && files.some((file: any) => file.path === 'assets/pixel.png' && file.byteSize === png.length),
      'local file list includes imported Markdown and binary media');
    const mediaPath = `${base}/content?path=assets%2Fpixel.png`;
    const media = await request(mediaPath);
    check(media.status === 200 && Buffer.from(await media.arrayBuffer()).equals(png), 'runtime-only media GET preserves exact PNG bytes');
    const grant = await expectStatus(`${base}/media-grant`, 200, json({ path: 'assets/pixel.png' }));
    if (typeof grant.url !== 'string') throw new Error('Media fixture did not return a grant URL');
    check(!grant.url.includes(runtimeToken) && !grant.url.includes(premiumToken) && Date.parse(grant.expiresAt) > Date.now(),
      'media grant is expiring and carries no runtime or Hub credential');
    const range = await request(grant.url, { headers: { Range: 'bytes=0-7' } }, 'none');
    check(range.status === 206, 'unauthenticated exact media grant supports range 206 before runtime auth');
    check(range.headers.get('content-range') === `bytes 0-7/${png.length}` && range.headers.get('content-type') === 'image/png'
      && range.headers.get('accept-ranges') === 'bytes', 'granted media range returns correct production headers');
    check(Buffer.from(await range.arrayBuffer()).equals(png.subarray(0, 8)), 'granted range streams only requested original bytes');
    const head = await request(grant.url, { method: 'HEAD' }, 'none');
    check(head.status === 200 && head.headers.get('content-length') === String(png.length) && await head.text() === '', 'media grant also permits a bodyless exact HEAD');
    await expectStatus(grant.url.replace(`/${planId}/`, '/imported-plan/'), 401, {}, 'none');
    await expectStatus(grant.url.replace('pixel.png', 'other.png'), 401, {}, 'none');
    await expectStatus(grant.url.replace(`/workspaces/${workspace.id}/`, '/workspaces/other-workspace/'), 401, {}, 'none');
    await expectStatus(grant.url, 401, json({}), 'none');
    const grantToken = new URL(grant.url, origin).searchParams.get('grant');
    await expectStatus(`${base}/document?path=plan.md&grant=${grantToken}`, 401, {}, 'none');

    const chatState = await expectStatus(chat, 200);
    check(chatState.status === 'idle' && chatState.messages.length === 0 && chatState.proposals.length === 0, 'planning chat history is a runtime-only local read');
    check(await expectStatus(sourceRoute, 200) === null, 'missing planning source is a runtime-only local read');
    check(hubCalls.length === offlineCalls, 'all local planning CRUD, imports, large document, media and history make zero Hub requests while offline');
    hubUnavailable = false;

    // Independent store instance and database connection prove real persistence.
    const persisted = new PlanningStore((id) => id === workspace.id ? { id, path: workspacePath } : undefined);
    check(persisted.get(workspace.id, planId).pinned && persisted.readDocument(workspace.id, planId, 'plan.md').content === content,
      'a reopened PlanningStore reads actual metadata and large document persistence');
    check(persisted.readDocument(workspace.id, imported.id, 'plan.md').content === importedText
      && persisted.readDocument(workspace.id, planId, 'research/notes.md').content === research.content,
      'a reopened PlanningStore reads both persisted Markdown imports');
    check(fs.readFileSync(persisted.resolveFile(workspace.id, planId, uploaded.path).absolutePath).equals(png), 'asset persistence contains exact original PNG bytes');

    for (const [relative, init] of [
      [plans, {}], [plans, json({ title: 'Unauthorized' })],
      [`${base}/document?path=plan.md`, {}], [`${base}/document?path=plan.md`, json(saveBody, 'PUT')],
      [`${plans}/import`, json({ title: 'Unauthorized', content: '# No' })],
      [`${base}/import`, json({ filename: 'unauthorized.md', content: '# No' })],
      [uploadPath, uploadInit], [mediaPath, {}], [`${base}/media-grant`, json({ path: uploaded.path })],
      [chat, {}], [sourceRoute, {}],
    ] satisfies Array<[string, RequestInit]>) {
      await expectStatus(relative, 401, init, 'none');
    }

    // Every mutating execution route must pass BOTH production auth boundaries.
    const invalidMessage = { id: randomUUID(), text: 'Discuss this plan', catalogId: 'missing-integration-model' };
    const executionRoutes: Array<[string, RequestInit]> = [
      [`${chat}/messages`, json(invalidMessage)],
      [`${chat}/stop`, json({})],
      [`${chat}/updates/missing-proposal/apply`, json({ expectedRevision: saved.revision })],
      [`${base}/handoff`, json({ id: randomUUID(), target: 'manual', catalogId: 'missing-integration-model' })],
      [`${base}/handoff`, json({ id: randomUUID(), target: 'orchestrator' })],
    ];
    for (const [relative, init] of executionRoutes) {
      await expectStatus(relative, 401, init, 'none');
      await expectStatus(relative, 401, init, 'local');
      await expectStatus(relative, 403, init, 'free');
    }
    const rejectedMessage = await expectStatus(`${chat}/messages`, 400, json(invalidMessage), 'premium');
    check(typeof rejectedMessage.error === 'string' && rejectedMessage.error.includes('verified, available model'), 'Premium reaches real model validation and rejects an unavailable model');
    await expectStatus(`${base}/handoff`, 400, json({ id: randomUUID(), target: 'manual', catalogId: 'missing-integration-model' }), 'premium');
    await expectStatus(`${chat}/stop`, 200, json({}), 'premium');
    await expectStatus(`${chat}/updates/missing-proposal/apply`, 404, json({ expectedRevision: saved.revision }), 'premium');
    check((await expectStatus(chat, 200)).messages.length === 0 && persisted.readMessages(workspace.id, planId).length === 0,
      'denied requests and invalid models never append planning turns');
    check((await gateway.workspaceManager.listMissions(workspace.id)).length === 0 && gateway.manualConversationStore.list(workspace.id).length === 0,
      'denied handoffs create no missions or manual conversations');
    check(hubCalls.some((call) => call.path === '/api/auth/me' && call.authorization === `Bearer ${premiumToken}`)
      && hubCalls.some((call) => call.path === '/api/apps/agent/access' && call.authorization === `Bearer ${premiumToken}`)
      && hubCalls.some((call) => call.path === '/api/auth/me' && call.authorization === `Bearer ${freeToken}`)
      && hubCalls.some((call) => call.path === '/api/apps/agent/access' && call.authorization === `Bearer ${freeToken}`),
      'production auth consults mock Hub identity and app entitlement for both paid and free sessions');

    const execution = persisted.createExecution(workspace.id, planId, { id: randomUUID(), target: 'manual', paths: ['plan.md', 'assets/pixel.png'] });
    const source = { workspaceId: workspace.id, planId, executionId: execution.id, snapshotPath: execution.snapshotPath,
      href: `${base}/executions/${execution.id}` };
    fixtureDb = new Database(path.join(dataDir, 'atris.db'));
    fixtureDb.prepare('INSERT INTO planning_handoff_receipts (workspace_id, plan_id, operation_id, target, payload, prepared, target_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(workspace.id, planId, execution.id, 'manual', '{}', JSON.stringify({ source }), 'planning-target');
    const backlinkCalls = hubCalls.length;
    const backlink = await expectStatus(sourceRoute, 200);
    check(backlink.workspaceId === workspace.id && backlink.planId === planId && backlink.executionId === execution.id,
      'planning-source GET resolves a real durable target backlink with runtime token only');
    const snapshot = await expectStatus(source.href, 200);
    check(snapshot.id === execution.id && snapshot.files.some((file: any) => file.path === 'assets/pixel.png'), 'execution snapshot is a runtime-only local read');
    check(hubCalls.length === backlinkCalls, 'persisted planning source and snapshot reads bypass Hub');

    // Seed a durable fence, never invoke deletion/recovery or delete source files.
    const now = new Date().toISOString();
    fixtureDb.prepare("INSERT INTO deletion_operations (id, target_type, target_id, remove_memory, phase, status, manifest, progress, created_at, updated_at) VALUES (?, 'workspace', ?, 0, 'stop', 'pending', '[]', '{}', ?, ?)")
      .run(randomUUID(), workspace.id, now, now);
    await expectStatus(grant.url, 401, {}, 'none');
    const fenced = await expectStatus(`${base}/files`, 409);
    check(fenced.code === 'DELETION_IN_PROGRESS', 'production deletion fence blocks local planning file access');
    await expectStatus(`${base}/media-grant`, 409, json({ path: uploaded.path }));
    await expectStatus(`${base}/handoff`, 409, json({ id: randomUUID(), target: 'manual', catalogId: 'missing-integration-model' }), 'premium');
    check(persisted.readDocument(workspace.id, planId, 'plan.md').content === content
      && fs.readFileSync(persisted.resolveFile(workspace.id, planId, uploaded.path).absolutePath).equals(png), 'fence checks preserve isolated plan and source asset bytes');
    check(launchAttempts.length === 0, `zero provider spawn/capability attempts (${launchAttempts.join(', ') || 'none'})`);
  } catch (error) {
    failed++;
    console.error('[FAIL] Integration fixture or request failed:', error);
  } finally {
    // Complete every cleanup even when another cleanup fails. The fresh gateway
    // owns intervals, so the entrypoint exits explicitly after reporting results.
    const cleanup = async (label: string, work: () => unknown) => {
      try { await work(); } catch (error) { failed++; console.error(`[FAIL] Cleanup ${label}:`, error); }
    };
    if (gateway) {
      await cleanup('planning chat', () => gateway!.planningChat.close());
      await cleanup('runtime host', () => gateway!.runtimeHost.stopAll());
      await cleanup('interactions', () => gateway!.orchestratorInteractions.dispose());
      await cleanup('gateway HTTP server', () => closeServer(gateway!.server));
    }
    await cleanup('mock Hub server', () => closeServer(hub));
    await cleanup('fixture SQLite connection', () => fixtureDb?.close());
    if (gateway) await cleanup('gateway SQLite connection', () => (gateway!.db as unknown as { $client: Database.Database }).$client.close());
    for (const restore of restores) restore();
    await cleanup('isolated temporary files', () => fs.rmSync(root, { recursive: true, force: true }));
  }
  console.log(`Planning production integration: ${passed} passed, ${failed} failed (${passed + failed} assertions/checks).`);
  return failed ? 1 : 0;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

runTests().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
