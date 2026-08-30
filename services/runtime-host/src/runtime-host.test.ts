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
import { isReadOnlyAgentRole } from './adapters/base-adapter';
import { RuntimeHost } from './runtime-host';

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

  // Read-only roles must remain read-only across every CLI adapter.
  {
    assert(isReadOnlyAgentRole('qa'), 'QA is classified as a read-only runtime role');
    assert(isReadOnlyAgentRole('reviewer'), 'Reviewer is classified as a read-only runtime role');
    assert(!isReadOnlyAgentRole('builder'), 'Builder retains write-capable runtime mode');
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
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu-read-file-1', name: 'ReadFile', input: { path: 'package.json' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-read-file-1', content: '{ "name": "app" }', is_error: false }] } }),
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
    const claudeStarted = emittedEvents.find((event) => event.type === 'tool_call_started') as any;
    const claudeCompleted = emittedEvents.find((event) => event.type === 'tool_call_completed') as any;
    assert(claudeStarted?.toolCallId === 'toolu-read-file-1' && claudeStarted.toolName === 'ReadFile', 'Claude preserves tool_use id without replacing the visible tool name');
    assert(claudeCompleted?.toolCallId === 'toolu-read-file-1' && claudeCompleted.toolName === 'ReadFile', 'Claude matches tool_result by tool_use_id and keeps the start tool name');

    emittedEvents.length = 0;
    const codexAdapter = new CodexAdapter(eventBus);
    const codexContext = { missionId: 'm-1', taskId: 't-codex' };
    (codexAdapter as any).sessionContext.set('test-codex-session', codexContext);
    (codexAdapter as any).handleJsonLine('test-codex-session', JSON.stringify({ type: 'item.started', run_id: 'codex-run-1', attempt_id: 'codex-attempt-1', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' } }));
    (codexAdapter as any).handleJsonLine('test-codex-session', JSON.stringify({ type: 'item.completed', run_id: 'codex-run-1', attempt_id: 'codex-attempt-1', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 } }));
    (codexAdapter as any).handleJsonLine('test-codex-session', JSON.stringify({ type: 'item.started', item: { id: 'mcp-1', type: 'mcp_tool_call', tool: 'search', arguments: { query: 'tool ids' } } }));
    (codexAdapter as any).handleJsonLine('test-codex-session', JSON.stringify({ type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call', tool: 'search', result: { hits: 1 } } }));
    (codexAdapter as any).handleJsonLine('test-codex-session', JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'echo fallback' } }));
    (codexAdapter as any).handleJsonLine('test-codex-session', JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'echo fallback', aggregated_output: 'fallback', exit_code: 0 } }));
    const codexToolEvents = emittedEvents.filter((event) => event.type === 'tool_call_started' || event.type === 'tool_call_completed') as any[];
    const codexCommandEvents = codexToolEvents.filter((event) => event.toolName === 'shell');
    const codexMcpEvents = codexToolEvents.filter((event) => event.toolName === 'search');
    assert(codexCommandEvents[0]?.toolCallId === 'cmd-1' && codexCommandEvents[1]?.toolCallId === 'cmd-1', 'Codex preserves command item id across start and completion');
    assert(codexCommandEvents[0]?.runId === 'codex-run-1' && codexCommandEvents[0]?.attemptId === 'codex-attempt-1', 'Codex preserves run and attempt ids when provided');
    assert(codexMcpEvents[0]?.toolCallId === 'mcp-1' && codexMcpEvents[1]?.toolCallId === 'mcp-1', 'Codex preserves MCP item id across start and completion');
    assert(codexCommandEvents[2]?.toolCallId && codexCommandEvents[3]?.toolCallId && codexCommandEvents[2].toolCallId !== codexCommandEvents[3].toolCallId, 'Codex fallback ids are deterministic event keys and do not fabricate a cross-event match');
    (codexAdapter as any).handleJsonLine('test-codex-session', JSON.stringify({ type: 'turn.completed' }));
    (codexAdapter as any).handleJsonLine('test-codex-session', JSON.stringify({ type: 'turn.failed', error: { message: 'late duplicate' } }));
    assert(emittedEvents.filter((event) => event.type === 'task_completed').length === 1, 'CodexAdapter emits one terminal event when completed and failed signals race');

    emittedEvents.length = 0;
    const openCodeAdapter = new OpenCodeAdapter(eventBus);
    (openCodeAdapter as any).sessionContext.set('test-opencode-session', {
      missionId: 'm-1',
      taskId: 't-opencode',
      serverKey: '',
      runtimeSessionId: 'opencode-runtime-session',
    });
    (openCodeAdapter as any).handleServerEvent('test-opencode-session', {
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-runtime-session',
        part: { id: 'part-tool-1', type: 'tool', tool: 'ReadFile', state: { status: 'running', input: { path: 'README.md' } } },
      },
    });
    (openCodeAdapter as any).handleServerEvent('test-opencode-session', {
      type: 'message.part.updated',
      properties: {
        sessionID: 'opencode-runtime-session',
        part: { id: 'part-tool-1', type: 'tool', tool: 'ReadFile', state: { status: 'completed', output: 'ok' } },
      },
    });
    const openCodeToolEvents = emittedEvents.filter((event) => event.type === 'tool_call_started' || event.type === 'tool_call_completed') as any[];
    assert(openCodeToolEvents[0]?.toolCallId === 'part-tool-1' && openCodeToolEvents[1]?.toolCallId === 'part-tool-1', 'OpenCode preserves part id across tool start and completion');

    emittedEvents.length = 0;
    (codexAdapter as any).sessionContext.set('cancelled-codex-session', { missionId: 'm-1', taskId: 't-cancelled-codex' });
    (codexAdapter as any).activeProcesses.set('cancelled-codex-session', {
      killed: false,
      kill() { this.killed = true; return true; },
    });
    await codexAdapter.cancel('cancelled-codex-session');
    (codexAdapter as any).handleJsonLine('cancelled-codex-session', JSON.stringify({ type: 'turn.completed' }));
    assert(!emittedEvents.some((event) => event.type === 'task_completed' || event.type === 'task_failed'), 'CodexAdapter suppresses buffered terminal events after cancellation');

    emittedEvents.length = 0;
    const antigravityAdapter = new AntigravityAdapter(eventBus);
    const antigravityContext = { missionId: 'm-1', taskId: 't-2' };
    let failedStdinEnded = false;
    (antigravityAdapter as any).sessionContext.set('test-session-2', antigravityContext);
    (antigravityAdapter as any).activeProcesses.set('test-session-2', {
      stdin: {
        destroyed: false,
        writableEnded: false,
        end() { failedStdinEnded = true; this.writableEnded = true; },
      },
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() { this.killed = true; return true; },
    });
    const antigravityLines = [
      JSON.stringify({ type: 'step_update', step_type: 'thought', text: 'Planning execution strategy' }),
      JSON.stringify({ type: 'step_update', step_id: 'agy-step-1', run_id: 'agy-run-1', step_type: 'tool', tool_name: 'RunBuild', args: { command: 'npm run build' } }),
      JSON.stringify({ type: 'step_update', step_type: 'progress', text: 'Build is running' }),
      JSON.stringify({ type: 'step_update', step_type: 'agent_response', state: 'DONE', text: 'Intermediate agent response' }),
    ];
    for (const line of antigravityLines) (antigravityAdapter as any).handleStreamLine('test-session-2', line);
    assert(!(antigravityAdapter as any).pendingTerminalBySession.has('test-session-2'), 'Antigravity agent_response DONE remains non-terminal during the quiet grace window');
    assert((antigravityAdapter as any).softTerminalTimers.has('test-session-2'), 'Antigravity DONE response arms a bounded fallback instead of completing immediately');

    (antigravityAdapter as any).handleStreamLine('test-session-2', JSON.stringify({ type: 'result', success: false, error: 'Antigravity quota limit hit' }));
    const antigravityTypesBeforeClose = emittedEvents.map((e) => e.type);
    const pendingOutcome = (antigravityAdapter as any).pendingTerminalBySession.get('test-session-2');
    assert(antigravityTypesBeforeClose.includes('agent_thought'), 'AntigravityAdapter normalizes thought steps into agent_thought');
    assert(antigravityTypesBeforeClose.includes('agent_tool_call'), 'AntigravityAdapter normalizes tool steps into agent_tool_call');
    assert(antigravityTypesBeforeClose.includes('text_delta'), 'AntigravityAdapter normalizes progress text into text_delta');
    const antigravityTool = emittedEvents.find((event) => event.type === 'agent_tool_call') as any;
    assert(antigravityTool?.toolCallId === 'agy-step-1' && antigravityTool?.runId === 'agy-run-1', 'Antigravity preserves available step and run ids');
    assert(!antigravityTypesBeforeClose.includes('tool_call_completed'), 'Antigravity does not invent a tool completion event without one in the stream');
    assert(!(antigravityAdapter as any).softTerminalTimers.has('test-session-2'), 'Authoritative result cancels the soft completion fallback');
    assert(failedStdinEnded, 'AntigravityAdapter closes print-mode stdin as soon as a terminal result is received');
    assert(!antigravityTypesBeforeClose.includes('task_failed') && pendingOutcome?.kind === 'failed', 'AntigravityAdapter defers terminal failure until native session cleanup');
    (antigravityAdapter as any).activeProcesses.delete('test-session-2');

    (antigravityAdapter as any).emitTerminalOutcome('test-session-2', antigravityContext, pendingOutcome);
    assert(emittedEvents.some((event) => event.type === 'task_failed'), 'AntigravityAdapter emits task_failed after close-phase cleanup');

    emittedEvents.length = 0;
    const successContext = { missionId: 'm-2', taskId: 'research-task' };
    let successStdinEnded = false;
    (antigravityAdapter as any).sessionContext.set('test-session-3', successContext);
    (antigravityAdapter as any).activeProcesses.set('test-session-3', {
      stdin: {
        destroyed: false,
        writableEnded: false,
        end() { successStdinEnded = true; this.writableEnded = true; },
      },
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() { this.killed = true; return true; },
    });
    (antigravityAdapter as any).handleStreamLine('test-session-3', JSON.stringify({
      type: 'result',
      success: true,
      status: 'SUCCESS',
      response: 'Research complete',
    }));
    const successPendingOutcome = (antigravityAdapter as any).pendingTerminalBySession.get('test-session-3');
    assert(successStdinEnded, 'AntigravityAdapter starts native shutdown after a successful terminal result');
    assert(successPendingOutcome?.kind === 'completed', 'AntigravityAdapter records a successful terminal result for close-phase handoff');
    assert(!emittedEvents.some((event) => event.type === 'task_completed'), 'AntigravityAdapter still waits for native cleanup before publishing task_completed');
    (antigravityAdapter as any).activeProcesses.delete('test-session-3');

    (antigravityAdapter as any).emitTerminalOutcome('test-session-3', successContext, successPendingOutcome);
    assert(emittedEvents.some((event) => event.type === 'task_completed'), 'AntigravityAdapter publishes task_completed after native cleanup so Orchestrator can schedule the next DAG task');

    emittedEvents.length = 0;
    const cancelledAntigravityContext = { missionId: 'm-cancelled', taskId: 'cancelled-antigravity-task' };
    (antigravityAdapter as any).sessionContext.set('cancelled-antigravity-session', cancelledAntigravityContext);
    (antigravityAdapter as any).markSessionCancelled('cancelled-antigravity-session');
    (antigravityAdapter as any).emitTerminalOutcome('cancelled-antigravity-session', cancelledAntigravityContext, { kind: 'completed', result: 'late result' });
    assert(!emittedEvents.some((event) => event.type === 'task_completed' || event.type === 'task_failed'), 'AntigravityAdapter suppresses terminal outcomes after cancellation');

    emittedEvents.length = 0;
    const cleanExitContext = { missionId: 'm-3', taskId: 'research-clean-exit' };
    (antigravityAdapter as any).sessionContext.set('test-session-4', cleanExitContext);
    (antigravityAdapter as any).handleStreamLine('test-session-4', JSON.stringify({
      type: 'step_update',
      step_type: 'agent_response',
      state: 'DONE',
      text: 'Final research report without a result envelope',
    }));
    assert(!(antigravityAdapter as any).pendingTerminalBySession.has('test-session-4'), 'Antigravity final agent_response is not promoted before the quiet grace expires');

    (antigravityAdapter as any).recordProcessTerminationOutcome('test-session-4', 0, null);
    const cleanExitOutcome = (antigravityAdapter as any).pendingTerminalBySession.get('test-session-4');
    assert(cleanExitOutcome?.kind === 'completed', 'Antigravity clean native exit becomes a successful task outcome even when stream-json omits result');
    assert(cleanExitOutcome?.result === 'Final research report without a result envelope', 'Antigravity clean-exit completion preserves the latest agent response as task result');
    assert(!(antigravityAdapter as any).softTerminalTimers.has('test-session-4'), 'Native exit cancels the pending soft completion timer');
    assert(!emittedEvents.some((event) => event.type === 'task_completed'), 'Clean process exit still defers task_completed until runtime cleanup finishes');

    (antigravityAdapter as any).emitTerminalOutcome('test-session-4', cleanExitContext, cleanExitOutcome);
    assert(emittedEvents.some((event) => event.type === 'task_completed' && (event as any).taskId === 'research-clean-exit'), 'Clean Antigravity exit publishes task_completed so the mission DAG can dispatch Task 2');

    emittedEvents.length = 0;
    const quietContext = { missionId: 'm-4', taskId: 'research-stuck-after-final-response' };
    let quietStdinEnded = false;
    (antigravityAdapter as any).sessionContext.set('test-session-5', quietContext);
    (antigravityAdapter as any).activeProcesses.set('test-session-5', {
      stdin: {
        destroyed: false,
        writableEnded: false,
        end() { quietStdinEnded = true; this.writableEnded = true; },
      },
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() { this.killed = true; return true; },
    });
    (antigravityAdapter as any).handleStreamLine('test-session-5', JSON.stringify({
      type: 'step_update',
      step_type: 'agent_response',
      state: 'DONE',
      text: 'Quiet final research report',
    }));
    assert((antigravityAdapter as any).softTerminalTimers.has('test-session-5'), 'A final Antigravity response arms the missing-result watchdog');
    (antigravityAdapter as any).promoteSoftTerminalCandidate('test-session-5', 'Quiet final research report');
    const quietOutcome = (antigravityAdapter as any).pendingTerminalBySession.get('test-session-5');
    assert(quietOutcome?.kind === 'completed', 'Quiet final response is promoted when agy omits terminal result and stays alive');
    assert(quietOutcome?.result === 'Quiet final research report', 'Soft completion preserves the visible final agent response');
    assert(quietStdinEnded, 'Soft completion starts deterministic Antigravity process shutdown');
    (antigravityAdapter as any).activeProcesses.delete('test-session-5');
    (antigravityAdapter as any).emitTerminalOutcome('test-session-5', quietContext, quietOutcome);
    assert(emittedEvents.some((event) => event.type === 'task_completed' && (event as any).taskId === 'research-stuck-after-final-response'), 'Missing-result fallback ultimately publishes task_completed for Task 2 scheduling');

    const followOnContext = { missionId: 'm-5', taskId: 'research-follow-on-tool' };
    (antigravityAdapter as any).sessionContext.set('test-session-6', followOnContext);
    (antigravityAdapter as any).activeProcesses.set('test-session-6', {
      stdin: { destroyed: false, writableEnded: false, end() { this.writableEnded = true; } },
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() { this.killed = true; return true; },
    });
    (antigravityAdapter as any).handleStreamLine('test-session-6', JSON.stringify({
      type: 'step_update',
      step_type: 'agent_response',
      state: 'DONE',
      text: 'Interim answer before another tool',
    }));
    assert((antigravityAdapter as any).softTerminalTimers.has('test-session-6'), 'Interim DONE response initially creates a soft candidate');
    (antigravityAdapter as any).handleStreamLine('test-session-6', JSON.stringify({
      type: 'step_update',
      step_type: 'tool',
      tool_name: 'InspectFile',
      args: { path: 'src/index.ts' },
    }));
    assert(!(antigravityAdapter as any).softTerminalTimers.has('test-session-6'), 'A subsequent Antigravity step cancels the soft completion candidate');
    assert(!(antigravityAdapter as any).pendingTerminalBySession.has('test-session-6'), 'Follow-on tool activity cannot be prematurely completed by an earlier DONE response');
    (antigravityAdapter as any).activeProcesses.delete('test-session-6');

    const unknownAfterDoneContext = { missionId: 'm-6', taskId: 'research-unknown-after-done' };
    let unknownStdinEnded = false;
    (antigravityAdapter as any).sessionContext.set('test-session-7', unknownAfterDoneContext);
    (antigravityAdapter as any).activeProcesses.set('test-session-7', {
      stdin: {
        destroyed: false,
        writableEnded: false,
        end() { unknownStdinEnded = true; this.writableEnded = true; },
      },
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() { this.killed = true; return true; },
    });
    (antigravityAdapter as any).handleStreamLine('test-session-7', JSON.stringify({
      type: 'step_update',
      step_type: 'agent_response',
      state: 'DONE',
      text: 'Final answer before an unknown event',
    }));
    assert((antigravityAdapter as any).softTerminalTimers.has('test-session-7'), 'Unknown-event regression starts with a pending DONE soft candidate');
    (antigravityAdapter as any).handleStreamLine('test-session-7', JSON.stringify({ type: 'checkpoint' }));
    assert((antigravityAdapter as any).softTerminalTimers.has('test-session-7'), 'An unknown Antigravity event re-arms the bounded DONE fallback');
    assert(!(antigravityAdapter as any).pendingTerminalBySession.has('test-session-7'), 'An unknown Antigravity event does not complete the task immediately');
    const unknownCandidateResult = (antigravityAdapter as any).softTerminalResultsBySession.get('test-session-7');
    assert(unknownCandidateResult === 'Final answer before an unknown event', 'Unknown-event fallback retains the original DONE result');
    (antigravityAdapter as any).promoteSoftTerminalCandidate('test-session-7', unknownCandidateResult);
    const unknownOutcome = (antigravityAdapter as any).pendingTerminalBySession.get('test-session-7');
    assert(unknownOutcome?.kind === 'completed' && unknownOutcome.result === 'Final answer before an unknown event', 'Unknown-event fallback eventually completes with the retained result');
    assert(unknownStdinEnded, 'Unknown-event fallback starts deterministic Antigravity process shutdown');
    (antigravityAdapter as any).activeProcesses.delete('test-session-7');

    const malformedAfterDoneContext = { missionId: 'm-6', taskId: 'research-malformed-after-done' };
    let malformedStdinEnded = false;
    (antigravityAdapter as any).sessionContext.set('test-session-8', malformedAfterDoneContext);
    (antigravityAdapter as any).activeProcesses.set('test-session-8', {
      stdin: {
        destroyed: false,
        writableEnded: false,
        end() { malformedStdinEnded = true; this.writableEnded = true; },
      },
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() { this.killed = true; return true; },
    });
    (antigravityAdapter as any).handleStreamLine('test-session-8', JSON.stringify({
      type: 'step_update',
      step_type: 'agent_response',
      state: 'DONE',
      text: 'Final answer before a malformed event',
    }));
    assert((antigravityAdapter as any).softTerminalTimers.has('test-session-8'), 'Malformed-event regression starts with a pending DONE soft candidate');
    (antigravityAdapter as any).handleStreamLine('test-session-8', 'not-json');
    assert((antigravityAdapter as any).softTerminalTimers.has('test-session-8'), 'A malformed Antigravity event re-arms the bounded DONE fallback');
    assert(!(antigravityAdapter as any).pendingTerminalBySession.has('test-session-8'), 'A malformed Antigravity event does not complete the task immediately');
    const malformedCandidateResult = (antigravityAdapter as any).softTerminalResultsBySession.get('test-session-8');
    assert(malformedCandidateResult === 'Final answer before a malformed event', 'Malformed-event fallback retains the original DONE result');
    (antigravityAdapter as any).promoteSoftTerminalCandidate('test-session-8', malformedCandidateResult);
    const malformedOutcome = (antigravityAdapter as any).pendingTerminalBySession.get('test-session-8');
    assert(malformedOutcome?.kind === 'completed' && malformedOutcome.result === 'Final answer before a malformed event', 'Malformed-event fallback eventually completes with the retained result');
    assert(malformedStdinEnded, 'Malformed-event fallback starts deterministic Antigravity process shutdown');
    (antigravityAdapter as any).activeProcesses.delete('test-session-8');

    const malformedResultContext = { missionId: 'm-6', taskId: 'research-malformed-result' };
    let malformedResultStdinEnded = false;
    (antigravityAdapter as any).sessionContext.set('test-session-9', malformedResultContext);
    (antigravityAdapter as any).activeProcesses.set('test-session-9', {
      stdin: {
        destroyed: false,
        writableEnded: false,
        end() { malformedResultStdinEnded = true; this.writableEnded = true; },
      },
      exitCode: null,
      signalCode: null,
      killed: false,
      kill() { this.killed = true; return true; },
    });
    (antigravityAdapter as any).handleStreamLine('test-session-9', JSON.stringify({
      type: 'step_update',
      step_type: 'agent_response',
      state: 'DONE',
      text: 'Final answer before a malformed result',
    }));
    (antigravityAdapter as any).handleStreamLine('test-session-9', JSON.stringify({
      type: 'result',
      result: { response: 'Result without authoritative success' },
    }));
    assert((antigravityAdapter as any).softTerminalTimers.has('test-session-9'), 'A malformed result re-arms the bounded DONE fallback');
    assert(!(antigravityAdapter as any).pendingTerminalBySession.has('test-session-9'), 'A malformed result does not complete the task immediately');
    const malformedResultCandidate = (antigravityAdapter as any).softTerminalResultsBySession.get('test-session-9');
    (antigravityAdapter as any).promoteSoftTerminalCandidate('test-session-9', malformedResultCandidate);
    const malformedResultOutcome = (antigravityAdapter as any).pendingTerminalBySession.get('test-session-9');
    assert(malformedResultOutcome?.kind === 'completed' && malformedResultOutcome.result === 'Final answer before a malformed result', 'Malformed result fallback eventually preserves the DONE result');
    assert(malformedResultStdinEnded, 'Malformed result fallback starts deterministic Antigravity process shutdown');
    (antigravityAdapter as any).activeProcesses.delete('test-session-9');

    const cancelCleanupSession = 'cancel-cleanup-session';
    let cancelCleanupKilled = false;
    (antigravityAdapter as any).sessionContext.set(cancelCleanupSession, { missionId: 'm-7', taskId: 'cancel-cleanup' });
    (antigravityAdapter as any).activeProcesses.set(cancelCleanupSession, {
      killed: false,
      kill() { cancelCleanupKilled = true; this.killed = true; return true; },
    });
    (antigravityAdapter as any).handleStreamLine(cancelCleanupSession, JSON.stringify({
      type: 'step_update',
      step_type: 'agent_response',
      state: 'DONE',
      text: 'Cancelled candidate',
    }));
    (antigravityAdapter as any).scheduleTerminalRelease(cancelCleanupSession);
    (antigravityAdapter as any).terminalSessions.add(cancelCleanupSession);
    (antigravityAdapter as any).publishedTerminalSessions.add(cancelCleanupSession);
    (antigravityAdapter as any).pendingTerminalBySession.set(cancelCleanupSession, { kind: 'completed', result: 'late' });
    (antigravityAdapter as any).stdoutBuffers.set(cancelCleanupSession, 'stdout');
    (antigravityAdapter as any).stderrBuffers.set(cancelCleanupSession, 'stderr');
    await antigravityAdapter.cancel(cancelCleanupSession);
    assert(cancelCleanupKilled, 'Antigravity cancel terminates the native process');
    assert(!(antigravityAdapter as any).activeProcesses.has(cancelCleanupSession), 'Antigravity cancel removes the native process reference');
    assert(!(antigravityAdapter as any).sessionContext.has(cancelCleanupSession), 'Antigravity cancel removes session context');
    assert(!(antigravityAdapter as any).softTerminalTimers.has(cancelCleanupSession) && !(antigravityAdapter as any).softTerminalResultsBySession.has(cancelCleanupSession), 'Antigravity cancel clears soft-terminal timers and results');
    assert(!(antigravityAdapter as any).terminalReleaseTimers.has(cancelCleanupSession) && !(antigravityAdapter as any).pendingTerminalBySession.has(cancelCleanupSession), 'Antigravity cancel clears terminal release and pending outcome state');

    const shutdownCleanupSession = 'shutdown-cleanup-session';
    let shutdownCleanupKilled = false;
    (antigravityAdapter as any).sessionContext.set(shutdownCleanupSession, { missionId: 'm-7', taskId: 'shutdown-cleanup' });
    (antigravityAdapter as any).activeProcesses.set(shutdownCleanupSession, {
      killed: false,
      kill() { shutdownCleanupKilled = true; this.killed = true; return true; },
    });
    (antigravityAdapter as any).handleStreamLine(shutdownCleanupSession, JSON.stringify({
      type: 'step_update',
      step_type: 'agent_response',
      state: 'DONE',
      text: 'Shutdown candidate',
    }));
    (antigravityAdapter as any).scheduleTerminalRelease(shutdownCleanupSession);
    await antigravityAdapter.shutdown();
    assert(shutdownCleanupKilled, 'Antigravity shutdown terminates active native processes');
    assert(
      (antigravityAdapter as any).activeProcesses.size === 0
        && (antigravityAdapter as any).activeSessions.size === 0
        && (antigravityAdapter as any).sessionContext.size === 0
        && (antigravityAdapter as any).terminalSessions.size === 0
        && (antigravityAdapter as any).publishedTerminalSessions.size === 0
        && (antigravityAdapter as any).pendingTerminalBySession.size === 0
        && (antigravityAdapter as any).lastOutputBySession.size === 0
        && (antigravityAdapter as any).softTerminalTimers.size === 0
        && (antigravityAdapter as any).softTerminalResultsBySession.size === 0
        && (antigravityAdapter as any).terminalReleaseTimers.size === 0
        && (antigravityAdapter as any).stdoutBuffers.size === 0
        && (antigravityAdapter as any).stderrBuffers.size === 0,
      'Antigravity shutdown clears session maps and timers',
    );
  }

  // Persisted leases, not the in-memory session map, fence timeout delivery.
  {
    const eventBus = new LocalEventBus();
    const failures: AgentEvent[] = [];
    eventBus.on('task_failed', (event) => { failures.push(event); });
    const staleAttempt = {
      id: 'attempt-stale', taskId: 'task-stale', missionId: 'mission-stale',
      agentInstanceId: 'agent-stale', runtimeSessionId: 'session-stale',
      error: 'Runtime session lease expired before completion was confirmed',
    };
    let expiryCalls = 0;
    const manager: any = {
      async expireStaleTaskAttempts() {
        expiryCalls += 1;
        return expiryCalls === 1 ? [staleAttempt] : [];
      },
    };
    const host = new RuntimeHost(eventBus, { workspaceManager: manager, sessionTimeout: 100, watchdogInterval: 0 });
    const first = await host.runSessionWatchdog(new Date('2026-01-01T00:00:00.000Z'));
    const second = await host.runSessionWatchdog(new Date('2026-01-01T00:00:01.000Z'));
    assert(first === 1 && second === 0, 'watchdog expires a persisted stale attempt exactly once');
    assert(failures.length === 1 && (failures[0] as any).taskId === 'task-stale', 'watchdog emits one correlated terminal task failure');
    await host.stopAll();
  }

  {
    const manager: any = {
      async expireOrphanedTaskAttempts(completedAt: string) {
        return completedAt === '2026-01-02T00:00:00.000Z'
          ? [{ id: 'orphan', runtimeSessionId: 'lost-session' }]
          : [];
      },
    };
    const host = new RuntimeHost(undefined, { workspaceManager: manager, watchdogInterval: 0 });
    assert(await host.reconcileStartup(new Date('2026-01-02T00:00:00.000Z')) === 1, 'startup reconciliation deterministically expires persisted orphan attempts');
    await host.stopAll();
  }

  console.log(`\nRuntimeHost & Adapters Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('RuntimeHost test execution error:', err);
  process.exit(1);
});
