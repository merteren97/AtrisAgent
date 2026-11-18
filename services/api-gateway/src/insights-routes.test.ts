import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import type { RuntimeTelemetry } from '@atris-agent-code/event-schema';
import { RuntimeHostV2, type RuntimeHost, type SpawnAgentOptions } from '@atris-agent-code/runtime-host';
import type { InsightsUsageResponse } from './activity-types';
import { installInsightsRoutes, recordPlanningTurnTelemetry } from './insights-routes';
import { ManualAntigravityBridge } from './manual-antigravity-bridge';
import { ManualConversationStore, type ManualAgent } from './manual-conversations';
import { ManualProviderBridge } from './manual-provider-bridge';
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
    CREATE TABLE runtime_telemetry (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      account_profile_id TEXT,
      attempt_id TEXT,
      outcome TEXT NOT NULL,
      usage_available INTEGER NOT NULL DEFAULT 0,
      usage_source TEXT NOT NULL DEFAULT 'unavailable',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL,
      currency TEXT NOT NULL DEFAULT 'USD',
      queue_wait_ms INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 1,
      worker_utilization REAL NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL
    );
  `);
  return sqlite;
}

async function runTests(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-insights-routes-'));
  const wsOneDir = path.join(tempDir, 'ws-1');
  const wsTwoDir = path.join(tempDir, 'ws-2');
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(wsOneDir, { recursive: true });
  fs.mkdirSync(wsTwoDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const now = new Date();
  const todayMid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  const twoDaysAgo = new Date(todayMid.getTime() - 2 * 86_400_000);
  const fifteenDaysAgo = new Date(todayMid.getTime() - 15 * 86_400_000);
  const sixtyDaysAgo = new Date(todayMid.getTime() - 60 * 86_400_000);

  const sqlite = createDb(path.join(dataDir, 'insights.db'));
  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('ws-1', 'Alpha', wsOneDir, sixtyDaysAgo.toISOString(), todayMid.toISOString());
  sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run('ws-2', 'Beta', wsTwoDir, sixtyDaysAgo.toISOString(), todayMid.toISOString());

  // 1. Test ManualProviderBridge.agentUsageSummary for all 4 providers
  const agRoot = path.join(tempDir, 'ag-root');
  fs.mkdirSync(agRoot, { recursive: true });
  const bridge = new ManualProviderBridge(dataDir, agRoot);
  const manualStore = new ManualConversationStore(sqlite, dataDir);

  // 1a. Claude Code transcript JSONL (session isolation + dedup + cache invalidation)
  const claudeConvId = randomUUID();
  const claudeAgentId = randomUUID();
  const claudeSessId = randomUUID();
  const claudeCfg = path.join(tempDir, 'claude-cfg');
  const claudeProj = path.join(claudeCfg, 'projects', 'alpha');
  fs.mkdirSync(claudeProj, { recursive: true });
  const claudeTranscript = path.join(claudeProj, `${claudeSessId}.jsonl`);
  const claudeLines = [
    { sessionId: claudeSessId, type: 'user', uuid: 'u1', timestamp: todayMid.toISOString(), message: { content: 'hi' } },
    // Streaming duplicate message.id: should keep latest only
    { sessionId: claudeSessId, type: 'assistant', uuid: 'a1a', timestamp: new Date(todayMid.getTime() + 1000).toISOString(), message: { id: 'msg_1', usage: { input_tokens: 100, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 20 } } },
    { sessionId: claudeSessId, type: 'assistant', uuid: 'a1b', timestamp: new Date(todayMid.getTime() + 5000).toISOString(), costUSD: 0.05, message: { id: 'msg_1', usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 50 } } },
    // Other session must be ignored
    { sessionId: randomUUID(), type: 'assistant', uuid: 'other', timestamp: new Date(todayMid.getTime() + 6000).toISOString(), message: { id: 'msg_other', usage: { input_tokens: 9999, output_tokens: 9999 } } },
  ];
  fs.writeFileSync(claudeTranscript, claudeLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const claudeAgent: ManualAgent = {
    id: claudeAgentId,
    conversationId: claudeConvId,
    name: 'Claude 1',
    catalogId: 'claude-sonnet',
    runtimeType: 'claude_code',
    model: 'claude-sonnet-4-5',
    accountProfileId: 'acc-claude',
    providerSessionId: claudeSessId,
    cwd: wsOneDir,
    configDir: claudeCfg,
    sharedProfile: false,
    createdAt: todayMid.toISOString(),
  };
  manualStore.create('ws-1', 'Claude Manual Work', claudeConvId);
  manualStore.save(claudeAgent);

  const claudeUsage1 = bridge.agentUsageSummary(claudeAgent);
  assert.equal(claudeUsage1.inputTokens, 100);
  assert.equal(claudeUsage1.cachedTokens, 50);
  assert.equal(claudeUsage1.outputTokens, 50);
  assert.equal(claudeUsage1.turnCount, 1);
  assert.equal(claudeUsage1.durationMs, 5000);
  assert.equal(claudeUsage1.totalCostUsd, 0.05);
  assert.equal(claudeUsage1.usageAvailable, true);
  // Cached call returns equal summary
  assert.deepEqual(bridge.agentUsageSummary(claudeAgent), claudeUsage1);

  // Append a second turn -> invalidates cache by mtime/size
  fs.appendFileSync(
    claudeTranscript,
    JSON.stringify({
      sessionId: claudeSessId,
      type: 'assistant',
      uuid: 'a2',
      timestamp: new Date(todayMid.getTime() + 12_000).toISOString(),
      costUSD: 0.02,
      message: { id: 'msg_2', usage: { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 30 } },
    }) + '\n',
  );
  const claudeUsage2 = bridge.agentUsageSummary(claudeAgent);
  assert.equal(claudeUsage2.inputTokens, 120);
  assert.equal(claudeUsage2.cachedTokens, 55);
  assert.equal(claudeUsage2.outputTokens, 80);
  assert.equal(claudeUsage2.turnCount, 2);
  assert.equal(claudeUsage2.durationMs, 12_000);

  // 1b. Codex rollout JSONL
  const codexConvId = randomUUID();
  const codexAgentId = randomUUID();
  const codexSessId = randomUUID();
  const codexCfg = path.join(tempDir, 'codex-cfg');
  fs.mkdirSync(codexCfg, { recursive: true });
  const codexRollout = path.join(codexCfg, 'rollout-1.jsonl');
  fs.writeFileSync(
    codexRollout,
    [
      { timestamp: twoDaysAgo.toISOString(), type: 'session_meta', payload: { id: codexSessId, source: 'cli' } },
      { timestamp: twoDaysAgo.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 } } } },
      { timestamp: new Date(twoDaysAgo.getTime() + 3000).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } },
      { timestamp: new Date(twoDaysAgo.getTime() + 8000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 40, output_tokens: 60, reasoning_output_tokens: 15 } } } },
      { timestamp: new Date(twoDaysAgo.getTime() + 9000).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const codexAgent: ManualAgent = {
    id: codexAgentId,
    conversationId: codexConvId,
    name: 'Codex 1',
    catalogId: 'codex-gpt5',
    runtimeType: 'codex',
    model: 'gpt-5.4',
    accountProfileId: 'acc-codex',
    providerSessionId: codexSessId,
    cwd: wsOneDir,
    configDir: codexCfg,
    sharedProfile: false,
    createdAt: twoDaysAgo.toISOString(),
  };
  bridge.bindCodexRuntime(codexAgent, codexSessId, codexRollout);
  manualStore.create('ws-1', 'Codex Manual Work', codexConvId);
  manualStore.save(codexAgent);

  const codexUsage = bridge.agentUsageSummary(codexAgent);
  assert.equal(codexUsage.inputTokens, 200);
  assert.equal(codexUsage.cachedTokens, 40);
  assert.equal(codexUsage.outputTokens, 60);
  assert.equal(codexUsage.reasoningTokens, 15);
  assert.equal(codexUsage.turnCount, 2);
  assert.equal(codexUsage.durationMs, 9000);
  assert.equal(codexUsage.usageAvailable, true);

  // 1c. OpenCode session message JSON files + fallback
  const ocConvId = randomUUID();
  const ocAgentId = randomUUID();
  const ocSessionId = 'ses_abc123';
  const ocCfg = path.join(tempDir, 'oc-cfg');
  const ocSessDir = path.join(dataDir, 'manual-sessions', ocAgentId);
  fs.mkdirSync(ocSessDir, { recursive: true });
  fs.writeFileSync(
    path.join(ocSessDir, 'opencode-history.json'),
    JSON.stringify({ sessionId: ocSessionId, messages: [{ id: 'm1', role: 'assistant', text: 'Done' }] }),
  );
  const ocMsgDir = path.join(ocCfg, 'data', 'opencode', 'storage', 'message', ocSessionId);
  fs.mkdirSync(ocMsgDir, { recursive: true });
  fs.writeFileSync(
    path.join(ocMsgDir, 'msg_1.json'),
    JSON.stringify({
      role: 'assistant',
      cost: 0.03,
      time: { created: fifteenDaysAgo.getTime(), completed: fifteenDaysAgo.getTime() + 4000 },
      tokens: { input: 80, output: 25, reasoning: 10, cache: { read: 12, write: 3 } },
    }),
  );
  const ocAgent: ManualAgent = {
    id: ocAgentId,
    conversationId: ocConvId,
    name: 'OpenCode 1',
    catalogId: 'oc-model',
    runtimeType: 'opencode',
    model: 'anthropic/claude-sonnet',
    accountProfileId: 'acc-oc',
    providerSessionId: ocSessionId,
    cwd: wsTwoDir,
    configDir: ocCfg,
    sharedProfile: false,
    createdAt: fifteenDaysAgo.toISOString(),
  };
  manualStore.create('ws-2', 'OpenCode Manual Work', ocConvId);
  manualStore.save(ocAgent);

  const ocUsage = bridge.agentUsageSummary(ocAgent);
  assert.equal(ocUsage.inputTokens, 80);
  assert.equal(ocUsage.outputTokens, 25);
  assert.equal(ocUsage.reasoningTokens, 10);
  assert.equal(ocUsage.cachedTokens, 15);
  assert.equal(ocUsage.totalCostUsd, 0.03);
  assert.equal(ocUsage.turnCount, 1);
  assert.equal(ocUsage.durationMs, 4000);
  assert.equal(ocUsage.usageAvailable, true);

  // OpenCode fallback when storage dir is absent
  const ocFallbackAgent: ManualAgent = {
    ...ocAgent,
    id: randomUUID(),
    configDir: path.join(tempDir, 'missing-oc-cfg'),
  };
  const ocFallbackDir = path.join(dataDir, 'manual-sessions', ocFallbackAgent.id);
  fs.mkdirSync(ocFallbackDir, { recursive: true });
  fs.writeFileSync(
    path.join(ocFallbackDir, 'opencode-history.json'),
    JSON.stringify({ sessionId: ocSessionId, messages: [{ id: 'm1', role: 'assistant', text: 'Ok' }] }),
  );
  const ocFallbackUsage = bridge.agentUsageSummary(ocFallbackAgent);
  assert.equal(ocFallbackUsage.usageAvailable, false);
  assert.equal(ocFallbackUsage.turnCount, 1);

  // 1d. Antigravity thinkingTokens via ManualAntigravityBridge
  const agAgentId = randomUUID();
  const agSessionId = randomUUID();
  const agAgent: ManualAgent = {
    id: agAgentId,
    conversationId: randomUUID(),
    name: 'Antigravity 1',
    catalogId: 'ag-gemini',
    runtimeType: 'antigravity',
    model: 'gemini-3-pro',
    accountProfileId: 'acc-ag',
    providerSessionId: agSessionId,
    cwd: wsOneDir,
    configDir: '',
    sharedProfile: true,
    createdAt: todayMid.toISOString(),
  };
  const agBridge = new ManualAntigravityBridge(dataDir, agRoot);
  const agArgs = agBridge.prepare(agAgent);
  fs.appendFileSync(agArgs[1], `INFO Created conversation ${agSessionId}\n`);
  const agTranscript = path.join(agRoot, 'brain', agSessionId, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(agTranscript), { recursive: true });
  fs.writeFileSync(
    agTranscript,
    [
      { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'Explain architecture', created_at: todayMid.toISOString() },
      { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', thinking: 'Thinking...', output_tokens: 77, content: 'Architecture answer', created_at: todayMid.toISOString() },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const agUsage = bridge.agentUsageSummary(agAgent);
  assert.equal(agUsage.reasoningTokens, 77);
  assert.equal(agUsage.turnCount, 1);
  assert.equal(agUsage.usageAvailable, true);

  // 2. Orchestrator runtime_telemetry rows + RuntimeHostV2 supervisor telemetry check
  sqlite.prepare('INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm-orch-1', 'ws-1', 'Orchestrated Feature', '', 'completed', '', null, 'balanced', null, twoDaysAgo.toISOString(), twoDaysAgo.toISOString(), twoDaysAgo.toISOString(),
  );
  sqlite.prepare('INSERT INTO missions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm-orch-old', 'ws-2', 'Old Mission', '', 'completed', '', null, 'balanced', null, sixtyDaysAgo.toISOString(), sixtyDaysAgo.toISOString(), sixtyDaysAgo.toISOString(),
  );
  sqlite.prepare(
    `INSERT INTO runtime_telemetry
      (id, mission_id, task_id, agent_instance_id, adapter_id, account_profile_id, attempt_id, outcome,
       usage_available, usage_source, input_tokens, output_tokens, cost, currency, queue_wait_ms, duration_ms, retry_count, worker_utilization, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('rt-1', 'm-orch-1', 'supervisor', 'supervisor', 'claude_code', 'acc-1', 'att-1', 'completed', 1, 'provider_reported', 300, 100, 0.04, 'USD', 0, 2500, 0, 0.5, todayMid.toISOString());
  sqlite.prepare(
    `INSERT INTO runtime_telemetry
      (id, mission_id, task_id, agent_instance_id, adapter_id, account_profile_id, attempt_id, outcome,
       usage_available, usage_source, input_tokens, output_tokens, cost, currency, queue_wait_ms, duration_ms, retry_count, worker_utilization, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('rt-old', 'm-orch-old', 'task-1', 'agent-old', 'codex', 'acc-2', 'att-old', 'completed', 1, 'provider_reported', 900, 300, 0.2, 'USD', 0, 15000, 0, 0.5, sixtyDaysAgo.toISOString());

  // 3. PlanningChatController onTurnTelemetry + usage_ledger
  const planningStore = new PlanningStore((id) =>
    sqlite.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(id) as { id: string; path: string } | undefined,
  );
  const plan = planningStore.create('ws-1', { id: 'plan-insights', title: 'Insights Plan', content: '# Plan' });
  const planningTelemetryEvents: string[] = [];
  const planningRuntimeStub = {
    getModelCatalogService: () => ({
      resolveModelDescriptor: async () => ({
        catalogId: 'codex-gpt5',
        runtimeId: 'codex',
        runtimeModelId: 'gpt-5.4',
        accountProfileId: 'acc-codex',
        availability: 'available',
        source: 'live',
        supportedReasoning: ['medium'],
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
    runtimeHost: planningRuntimeStub as any,
    onTurnTelemetry: (entry) => {
      planningTelemetryEvents.push(entry.turnId);
      recordPlanningTurnTelemetry(sqlite, entry, 'Insights Plan');
    },
    createAdapter: (_runtime, bus) =>
      ({
        configureProfile() {},
        probeCapabilities: async () => ({
          structuredEventStreaming: true,
          cancellation: true,
          modelSelection: true,
          reasoningControl: true,
        }),
        getUsage: async () => ({
          inputTokens: 150,
          outputTokens: 60,
          totalCost: 0.01,
          currency: 'USD',
          timestamp: todayMid.toISOString(),
        }),
        spawnAgent: async (opts: SpawnAgentOptions) => {
          setTimeout(() => {
            bus.emit({
              id: 'ev-1',
              type: 'task_completed',
              missionId: opts.missionId,
              taskId: opts.taskId,
              agentInstanceId: opts.sessionId!,
              result: 'Here is the plan analysis.',
              timestamp: todayMid.toISOString(),
            });
          }, 10);
          return { id: opts.sessionId!, agentInstanceId: opts.sessionId!, runtimeSessionId: opts.sessionId!, startedAt: todayMid.toISOString(), endedAt: null };
        },
        cancel: async () => {},
        shutdown: async () => {},
      }) as unknown as PlanningChatAdapter,
  });

  await planningChat.send('ws-1', plan.id, {
    id: 'msg-client-1',
    text: 'Analyze tokens',
    catalogId: 'codex-gpt5',
  });
  await new Promise((r) => setTimeout(r, 100));
  await planningChat.close();
  assert.equal(planningTelemetryEvents.length, 1, 'PlanningChatController invokes onTurnTelemetry on turn completion');

  // Verify RuntimeHostV2.runSupervisorTurn emits supervisor runtime_telemetry
  const hostBus = new LocalEventBus();
  const emittedTelemetry: RuntimeTelemetry[] = [];
  hostBus.on('runtime_telemetry', (ev) => {
    emittedTelemetry.push(ev);
  });
  const v2Host = new RuntimeHostV2(hostBus, { workspacePath: wsOneDir });
  // Stub profile manager, catalog service, and isolated adapter creation on v2Host
  (v2Host as any).getAccountProfileManager = () => ({
    getProfiles: async () => [{
      id: 'acc-sup',
      provider: 'anthropic',
      runtimeType: 'claude_code',
      profileName: 'Default',
      authStatus: 'connected',
      configDir: claudeCfg,
      profileMode: 'isolated',
      supportedModels: ['claude-sonnet-4-5'],
      schedulerAuto: true,
      createdAt: todayMid.toISOString(),
      updatedAt: todayMid.toISOString(),
    }],
  });
  (v2Host as any).getModelCatalogService = () => ({
    getCachedCatalog: () => [{
      catalogId: 'sup-model',
      accountProfileId: 'acc-sup',
      runtimeId: 'claude_code',
      runtimeModelId: 'claude-sonnet-4-5',
      displayName: 'Claude Sonnet',
      provider: 'anthropic',
      availability: 'available',
      source: 'live',
      supportedRoles: ['orchestrator'],
      supportedReasoning: [],
      defaultReasoning: undefined,
      capabilities: ['planning', 'evaluation', 'delegation', 'conversation'],
      contextWindow: 200000,
    }],
    discoverLiveModels: async () => [],
  });
  (v2Host as any).createIsolatedAdapter = (_runtime: string, turnBus: LocalEventBus) => ({
    setEventBus() {},
    configureProfile() {},
    getSessionContinuityCapabilities: () => ({ reuseWhileAlive: false, resumeAfterRestart: false }),
    probeProviderSession: async () => false,
    getUsage: async () => ({
      inputTokens: 444,
      outputTokens: 111,
      totalCost: 0.02,
      currency: 'USD',
      timestamp: todayMid.toISOString(),
    }),
    spawnAgent: async (opts: any) => {
      setTimeout(() => {
        turnBus.emit({
          id: 'sup-done',
          type: 'task_completed',
          missionId: opts.missionId,
          taskId: opts.taskId,
          agentInstanceId: opts.sessionId,
          result: 'Supervisor plan ready',
          timestamp: todayMid.toISOString(),
        });
      }, 10);
      return { id: opts.sessionId, agentInstanceId: opts.sessionId, runtimeSessionId: opts.sessionId, startedAt: todayMid.toISOString(), endedAt: null };
    },
    shutdown: async () => {},
  });

  const supOut = await v2Host.runSupervisorTurn({
    missionId: 'm-orch-1',
    turnId: 'sup-turn-99',
    prompt: 'Plan work',
    workspacePath: wsOneDir,
  });
  assert.equal(supOut, 'Supervisor plan ready');
  assert.equal(emittedTelemetry.length, 1);
  assert.equal(emittedTelemetry[0].taskId, 'supervisor');
  assert.equal(emittedTelemetry[0].agentInstanceId, 'supervisor');
  assert.equal(emittedTelemetry[0].attemptId, 'sup-turn-99');
  assert.equal(emittedTelemetry[0].outcome, 'completed');
  assert.equal(emittedTelemetry[0].inputTokens, 444);
  assert.equal(emittedTelemetry[0].outputTokens, 111);

  // 4. Test GET /api/insights/usage HTTP endpoint
  const app = express();
  app.use(express.json());
  installInsightsRoutes(app, {
    sqlite,
    manualConversationStore: manualStore,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // Invalid range returns 400
    let res = await fetch(`${baseUrl}/api/insights/usage?range=invalid`);
    assert.equal(res.status, 400);

    // range=today: includes Claude manual (120+80+55=255), Orchestrator rt-1 (300+100=400), Planning turn (150+60=210)
    res = await fetch(`${baseUrl}/api/insights/usage?range=today`);
    assert.equal(res.status, 200);
    const todayData = (await res.json()) as InsightsUsageResponse;
    assert.equal(todayData.range, 'today');
    assert.equal(todayData.byProvider.length, 4);
    assert.equal(todayData.byMode.length, 3);
    assert.equal(todayData.totals.inputTokens, 120 + 300 + 150);
    assert.equal(todayData.totals.outputTokens, 80 + 100 + 60);
    assert.equal(todayData.totals.cachedTokens, 55);
    assert.equal(todayData.totals.totalTokens, 255 + 400 + 210);
    assert.equal(todayData.totals.totalRuns, 3);
    assert.equal(todayData.totals.tokenReportedRuns, 3);

    // range=7d: adds Codex manual (twoDaysAgo: 200+60+40+15 = 315)
    res = await fetch(`${baseUrl}/api/insights/usage?range=7d`);
    const weekData = (await res.json()) as InsightsUsageResponse;
    assert.equal(weekData.totals.totalRuns, 4);
    assert.equal(weekData.totals.totalTokens, 255 + 400 + 210 + 315);
    // Daily points sorted ascending
    assert.equal(weekData.daily.length, 2);
    assert.ok(weekData.daily[0].date < weekData.daily[1].date);

    // range=30d: adds OpenCode manual (fifteenDaysAgo: 80+25+15+10 = 130)
    res = await fetch(`${baseUrl}/api/insights/usage?range=30d`);
    const monthData = (await res.json()) as InsightsUsageResponse;
    assert.equal(monthData.totals.totalRuns, 5);
    assert.equal(monthData.totals.totalTokens, 255 + 400 + 210 + 315 + 130);

    // range=all: adds rt-old (900+300=1200)
    res = await fetch(`${baseUrl}/api/insights/usage?range=all`);
    const allData = (await res.json()) as InsightsUsageResponse;
    assert.equal(allData.totals.totalRuns, 6);
    assert.equal(allData.totals.totalTokens, 255 + 400 + 210 + 315 + 130 + 1200);
    assert.equal(allData.topSessions[0].itemKey, 'orchestrator:m-orch-old', 'topSessions sorted by totalTokens desc');
    assert.equal(allData.topSessions[0].target.missionId, 'm-orch-old');

    // workspaceId filter
    res = await fetch(`${baseUrl}/api/insights/usage?range=all&workspaceId=ws-2`);
    const ws2Data = (await res.json()) as InsightsUsageResponse;
    assert.equal(ws2Data.workspaceId, 'ws-2');
    assert.equal(ws2Data.totals.totalRuns, 2);
    assert.equal(ws2Data.totals.totalTokens, 130 + 1200);

    console.log('Insights routes tests passed.');
  } finally {
    await v2Host.stopAll();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    sqlite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error('Insights routes test failed:', error);
  process.exit(1);
});
