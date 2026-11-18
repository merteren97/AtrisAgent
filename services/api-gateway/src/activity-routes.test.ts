import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import type { RuntimeHost } from '@atris-agent-code/runtime-host';
import { installActivityRoutes } from './activity-routes';
import type { ActivitySummaryResponse } from './activity-types';
import { isLocalDataRequest } from './local-data-access';
import { ManualConversationStore } from './manual-conversations';
import { PlanningChatController, type PlanningChatAdapter } from './planning-chat';
import { PlanningStore } from './planning-store';

function createDb(dbPath: string): Database.Database {
  const sqlite = new Database(dbPath);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      team_template_id TEXT NOT NULL DEFAULT '',
      plan_id TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'balanced',
      active_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE mission_runs (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      turn_id TEXT,
      status TEXT NOT NULL DEFAULT 'starting',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT
    );
    CREATE TABLE conversation_turns (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      delivery TEXT NOT NULL,
      options TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE agent_instances (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      model_profile_id TEXT DEFAULT '',
      account_profile_id TEXT DEFAULT '',
      runtime_adapter_id TEXT DEFAULT '',
      session_id TEXT,
      status TEXT DEFAULT 'idle',
      created_at TEXT NOT NULL
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      task_id TEXT,
      run_id TEXT,
      type TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE TABLE orchestrator_questions (
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (mission_id, question_id)
    );
  `);
  return sqlite;
}

async function runTests(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-activity-routes-'));
  const wsOneDir = path.join(tempDir, 'ws-1');
  const wsTwoDir = path.join(tempDir, 'ws-2');
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(wsOneDir, { recursive: true });
  fs.mkdirSync(wsTwoDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const sqlite = createDb(path.join(dataDir, 'test.db'));
  const now = new Date();
  const isoAgo = (ms: number) => new Date(now.getTime() - ms).toISOString();

  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('ws-1', 'Alpha App', wsOneDir, isoAgo(600_000), isoAgo(600_000));
  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('ws-2', 'Beta API', wsTwoDir, isoAgo(600_000), isoAgo(600_000));

  // Orchestrator missions:
  // 1. Running mission
  sqlite.prepare('INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm-running', 'ws-1', 'Build activity center', '', 'running', '', null, 'balanced', 'run-1', isoAgo(120_000), isoAgo(5_000), null,
  );
  sqlite.prepare('INSERT INTO mission_runs VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'run-1', 'm-running', 'turn-1', 'running', isoAgo(100_000), null, null,
  );
  sqlite.prepare('INSERT INTO agent_instances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'agent-w1', 'm-running', 'builder', 'gpt-5.4', 'acc-1', 'codex', 'sess-1', 'running', isoAgo(95_000),
  );

  // 2. Attention mission with secret in orchestrator_questions
  sqlite.prepare('INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm-question', 'ws-1', 'Configure deployment', '', 'running', '', null, 'balanced', 'run-2', isoAgo(300_000), isoAgo(20_000), null,
  );
  sqlite.prepare('INSERT INTO orchestrator_questions VALUES (?, ?, ?)').run(
    'm-question',
    'q-1',
    JSON.stringify({
      missionId: 'm-question',
      questionId: 'q-1',
      status: 'pending',
      agentInstanceId: 'agent-q1',
      timestamp: isoAgo(15_000),
      questions: [{ question: 'Use token sk-secretvalue1234567890 for staging deployment?', options: [{ label: 'Yes' }] }],
    }),
  );

  // 3. Completed mission
  sqlite.prepare('INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm-done', 'ws-2', 'Refactor parser', '', 'completed', '', null, 'balanced', null, isoAgo(500_000), isoAgo(200_000), isoAgo(200_000),
  );
  sqlite.prepare('INSERT INTO mission_runs VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'run-done', 'm-done', null, 'completed', isoAgo(500_000), isoAgo(200_000), null,
  );

  // Manual conversations:
  const manualStore = new ManualConversationStore(sqlite, dataDir);
  const manualConvId = '11111111-1111-4111-8111-111111111111';
  const manualAgentId = '22222222-2222-4222-8222-222222222222';
  const claudeConfigDir = path.join(tempDir, 'claude-cfg');
  const claudeProjectDir = path.join(claudeConfigDir, 'projects', 'ws-1');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  const providerSessId = '33333333-3333-4333-8333-333333333333';
  const transcriptFile = path.join(claudeProjectDir, `${providerSessId}.jsonl`);
  fs.writeFileSync(
    transcriptFile,
    JSON.stringify({
      sessionId: providerSessId,
      type: 'assistant',
      uuid: 'msg-q',
      message: {
        id: 'msg-q',
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'AskUserQuestion',
            input: { questions: [{ header: 'Scope', question: 'Which environment should Claude target?', options: [{ label: 'Dev' }] }] },
          },
        ],
      },
    }) + '\n',
  );
  const manualSessDir = path.join(dataDir, 'manual-sessions', manualAgentId);
  fs.mkdirSync(manualSessDir, { recursive: true });
  const writeClaudeHookEvent = (eventName: string, atIso: string) => {
    fs.appendFileSync(
      path.join(manualSessDir, 'bindings.jsonl'),
      JSON.stringify({ sessionId: providerSessId, transcriptPath: transcriptFile, event: eventName, at: atIso }) + '\n',
    );
  };
  writeClaudeHookEvent('UserPromptSubmit', isoAgo(30_000));

  manualStore.create('ws-1', 'Manual Claude Session', manualConvId);
  manualStore.save({
    id: manualAgentId,
    conversationId: manualConvId,
    name: 'Claude 1',
    catalogId: 'claude-sonnet',
    runtimeType: 'claude_code',
    model: 'claude-sonnet-4-5',
    accountProfileId: 'acc-claude',
    providerSessionId: providerSessId,
    cwd: wsOneDir,
    configDir: claudeConfigDir,
    sharedProfile: false,
    createdAt: isoAgo(40_000),
  });

  // Planning store + chat:
  const planningStore = new PlanningStore((id) =>
    sqlite.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(id) as { id: string; path: string } | undefined,
  );
  const plan = planningStore.create('ws-1', { id: 'plan-1', title: 'Architecture Spec', content: '# Spec\nInitial plan' });
  const runtimeHostStub = {
    getModelCatalogService: () => ({
      resolveModelDescriptor: async () => ({
        catalogId: 'codex-gpt5',
        runtimeId: 'codex',
        runtimeModelId: 'gpt-5.4',
        accountProfileId: 'acc-codex',
        availability: 'available',
        source: 'live',
        supportedReasoning: ['medium', 'high'],
        defaultReasoning: 'medium',
      }),
    }),
    getAccountProfileManager: () => ({
      getProfileById: async () => ({
        id: 'acc-codex',
        runtimeType: 'codex',
        authStatus: 'connected',
        configDir: tempDir,
      }),
    }),
  } as unknown as Pick<RuntimeHost, 'getModelCatalogService' | 'getAccountProfileManager'>;

  const planningChat = new PlanningChatController({
    store: planningStore,
    runtimeHost: runtimeHostStub as any,
    createAdapter: () =>
      ({
        configureProfile() {},
        probeCapabilities: async () => ({
          structuredEventStreaming: true,
          cancellation: true,
          modelSelection: true,
          reasoningControl: true,
        }),
        spawnAgent: async () => ({ id: 's', agentInstanceId: 's', runtimeSessionId: 's', startedAt: new Date().toISOString(), endedAt: null }),
        cancel: async () => {},
        shutdown: async () => {},
      }) as unknown as PlanningChatAdapter,
  });
  const planConvId = '44444444-4444-4444-8444-444444444444';
  await planningChat.createConversation('ws-1', plan.id, {
    id: planConvId,
    title: 'API Design Tab',
    catalogId: 'codex-gpt5',
  });
  // Append a completed turn record to planning chat directly
  planningStore.appendMessage('ws-1', plan.id, {
    id: 'p-start-1',
    role: 'user',
    text: 'Draft API endpoints',
    createdAt: isoAgo(180_000),
    planningChat: { version: 1, kind: 'start', turnId: 'pt-1', sessionId: 'ps-1', clientMessageId: 'cm-1', catalogId: 'codex-gpt5', runtimeType: 'codex', model: 'gpt-5.4', conversationId: planConvId },
  });
  planningStore.appendMessage('ws-1', plan.id, {
    id: 'p-ans-1',
    role: 'assistant',
    text: 'Here are the endpoints.',
    createdAt: isoAgo(160_000),
    planningChat: { version: 1, kind: 'answer', turnId: 'pt-1', conversationId: planConvId },
  });
  planningStore.appendMessage('ws-1', plan.id, {
    id: 'p-done-1',
    role: 'system',
    text: '',
    createdAt: isoAgo(159_000),
    planningChat: { version: 1, kind: 'state', turnId: 'pt-1', status: 'complete', activity: 'Complete', conversationId: planConvId },
  });

  // Verify summarizePlanConversations is non-mutating
  const planFilesBefore = planningStore.listFiles('ws-1', plan.id);
  const planSummaries = planningChat.summarizePlanConversations('ws-1', plan.id);
  assert.equal(planSummaries.length, 1);
  assert.equal(planSummaries[0].conversationId, planConvId);
  assert.equal(planSummaries[0].status, 'complete');
  assert.equal(planSummaries[0].startedAt, isoAgo(180_000));
  assert.equal(planSummaries[0].closedAt, null);
  assert.deepEqual(planningStore.listFiles('ws-1', plan.id), planFilesBefore);

  // Spin up Express app
  const app = express();
  app.use(express.json());
  installActivityRoutes(app, {
    sqlite,
    manualConversationStore: manualStore,
    planningStore,
    planningChat,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // 1. Initial GET /api/activity/summary (manual is working)
    let res = await fetch(`${baseUrl}/api/activity/summary`);
    assert.equal(res.status, 200);
    let summary = (await res.json()) as ActivitySummaryResponse;
    assert.equal(summary.counts.total, 5);
    assert.equal(summary.counts.attention, 1);
    assert.equal(summary.counts.running, 2);
    assert.equal(summary.counts.unreadCompleted, 2);

    const qItem = summary.items.find((i) => i.itemKey === 'orchestrator:m-question')!;
    assert.equal(qItem.state, 'attention');
    assert.equal(qItem.attention?.kind, 'question');
    assert.ok(!qItem.attention?.preview.includes('sk-secretvalue1234567890'), 'secret must be redacted in preview');
    assert.ok(qItem.attention!.preview.includes('[REDACTED_SECRET]'));
    assert.ok(qItem.attention!.preview.length <= 140);

    const manualItem = summary.items.find((i) => i.itemKey === `manual:${manualConvId}`)!;
    assert.equal(manualItem.state, 'running');
    assert.ok(manualItem.startedAt, 'manual running session records active_started_at');
    assert.equal(manualItem.manualAgents?.length, 1);
    assert.equal(manualItem.manualAgents?.[0].rawState, 'working');

    // Check sorting: attention -> running -> updatedAt desc
    assert.equal(summary.items[0].state, 'attention');
    assert.equal(summary.items[1].state, 'running');
    assert.equal(summary.items[2].state, 'running');

    // 2. Transition manual from working -> attention (PermissionRequest) -> completed
    writeClaudeHookEvent('PermissionRequest', isoAgo(10_000));
    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    const manualAttention = summary.items.find((i) => i.itemKey === `manual:${manualConvId}`)!;
    assert.equal(manualAttention.state, 'attention');
    assert.equal(manualAttention.attention?.kind, 'question');
    assert.equal(manualAttention.attention?.preview, 'Which environment should Claude target?');

    writeClaudeHookEvent('Stop', isoAgo(2_000));
    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    const manualDone = summary.items.find((i) => i.itemKey === `manual:${manualConvId}`)!;
    assert.equal(manualDone.state, 'completed');
    assert.ok(typeof manualDone.durationMs === 'number' && manualDone.durationMs >= 0, 'completed manual item keeps persisted durationMs');
    assert.equal(manualDone.unreadCompletion, true);

    // 3. Workspace filter
    res = await fetch(`${baseUrl}/api/activity/summary?workspaceId=ws-2`);
    const ws2Summary = (await res.json()) as ActivitySummaryResponse;
    assert.equal(ws2Summary.items.length, 1);
    assert.equal(ws2Summary.items[0].itemKey, 'orchestrator:m-done');

    // 4. PUT /api/activity/meta (pin + markSeen)
    const planningKey = `planning:ws-1:${plan.id}:${planConvId}`;
    res = await fetch(`${baseUrl}/api/activity/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: planningKey, pinned: true, markSeen: true }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    assert.equal(summary.items[0].itemKey, planningKey, 'pinned item sorts first');
    assert.ok(summary.items[0].pinnedAt);
    assert.equal(summary.items[0].unreadCompletion, false, 'markSeen clears unreadCompletion');

    // 5. PATCH /api/activity/rename across all 3 modes
    res = await fetch(`${baseUrl}/api/activity/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { mode: 'manual', workspaceId: 'ws-1', conversationId: manualConvId }, title: 'Renamed Manual' }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${baseUrl}/api/activity/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { mode: 'orchestrator', workspaceId: 'ws-2', missionId: 'm-done' }, title: 'Renamed Mission' }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${baseUrl}/api/activity/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { mode: 'planning', workspaceId: 'ws-1', planId: plan.id, conversationId: planConvId }, title: 'Renamed Plan Tab' }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${baseUrl}/api/activity/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { mode: 'planning', workspaceId: 'ws-1', planId: plan.id }, title: 'Renamed Spec Plan' }),
    });
    assert.equal(res.status, 200);
    assert.equal(planningStore.get('ws-1', plan.id).title, 'Renamed Spec Plan');

    // Invalid empty title rejected
    res = await fetch(`${baseUrl}/api/activity/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { mode: 'manual', workspaceId: 'ws-1', conversationId: manualConvId }, title: '   ' }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    assert.equal(summary.items.find((i) => i.itemKey === `manual:${manualConvId}`)?.title, 'Renamed Manual');
    assert.equal(summary.items.find((i) => i.itemKey === 'orchestrator:m-done')?.title, 'Renamed Mission');
    assert.equal(summary.items.find((i) => i.itemKey === planningKey)?.title, 'Renamed Plan Tab');

    // 6. POST /api/activity/clear-completed
    // Pinned planning item should NOT be cleared; unpin it to test soft-clear too.
    res = await fetch(`${baseUrl}/api/activity/clear-completed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ closedManualConversationIds: [manualConvId] }),
    });
    assert.equal(res.status, 200);
    const clearResult1 = (await res.json()) as { clearedCount: number };
    assert.equal(clearResult1.clearedCount, 2, 'clears m-done and closed manual conversation, skips pinned/running/attention');

    // Unpin planning item and clear planning completed
    await fetch(`${baseUrl}/api/activity/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: planningKey, pinned: false }),
    });
    res = await fetch(`${baseUrl}/api/activity/clear-completed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'planning' }),
    });
    assert.equal(res.status, 200);
    const clearResult2 = (await res.json()) as { clearedCount: number };
    assert.equal(clearResult2.clearedCount, 1);

    // Plan markdown files must NEVER be deleted by clear-completed
    assert.equal(planningStore.readDocument('ws-1', plan.id, 'plan.md').content, '# Spec\nInitial plan');

    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    assert.equal(summary.items.length, 2, 'only m-running and m-question remain');

    // 7. local-data-access allowlist checks
    const tokenHeaders = { 'x-atris-runtime-token': 'rt-test' };
    assert.equal(isLocalDataRequest({ method: 'GET', originalUrl: '/api/activity/summary', headers: tokenHeaders } as any, 'rt-test'), true);
    assert.equal(isLocalDataRequest({ method: 'PUT', originalUrl: '/api/activity/meta', headers: tokenHeaders } as any, 'rt-test'), true);
    assert.equal(isLocalDataRequest({ method: 'PATCH', originalUrl: '/api/activity/rename', headers: tokenHeaders } as any, 'rt-test'), true);
    assert.equal(isLocalDataRequest({ method: 'POST', originalUrl: '/api/activity/clear-completed', headers: tokenHeaders } as any, 'rt-test'), true);
    assert.equal(isLocalDataRequest({ method: 'GET', originalUrl: '/api/insights/usage?range=7d', headers: tokenHeaders } as any, 'rt-test'), true);
    assert.equal(isLocalDataRequest({ method: 'PATCH', originalUrl: '/api/missions/m-1', headers: tokenHeaders } as any, 'rt-test'), true);
    assert.equal(isLocalDataRequest({ method: 'PATCH', originalUrl: '/api/workspaces/ws-1', headers: tokenHeaders } as any, 'rt-test'), true);
    assert.equal(isLocalDataRequest({ method: 'PATCH', originalUrl: '/api/manual/conversations/c-1', headers: tokenHeaders } as any, 'rt-test'), true);

    // 8. Closed planning conversations, stale failures, cleared meta, stale manual durations, and historical unreadCompletion
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;

    // 8a. Closed planning chat: skipped unless pinned; pinned closed never shows attention/running
    const closedUnpinnedId = '55555555-5555-4555-8555-555555555555';
    const closedPinnedFailedId = '66666666-6666-4666-8666-666666666666';
    await planningChat.createConversation('ws-1', plan.id, {
      id: closedUnpinnedId,
      title: 'Closed Unpinned Tab',
      catalogId: 'codex-gpt5',
    });
    await planningChat.updateConversation('ws-1', plan.id, closedUnpinnedId, { closed: true });

    await planningChat.createConversation('ws-1', plan.id, {
      id: closedPinnedFailedId,
      title: 'Closed Pinned Tab',
      catalogId: 'codex-gpt5',
    });
    planningStore.appendMessage('ws-1', plan.id, {
      id: 'cp-start-1',
      role: 'user',
      text: 'Fail then close',
      createdAt: isoAgo(10 * 60_000),
      planningChat: { version: 1, kind: 'start', turnId: 'cpt-1', sessionId: 'cps-1', clientMessageId: 'cpm-1', catalogId: 'codex-gpt5', runtimeType: 'codex', model: 'gpt-5.4', conversationId: closedPinnedFailedId },
    });
    planningStore.appendMessage('ws-1', plan.id, {
      id: 'cp-fail-1',
      role: 'system',
      text: '',
      createdAt: isoAgo(5 * 60_000),
      planningChat: { version: 1, kind: 'state', turnId: 'cpt-1', status: 'failed', error: 'Timed out', conversationId: closedPinnedFailedId },
    });
    await planningChat.updateConversation('ws-1', plan.id, closedPinnedFailedId, { closed: true });

    const closedSummaryList = planningChat.summarizePlanConversations('ws-1', plan.id);
    assert.ok(closedSummaryList.find((c) => c.conversationId === closedUnpinnedId)?.closedAt);

    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    assert.equal(summary.items.find((i) => i.itemKey === `planning:ws-1:${plan.id}:${closedUnpinnedId}`), undefined);
    assert.equal(summary.items.find((i) => i.itemKey === `planning:ws-1:${plan.id}:${closedPinnedFailedId}`), undefined);

    const closedPinnedKey = `planning:ws-1:${plan.id}:${closedPinnedFailedId}`;
    await fetch(`${baseUrl}/api/activity/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: closedPinnedKey, pinned: true }),
    });
    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    const closedPinnedItem = summary.items.find((i) => i.itemKey === closedPinnedKey)!;
    assert.ok(closedPinnedItem, 'pinned closed planning conversation appears in activity');
    assert.equal(closedPinnedItem.state, 'failed');
    assert.equal(closedPinnedItem.attention, null);
    assert.equal(closedPinnedItem.activeCount, 0);

    // 8b. Stale vs recent/seen failed items (Planning + Orchestrator) and PUT /api/activity/meta { cleared }
    const recentFailPlanConvId = '77777777-7777-4777-8777-777777777777';
    const staleFailPlanConvId = '88888888-8888-4888-8888-888888888888';
    await planningChat.createConversation('ws-1', plan.id, {
      id: recentFailPlanConvId,
      title: 'Recent Failed Plan',
      catalogId: 'codex-gpt5',
    });
    planningStore.appendMessage('ws-1', plan.id, {
      id: 'rf-start',
      role: 'user',
      text: 'Run turn',
      createdAt: isoAgo(12 * 60_000),
      planningChat: { version: 1, kind: 'start', turnId: 'rft-1', sessionId: 'rfs-1', clientMessageId: 'rfm-1', catalogId: 'codex-gpt5', runtimeType: 'codex', model: 'gpt-5.4', conversationId: recentFailPlanConvId },
    });
    planningStore.appendMessage('ws-1', plan.id, {
      id: 'rf-fail',
      role: 'system',
      text: '',
      createdAt: isoAgo(10 * 60_000),
      planningChat: { version: 1, kind: 'state', turnId: 'rft-1', status: 'failed', error: 'Rate limit exceeded', conversationId: recentFailPlanConvId },
    });

    await planningChat.createConversation('ws-1', plan.id, {
      id: staleFailPlanConvId,
      title: 'Stale Failed Plan',
      catalogId: 'codex-gpt5',
    });
    planningStore.appendMessage('ws-1', plan.id, {
      id: 'sf-start',
      role: 'user',
      text: 'Old run',
      createdAt: isoAgo(44 * HOUR_MS + 60_000),
      planningChat: { version: 1, kind: 'start', turnId: 'sft-1', sessionId: 'sfs-1', clientMessageId: 'sfm-1', catalogId: 'codex-gpt5', runtimeType: 'codex', model: 'gpt-5.4', conversationId: staleFailPlanConvId },
    });
    planningStore.appendMessage('ws-1', plan.id, {
      id: 'sf-fail',
      role: 'system',
      text: '',
      createdAt: isoAgo(44 * HOUR_MS),
      planningChat: { version: 1, kind: 'state', turnId: 'sft-1', status: 'failed', error: 'Timed out 44h ago', conversationId: staleFailPlanConvId },
    });

    // Stale and recent failed orchestrator missions
    sqlite.prepare('INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'm-fail-recent', 'ws-1', 'Recent failed mission', '', 'failed', '', null, 'balanced', null, isoAgo(30 * 60_000), isoAgo(10 * 60_000), isoAgo(10 * 60_000),
    );
    sqlite.prepare('INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'm-fail-stale', 'ws-1', 'Stale failed mission', '', 'failed', '', null, 'balanced', null, isoAgo(45 * HOUR_MS), isoAgo(44 * HOUR_MS), isoAgo(44 * HOUR_MS),
    );

    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;

    const recentPlanKey = `planning:ws-1:${plan.id}:${recentFailPlanConvId}`;
    const stalePlanKey = `planning:ws-1:${plan.id}:${staleFailPlanConvId}`;
    const recentFailPlanItem = summary.items.find((i) => i.itemKey === recentPlanKey)!;
    const staleFailPlanItem = summary.items.find((i) => i.itemKey === stalePlanKey)!;
    const recentFailMissionItem = summary.items.find((i) => i.itemKey === 'orchestrator:m-fail-recent')!;
    const staleFailMissionItem = summary.items.find((i) => i.itemKey === 'orchestrator:m-fail-stale')!;

    assert.equal(recentFailPlanItem.state, 'attention', 'recent unseen failed plan shows in attention');
    assert.equal(recentFailPlanItem.attention?.kind, 'error');
    assert.equal(staleFailPlanItem.state, 'failed', '44h-old failed plan stays in history, not attention');
    assert.equal(staleFailPlanItem.statusLabel, 'Failed');
    assert.equal(staleFailPlanItem.attention, null);

    assert.equal(recentFailMissionItem.state, 'attention', 'recent unseen failed mission shows in attention');
    assert.equal(recentFailMissionItem.attention?.kind, 'error');
    assert.equal(staleFailMissionItem.state, 'failed', '44h-old failed mission stays in history, not attention');
    assert.equal(staleFailMissionItem.statusLabel, 'Failed');
    assert.equal(staleFailMissionItem.attention, null);

    // Marking recent failures as seen moves them from attention -> failed
    await fetch(`${baseUrl}/api/activity/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: recentPlanKey, markSeen: true }),
    });
    await fetch(`${baseUrl}/api/activity/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: 'orchestrator:m-fail-recent', markSeen: true }),
    });

    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    assert.equal(summary.items.find((i) => i.itemKey === recentPlanKey)?.state, 'failed');
    assert.equal(summary.items.find((i) => i.itemKey === recentPlanKey)?.attention, null);
    assert.equal(summary.items.find((i) => i.itemKey === 'orchestrator:m-fail-recent')?.state, 'failed');
    assert.equal(summary.items.find((i) => i.itemKey === 'orchestrator:m-fail-recent')?.attention, null);

    // Dismissing a single planning item via PUT /api/activity/meta { cleared: true } does NOT archive the plan
    res = await fetch(`${baseUrl}/api/activity/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: stalePlanKey, cleared: 'bad' }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${baseUrl}/api/activity/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: stalePlanKey, cleared: true }),
    });
    assert.equal(res.status, 200);
    const metaClearBody = (await res.json()) as { clearedAt: string | null };
    assert.ok(metaClearBody.clearedAt);

    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    assert.equal(summary.items.find((i) => i.itemKey === stalePlanKey), undefined);
    assert.equal(planningStore.get('ws-1', plan.id).archivedAt, null);

    // Un-clearing restores the item
    res = await fetch(`${baseUrl}/api/activity/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: stalePlanKey, cleared: false }),
    });
    assert.equal(res.status, 200);
    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    assert.ok(summary.items.find((i) => i.itemKey === stalePlanKey));

    // 8c. Bogus 239h manual duration & false unreadCompletion on 19-day-old historical sessions
    const oldWorkingConvId = '99999999-9999-4999-8999-999999999999';
    const oldWorkingAgentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const oldProvSess1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
    const oldTranscript1 = path.join(claudeProjectDir, `${oldProvSess1}.jsonl`);
    fs.writeFileSync(oldTranscript1, JSON.stringify({ sessionId: oldProvSess1, type: 'assistant', message: { content: [] } }) + '\n');
    const oldSessDir = path.join(dataDir, 'manual-sessions', oldWorkingAgentId);
    fs.mkdirSync(oldSessDir, { recursive: true });
    fs.appendFileSync(
      path.join(oldSessDir, 'bindings.jsonl'),
      JSON.stringify({ sessionId: oldProvSess1, transcriptPath: oldTranscript1, event: 'UserPromptSubmit', at: isoAgo(10 * DAY_MS) }) + '\n',
    );
    manualStore.create('ws-1', '10d Old Dead Terminal', oldWorkingConvId);
    manualStore.save({
      id: oldWorkingAgentId,
      conversationId: oldWorkingConvId,
      name: 'Claude Old',
      catalogId: 'claude-sonnet',
      runtimeType: 'claude_code',
      model: 'claude-sonnet-4-5',
      accountProfileId: 'acc-claude',
      providerSessionId: oldProvSess1,
      cwd: wsOneDir,
      configDir: claudeConfigDir,
      sharedProfile: false,
      createdAt: isoAgo(10 * DAY_MS),
    });

    // Historical 19d-old completed manual, orchestrator, and planning sessions without activity_item_meta
    const oldDoneConvId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const oldDoneAgentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const oldProvSess2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
    const oldTranscript2 = path.join(claudeProjectDir, `${oldProvSess2}.jsonl`);
    fs.writeFileSync(oldTranscript2, JSON.stringify({ sessionId: oldProvSess2, type: 'assistant', message: { content: [] } }) + '\n');
    const oldDoneSessDir = path.join(dataDir, 'manual-sessions', oldDoneAgentId);
    fs.mkdirSync(oldDoneSessDir, { recursive: true });
    fs.appendFileSync(
      path.join(oldDoneSessDir, 'bindings.jsonl'),
      JSON.stringify({ sessionId: oldProvSess2, transcriptPath: oldTranscript2, event: 'Stop', at: isoAgo(19 * DAY_MS) }) + '\n',
    );
    manualStore.create('ws-1', '19d Old Manual Done', oldDoneConvId);
    manualStore.save({
      id: oldDoneAgentId,
      conversationId: oldDoneConvId,
      name: 'Claude Old Done',
      catalogId: 'claude-sonnet',
      runtimeType: 'claude_code',
      model: 'claude-sonnet-4-5',
      accountProfileId: 'acc-claude',
      providerSessionId: oldProvSess2,
      cwd: wsOneDir,
      configDir: claudeConfigDir,
      sharedProfile: false,
      createdAt: isoAgo(19 * DAY_MS),
    });

    sqlite.prepare('INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'm-old-done', 'ws-1', '19d Old Mission Done', '', 'completed', '', null, 'balanced', null, isoAgo(19 * DAY_MS), isoAgo(19 * DAY_MS), isoAgo(19 * DAY_MS),
    );

    const oldPlanConvId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await planningChat.createConversation('ws-1', plan.id, {
      id: oldPlanConvId,
      title: '19d Old Plan Done',
      catalogId: 'codex-gpt5',
    });
    planningStore.appendMessage('ws-1', plan.id, {
      id: 'op-start',
      role: 'user',
      text: 'Old plan turn',
      createdAt: isoAgo(19 * DAY_MS + 60_000),
      planningChat: { version: 1, kind: 'start', turnId: 'opt-1', sessionId: 'ops-1', clientMessageId: 'opm-1', catalogId: 'codex-gpt5', runtimeType: 'codex', model: 'gpt-5.4', conversationId: oldPlanConvId },
    });
    planningStore.appendMessage('ws-1', plan.id, {
      id: 'op-done',
      role: 'system',
      text: '',
      createdAt: isoAgo(19 * DAY_MS),
      planningChat: { version: 1, kind: 'state', turnId: 'opt-1', status: 'complete', activity: 'Complete', conversationId: oldPlanConvId },
    });

    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;

    const oldWorkingItem = summary.items.find((i) => i.itemKey === `manual:${oldWorkingConvId}`)!;
    assert.equal(oldWorkingItem.state, 'running');
    assert.equal(oldWorkingItem.durationMs, null, '10d-old stale working manual session must not compute 239h durationMs');

    // Transitioning a >12h active_started_at manual item to completed sets durationMs = null
    fs.appendFileSync(
      path.join(oldSessDir, 'bindings.jsonl'),
      JSON.stringify({ sessionId: oldProvSess1, transcriptPath: oldTranscript1, event: 'Stop', at: isoAgo(1_000) }) + '\n',
    );
    res = await fetch(`${baseUrl}/api/activity/summary`);
    summary = (await res.json()) as ActivitySummaryResponse;
    const transitionedOldItem = summary.items.find((i) => i.itemKey === `manual:${oldWorkingConvId}`)!;
    assert.equal(transitionedOldItem.state, 'completed');
    assert.equal(transitionedOldItem.durationMs, null, '>12h wall-clock gap does not persist bogus durationMs');

    // Historical 19d-old completed items must NOT have unreadCompletion = true
    const oldDoneManualItem = summary.items.find((i) => i.itemKey === `manual:${oldDoneConvId}`)!;
    assert.equal(oldDoneManualItem.state, 'completed');
    assert.equal(oldDoneManualItem.unreadCompletion, false);
    assert.equal(summary.items.find((i) => i.itemKey === 'orchestrator:m-old-done')?.unreadCompletion, false);
    assert.equal(summary.items.find((i) => i.itemKey === `planning:ws-1:${plan.id}:${oldPlanConvId}`)?.unreadCompletion, false);

    console.log('Activity routes tests passed.');
  } finally {
    await planningChat.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    sqlite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error('Activity routes test failed:', error);
  process.exit(1);
});
