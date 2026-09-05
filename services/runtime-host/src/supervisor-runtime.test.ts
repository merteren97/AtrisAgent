import {
  configureRuntimeControlPlaneBridge,
  prepareControlPlaneSession,
} from './control-plane';
import { RuntimeHostV2 } from './runtime-host-v2';

async function runTests() {
  let passed = 0;
  let failed = 0;
  const assert = (condition: boolean, message: string) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${message}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${message}`);
    }
  };

  console.log('--- Supervisor Runtime Boundary Tests ---');
  let grantCalls = 0;
  configureRuntimeControlPlaneBridge({
    endpoint: 'http://127.0.0.1:3001/api/control-plane',
    bridgeScriptPath: '/tmp/atris-control-plane-bridge.js',
    issueGrant: () => {
      grantCalls += 1;
      return { token: 'test-token', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
  });

  const isolatedSupervisor = prepareControlPlaneSession({
    sessionId: 'orchestrator-turn-1',
    taskId: 'turn-1',
    missionId: 'supervisor-conversation-1',
    prompt: 'Decide this turn.',
    role: 'orchestrator',
    enableCoordinationMcp: false,
  }, 'orchestrator-turn-1');
  assert(isolatedSupervisor === undefined, 'supervisor decision run receives no coordination MCP session');
  assert(grantCalls === 0, 'supervisor decision run does not mint a synthetic task grant');

  const worker = prepareControlPlaneSession({
    sessionId: 'researcher-1',
    taskId: 'task-1',
    missionId: 'mission-1',
    prompt: 'Research the issue.',
    role: 'researcher',
    enableCoordinationMcp: true,
  }, 'researcher-1');
  assert(Boolean(worker), 'normal mission worker still receives the configured control-plane session');
  assert(grantCalls === 1, 'normal worker grant issuance remains intact');

  const route = {
    adapterId: 'opencode', provider: 'opencode', accountProfileId: 'profile-1', modelCatalogId: 'catalog-1',
    runtimeModelId: 'provider/model', reasoningLevel: 'medium', source: 'explicit', selectionMode: 'fixed',
  };
  const makeManager = (persisted?: any) => {
    const saved: any[] = [];
    return {
      saved,
      async resolveRoleExecutionPolicy() { return undefined; },
      async getLatestSupervisorSessionMetadata() { return persisted || saved.at(-1)?.metadata; },
      async saveSupervisorSessionMetadata(turnId: string, metadata: any) { saved.push({ turnId, metadata }); },
    };
  };
  const configureHost = (host: any, factory: () => any) => {
    host.getAccountProfileManager().getProfiles = async () => [{
      id: 'profile-1', provider: 'opencode', runtimeType: 'opencode', profileName: 'OpenCode', authStatus: 'connected', schedulerAuto: true,
    }];
    host.getModelCatalogService().getCachedCatalog = () => [{
      catalogId: 'catalog-1', runtimeId: 'opencode', accountProfileId: 'profile-1', providerId: 'opencode', runtimeModelId: 'provider/model',
      displayName: 'Model', supportedRoles: ['orchestrator'], supportedReasoning: ['medium'], inputModalities: ['text'], availability: 'available', source: 'discovered',
    }];
    host.createIsolatedAdapter = (_runtimeType: string, eventBus: any) => {
      const adapter = factory();
      adapter.setEventBus(eventBus);
      return adapter;
    };
  };
  const makeAdapter = (capabilities = { reuseWhileAlive: true, resumeAfterRestart: true }, probe = true) => {
    let bus: any;
    const state = { spawns: [] as any[], shutdowns: 0, releases: 0, probes: 0 };
    return {
      id: 'opencode', runtimeType: 'opencode', name: 'OpenCode test', state,
      setEventBus(value: any) { bus = value; }, configureProfile() {},
      getSessionContinuityCapabilities: () => capabilities,
      async probeProviderSession() { state.probes += 1; return probe; },
      async releaseProviderSession() { state.releases += 1; },
      async shutdown() { state.shutdowns += 1; },
      async spawnAgent(options: any) {
        state.spawns.push(options);
        queueMicrotask(() => bus.emit({
          id: crypto.randomUUID(), type: 'task_completed', missionId: options.missionId, taskId: options.taskId,
          agentInstanceId: options.sessionId, result: 'ok', timestamp: new Date().toISOString(),
        }));
        return { id: options.sessionId, agentInstanceId: options.sessionId, runtimeSessionId: options.providerSessionId || 'provider-session-1' };
      },
    };
  };

  // A healthy OpenCode adapter/provider session is reused, with the explicit route persisted on every turn.
  {
    const manager = makeManager();
    const adapter = makeAdapter();
    let adaptersCreated = 0;
    const host: any = new RuntimeHostV2(undefined, { workspaceManager: manager as any, watchdogInterval: 0, supervisorSessionIdleTtl: 10_000 });
    configureHost(host, () => { adaptersCreated += 1; return adapter; });
    await host.runSupervisorTurn({ missionId: 'conversation-reuse', turnId: 'turn-1', prompt: 'one', modelCatalogId: 'catalog-1', accountProfileId: 'profile-1', selectionMode: 'fixed' });
    await host.runSupervisorTurn({ missionId: 'conversation-reuse', turnId: 'turn-2', prompt: 'two' });
    assert(adaptersCreated === 1 && adapter.state.spawns[1].providerSessionId === 'provider-session-1', 'healthy OpenCode provider session is reused across supervisor turns');
    assert(manager.saved.length === 2 && manager.saved[1].metadata.route.modelCatalogId === 'catalog-1' && manager.saved[1].metadata.resumeCapability === 'restart', 'provider session capability and explicit supervisor route snapshot are persisted without server credentials');
    await host.stopAll();
  }

  // Cached/unknown routes are refreshed before selection and never reach a
  // provider process when the refresh still cannot verify them.
  {
    const manager = makeManager();
    const adapter = makeAdapter();
    const host: any = new RuntimeHostV2(undefined, { workspaceManager: manager as any, watchdogInterval: 0 });
    configureHost(host, () => adapter);
    const staleModel = {
      catalogId: 'catalog-stale', runtimeId: 'opencode', accountProfileId: 'profile-1', providerId: 'opencode',
      runtimeModelId: 'provider/stale-model', displayName: 'Stale model', supportedRoles: ['orchestrator'],
      supportedReasoning: ['medium'], inputModalities: ['text'], availability: 'unknown', source: 'cached',
    };
    const catalog: any = host.getModelCatalogService();
    catalog.getCachedCatalog = () => [staleModel];
    catalog.discoverLiveModels = async () => [staleModel];
    let staleError = '';
    try {
      await host.runSupervisorTurn({ missionId: 'conversation-stale', turnId: 'turn-stale', prompt: 'do not spawn', modelCatalogId: 'catalog-stale', accountProfileId: 'profile-1', selectionMode: 'fixed' });
    } catch (error: any) {
      staleError = String(error?.message || error);
    }
    assert(staleError.includes('not verified by a live runtime catalog'), 'supervisor fails closed for a stale cached route');
    assert(adapter.state.spawns.length === 0, 'supervisor does not spawn an agent for an unverified route');
    await host.stopAll();
  }

  // Failed health validation discards continuity and safely creates a fresh provider session.
  {
    const manager = makeManager();
    const first = makeAdapter({ reuseWhileAlive: true, resumeAfterRestart: true }, false);
    const second = makeAdapter();
    let created = 0;
    const host: any = new RuntimeHostV2(undefined, { workspaceManager: manager as any, watchdogInterval: 0 });
    configureHost(host, () => (++created === 1 ? first : second));
    await host.runSupervisorTurn({ missionId: 'conversation-unhealthy', turnId: 'turn-1', prompt: 'one', modelCatalogId: 'catalog-1' });
    await host.runSupervisorTurn({ missionId: 'conversation-unhealthy', turnId: 'turn-2', prompt: 'two' });
    assert(created === 2 && second.state.spawns[0].providerSessionId === undefined && first.state.releases === 1, 'unhealthy continuity is released and falls back to a new provider session');
    await host.stopAll();
  }

  // Restart resume is attempted only for an explicitly restart-safe provider; unsupported CLIs never receive a persisted ID.
  {
    const persisted = {
      providerSessionId: 'persisted-provider', resumeCapability: 'restart', route,
      agentProfileId: 'supervisor-specialist', updatedAt: new Date().toISOString(),
    };
    const manager = makeManager(persisted);
    const supported = makeAdapter();
    const host: any = new RuntimeHostV2(undefined, {
      workspaceManager: manager as any,
      watchdogInterval: 0,
      agentProfiles: [{ id: 'supervisor-specialist', name: 'Supervisor Specialist', role: 'orchestrator', instructions: '', capabilities: [] }],
    });
    configureHost(host, () => supported);
    await host.runSupervisorTurn({ missionId: 'conversation-restart', turnId: 'turn-restart', prompt: 'resume' });
    assert(supported.state.probes === 1 && supported.state.spawns[0].providerSessionId === 'persisted-provider'
      && supported.state.spawns[0].agentProfileId === 'supervisor-specialist', 'restart-safe provider session and persisted agent profile are reattached only after health validation');
    await host.stopAll();

    const unsupported = makeAdapter({ reuseWhileAlive: false, resumeAfterRestart: false });
    const unsupportedHost: any = new RuntimeHostV2(undefined, {
      workspaceManager: manager as any,
      watchdogInterval: 0,
      agentProfiles: [{ id: 'supervisor-specialist', name: 'Supervisor Specialist', role: 'orchestrator', instructions: '', capabilities: [] }],
    });
    configureHost(unsupportedHost, () => unsupported);
    await unsupportedHost.runSupervisorTurn({ missionId: 'conversation-restart', turnId: 'turn-unsupported', prompt: 'recover durably' });
    assert(unsupported.state.probes === 0 && unsupported.state.spawns[0].providerSessionId === undefined, 'unsupported Codex/Claude/Antigravity-style provider starts fresh from durable context instead of pretending resume');
    await unsupportedHost.stopAll();
  }

  // A persisted provider session must belong to the same account and specialist.
  for (const mismatch of ['account', 'agent-profile']) {
    const manager = makeManager({
      providerSessionId: 'foreign-session', resumeCapability: 'restart',
      route: { ...route, accountProfileId: mismatch === 'account' ? 'other-account' : route.accountProfileId },
      agentProfileId: mismatch === 'agent-profile' ? 'old-specialist' : 'orchestrator',
    });
    const adapter = makeAdapter();
    const host: any = new RuntimeHostV2(undefined, { workspaceManager: manager as any, watchdogInterval: 0 });
    configureHost(host, () => adapter);
    await host.runSupervisorTurn({ missionId: `mismatch-${mismatch}`, turnId: 'new-turn', prompt: 'fresh', agentProfileId: 'orchestrator', modelCatalogId: 'catalog-1', accountProfileId: 'profile-1' });
    assert(adapter.state.spawns[0].providerSessionId === undefined && adapter.state.probes === 0,
      `restart does not reuse a provider session after ${mismatch} changes`);
    await host.stopAll();
  }

  // Idle TTL and mission cancellation both release reusable provider state.
  {
    const manager = makeManager();
    const adapter = makeAdapter();
    const host: any = new RuntimeHostV2(undefined, { workspaceManager: manager as any, watchdogInterval: 0, supervisorSessionIdleTtl: 5 });
    configureHost(host, () => adapter);
    await host.runSupervisorTurn({ missionId: 'conversation-idle', turnId: 'turn-idle', prompt: 'idle', modelCatalogId: 'catalog-1' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert(adapter.state.releases === 1 && adapter.state.shutdowns === 1, 'idle TTL evicts and releases the reusable supervisor provider session');
    await host.stopAll();

    const cancelAdapter = makeAdapter();
    const cancelHost: any = new RuntimeHostV2(undefined, { workspaceManager: manager as any, watchdogInterval: 0, supervisorSessionIdleTtl: 10_000 });
    configureHost(cancelHost, () => cancelAdapter);
    await cancelHost.runSupervisorTurn({ missionId: 'conversation-cancel', turnId: 'turn-cancel', prompt: 'cancel', modelCatalogId: 'catalog-1' });
    await cancelHost.stopMission('conversation-cancel');
    assert(cancelAdapter.state.releases === 1 && cancelAdapter.state.shutdowns === 1, 'mission cancellation cleans up reusable supervisor session state');
    await cancelHost.stopAll();
  }

  configureRuntimeControlPlaneBridge(undefined);
  console.log(`--- Supervisor Runtime Boundary Tests Complete: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
