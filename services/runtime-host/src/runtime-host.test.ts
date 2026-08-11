import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type { AccountProfileStatus, CapabilitySnapshot } from '@atris-agent-code/domain';
import { ClaudeCodeAdapter } from './adapters/claude-code-adapter';
import { OpenCodeAdapter } from './adapters/opencode-adapter';
import { CodexAdapter } from './adapters/codex-adapter';
import { AntigravityAdapter } from './adapters/antigravity-adapter';
import { ModelCatalogService } from './model-catalog-service';
import { AccountProfileManager } from './account-profile-manager';
import { runtimeProfileEnv } from './runtime-utils';

async function runTests() {
  console.log('--- Starting RuntimeHost & Adapters Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  function validCapabilitySnapshot(snapshot: CapabilitySnapshot): boolean {
    const required: Array<keyof CapabilitySnapshot> = [
      'structuredEventStreaming',
      'sessionResume',
      'modelSelection',
      'reasoningControl',
      'toolCallEvents',
      'interactiveApproval',
      'usageInfo',
      'cancellation',
      'worktreeAwareness',
      'headlessAuth',
      'nativeSubAgent',
    ];
    return required.every((key) => typeof snapshot[key] === 'boolean');
  }

  // 1. Capability fallback contract must be stable without relying on host-installed CLIs.
  {
    const adapters = [
      new ClaudeCodeAdapter(),
      new OpenCodeAdapter(),
      new CodexAdapter(),
      new AntigravityAdapter(),
    ];

    for (const adapter of adapters) {
      (adapter as any).discoverInstallation = async () => ({ installed: false });
      const capabilities = await adapter.probeCapabilities();
      assert(validCapabilitySnapshot(capabilities), `${adapter.name} returns a complete boolean capability snapshot when unavailable`);
    }
  }

  // 2. Runtime profile isolation is defined by public environment helpers, not adapter-private methods.
  {
    const claudeA = runtimeProfileEnv('claude_code', 'profile-alpha').CLAUDE_CONFIG_DIR;
    const claudeB = runtimeProfileEnv('claude_code', 'profile-beta').CLAUDE_CONFIG_DIR;
    assert(Boolean(claudeA && claudeB && claudeA !== claudeB), 'CLAUDE_CONFIG_DIR is isolated per profile ID');

    const codexA = runtimeProfileEnv('codex', 'profile-alpha').CODEX_HOME;
    const codexB = runtimeProfileEnv('codex', 'profile-beta').CODEX_HOME;
    assert(Boolean(codexA && codexB && codexA !== codexB), 'CODEX_HOME is isolated per profile ID');

    const openCodeA = runtimeProfileEnv('opencode', 'profile-alpha');
    const openCodeB = runtimeProfileEnv('opencode', 'profile-beta');
    assert(
      Boolean(openCodeA.XDG_DATA_HOME && openCodeB.XDG_DATA_HOME && openCodeA.XDG_DATA_HOME !== openCodeB.XDG_DATA_HOME),
      'OpenCode XDG data/config roots are isolated per profile ID',
    );

    assert(Object.keys(runtimeProfileEnv('antigravity', 'profile-alpha')).length === 0, 'Antigravity does not falsely claim env-based credential isolation');
  }

  // 3. ModelCatalogService deterministic discovery & caching tests
  {
    const tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-catalog-test-'));
    try {
      const catalogService = new ModelCatalogService(undefined, tempStorageDir);
      const fakeAdapter: any = {
        id: 'claude_code',
        runtimeType: 'claude_code',
        name: 'Fake Claude Runtime',
        configureProfile() {},
        async discoverModels() {
          return [
            {
              catalogId: 'claude_code:profile-test:claude-test',
              runtimeId: 'claude_code',
              accountProfileId: 'profile-test',
              providerId: 'anthropic',
              runtimeModelId: 'claude-test',
              displayName: 'Claude Test',
              supportedRoles: ['builder'],
              supportedReasoning: ['medium'],
              inputModalities: ['text'],
              availability: 'available',
              source: 'discovered',
            },
          ];
        },
      };
      catalogService.registerAdapter(fakeAdapter);

      const profile: any = {
        id: 'profile-test',
        runtimeType: 'claude_code',
        provider: 'anthropic',
        profileName: 'Test Claude Profile',
        authStatus: 'connected',
      };
      const liveModels = await catalogService.discoverLiveModels([profile]);
      assert(liveModels.length === 1, 'ModelCatalogService discovers models for connected account profiles');
      assert(liveModels[0].routeLabel === 'Fake Claude Runtime · Test Claude Profile', 'ModelCatalogService adds a stable route label');

      const cached = catalogService.getCachedCatalog();
      assert(cached.length === 1 && cached[0].catalogId === liveModels[0].catalogId, 'ModelCatalogService returns cached catalog');

      const resolved = await catalogService.resolveModelDescriptor(liveModels[0].catalogId);
      assert(resolved !== undefined && resolved.catalogId === liveModels[0].catalogId, 'resolveModelDescriptor finds model by catalogId');
    } finally {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    }
  }

  // 4. AccountProfileManager CRUD & Status Badges Tests
  {
    const tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-profile-test-'));
    try {
      const profileManager = new AccountProfileManager(tempStorageDir);
      const created = await profileManager.createProfile({
        provider: 'anthropic',
        runtimeType: 'claude_code',
        profileName: 'Primary Anthropic Account',
        authStatus: 'connected',
        configDir: '',
        supportedModels: ['claude-3-7-sonnet'],
        usageScope: 'anthropic-subscription',
      });
      assert(typeof created.id === 'string' && created.profileName === 'Primary Anthropic Account', 'AccountProfileManager creates profile successfully');

      const profiles = await profileManager.getProfiles();
      assert(profiles.length === 1 && profiles[0].id === created.id, 'getProfiles returns created profile');

      const byId = await profileManager.getProfileById(created.id);
      assert(byId !== undefined && byId.id === created.id, 'getProfileById returns requested profile');

      const statusBadges: AccountProfileStatus[] = ['connected', 'expiring', 'rate_limited', 'reauth_required'];
      for (const badge of statusBadges) {
        const updated = await profileManager.updateProfile(created.id, { authStatus: badge });
        assert(updated.authStatus === badge, `AccountProfileManager updates status badge to '${badge}'`);
      }

      const deleted = await profileManager.deleteProfile(created.id);
      assert(deleted === true, 'deleteProfile returns true on successful deletion');
      assert((await profileManager.getProfiles()).length === 0, 'deleteProfile removes profile from storage');
    } finally {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    }
  }

  // 5. Stream event normalization tests use the adapters' current line-based parser contract.
  {
    const eventBus = new LocalEventBus();
    const emittedEvents: AgentEvent[] = [];
    eventBus.on('*', (event) => {
      emittedEvents.push(event);
    });

    emittedEvents.length = 0;
    const claudeAdapter = new ClaudeCodeAdapter(eventBus);
    (claudeAdapter as any).sessionContext.set('test-session-1', { missionId: 'm-1', taskId: 't-1' });
    const claudeLines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Analyzing repository structure' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ReadFile', input: { path: 'package.json' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ReadFile', content: '{ "name": "app" }', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Analyzed package.json successfully.' }] } }),
      JSON.stringify({ type: 'result', is_error: true, result: 'Token quota warning' }),
    ];
    for (const line of claudeLines) (claudeAdapter as any).handleStreamLine('test-session-1', line);
    const claudeTypes = emittedEvents.map((e) => e.type);
    assert(claudeTypes.includes('agent_thought'), 'ClaudeCodeAdapter normalizes thinking blocks into agent_thought');
    assert(claudeTypes.includes('tool_call_started'), 'ClaudeCodeAdapter normalizes tool_use into tool_call_started');
    assert(claudeTypes.includes('tool_call_completed'), 'ClaudeCodeAdapter normalizes tool_result into tool_call_completed');
    assert(claudeTypes.includes('text_delta'), 'ClaudeCodeAdapter normalizes assistant text into text_delta');
    assert(claudeTypes.includes('task_failed'), 'ClaudeCodeAdapter normalizes terminal error results into task_failed');

    emittedEvents.length = 0;
    const antigravityAdapter = new AntigravityAdapter(eventBus);
    const antigravityContext = { missionId: 'm-1', taskId: 't-2' };
    (antigravityAdapter as any).sessionContext.set('test-session-2', antigravityContext);
    const antigravityLines = [
      JSON.stringify({ type: 'step_update', step_type: 'thought', text: 'Planning execution strategy' }),
      JSON.stringify({ type: 'step_update', step_type: 'tool', tool_name: 'RunBuild', args: { command: 'npm run build' } }),
      JSON.stringify({ type: 'step_update', step_type: 'progress', text: 'Build is running' }),
      JSON.stringify({ type: 'result', success: false, error: 'Antigravity quota limit hit' }),
    ];
    for (const line of antigravityLines) (antigravityAdapter as any).handleStreamLine('test-session-2', line);
    const antigravityTypesBeforeClose = emittedEvents.map((e) => e.type);
    const pendingOutcome = (antigravityAdapter as any).pendingTerminalBySession.get('test-session-2');
    assert(antigravityTypesBeforeClose.includes('agent_thought'), 'AntigravityAdapter normalizes thought steps into agent_thought');
    assert(antigravityTypesBeforeClose.includes('agent_tool_call'), 'AntigravityAdapter normalizes tool steps into agent_tool_call');
    assert(antigravityTypesBeforeClose.includes('text_delta'), 'AntigravityAdapter normalizes progress text into text_delta');
    assert(!antigravityTypesBeforeClose.includes('task_failed') && pendingOutcome?.kind === 'failed', 'AntigravityAdapter defers terminal failure until native session cleanup');

    (antigravityAdapter as any).emitTerminalOutcome('test-session-2', antigravityContext, pendingOutcome);
    assert(emittedEvents.some((event) => event.type === 'task_failed'), 'AntigravityAdapter emits task_failed after close-phase cleanup');
  }

  console.log(`\nRuntimeHost & Adapters Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('RuntimeHost test execution error:', err);
  process.exit(1);
});