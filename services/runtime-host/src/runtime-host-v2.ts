import {
  LocalEventBus,
  redactSensitiveValue,
  registerSupervisorTurnRunner,
  unregisterSupervisorTurnRunner,
  type SupervisorTurnRuntimeRequest,
  type SupervisorTurnRunner,
  type Unsubscribe,
} from '@atris-agent-code/event-bus';
import type {
  CanonicalReasoning,
  EffectiveRoutingPreference,
  RuntimeType,
  WorkerRequest,
} from '@atris-agent-code/domain';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import {
  RuntimeHost as LegacyRuntimeHost,
  type MissionRoutingPreference,
  type RuntimeHostConfig,
} from './runtime-host';
import { Scheduler } from './scheduler';
import { BaseRuntimeAdapter } from './adapters/base-adapter';
import { CodexAdapter } from './adapters/codex-adapter';
import { ClaudeCodeAdapter } from './adapters/claude-code-adapter';
import { AntigravityAdapter } from './adapters/antigravity-adapter';
import { OpenCodeAdapter } from './adapters/opencode-adapter';

const SUPERVISOR_TIMEOUT_MS = 180_000;
const ADAPTER_IDS: RuntimeType[] = ['codex', 'claude_code', 'antigravity', 'opencode'];
const MAX_PROCESS_DELTA_CHARS = 8_000;
const MAX_PROCESS_RESULT_CHARS = 16_000;

function boundedObservationText(value: unknown, maxChars: number): string {
  const safe = String(redactSensitiveValue(String(value ?? '')));
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}\n[truncated]` : safe;
}

/**
 * Phase 2 runtime host.
 *
 * Normal worker execution continues through RuntimeHost. The V2 wrapper adds a
 * provider-independent, isolated one-shot execution lane for the persistent
 * Orchestrator. The lane deliberately uses a private LocalEventBus so supervisor
 * planning/decision events never impersonate mission task lifecycle events.
 */
export class RuntimeHostV2 extends LegacyRuntimeHost {
  private readonly v2WorkspaceManager?: WorkspaceManager;
  private readonly v2WorkspacePath: string;
  private readonly supervisorRouting = new Map<string, MissionRoutingPreference>();
  private readonly activeSupervisorTurns = new Map<string, Set<{ adapter: BaseRuntimeAdapter; cancel: () => void }>>();
  private readonly supervisorRunner: SupervisorTurnRunner;
  private observationBus?: LocalEventBus;

  constructor(
    eventBus?: LocalEventBus,
    config: RuntimeHostConfig = {},
    workspaceManager?: WorkspaceManager,
  ) {
    super(eventBus, config, workspaceManager);
    this.v2WorkspaceManager = workspaceManager ?? config.workspaceManager;
    this.v2WorkspacePath = config.workspacePath || process.cwd();
    this.observationBus = eventBus;
    this.supervisorRunner = (request) => this.runSupervisorTurn(request);
    registerSupervisorTurnRunner(this.supervisorRunner);
  }

  override setMissionRoutingPreference(missionId: string, preference: MissionRoutingPreference): void {
    super.setMissionRoutingPreference(missionId, preference);
    const scope = preference.scopeRole || preference.targetRole;
    if (!scope || scope === 'orchestrator' || scope === 'mission') {
      // Keep the conversation's Orchestrator route durable across terminal turns.
      // The legacy runtime clears per-run routing on mission completion, but a
      // conversation-level supervisor should stay on the user's selected model.
      this.supervisorRouting.set(missionId, { ...preference });
    }
  }

  override clearMissionRoutingPreference(missionId: string, preserveSupervisor = true): void {
    // Clear the legacy per-run worker override while intentionally preserving the
    // supervisor route for the next turn in the same conversation.
    super.clearMissionRoutingPreference(missionId);
    if (!preserveSupervisor) this.supervisorRouting.delete(missionId);
  }

  override async stopAll(): Promise<void> {
    unregisterSupervisorTurnRunner(this.supervisorRunner);
    this.supervisorRouting.clear();
    const turns = [...this.activeSupervisorTurns.values()].flatMap((missionTurns) => [...missionTurns]);
    for (const turn of turns) turn.cancel();
    await Promise.all(turns.map((turn) => turn.adapter.shutdown().catch(() => undefined)));
    this.activeSupervisorTurns.clear();
    await super.stopAll();
  }

  override setEventBus(eventBus: LocalEventBus): void {
    super.setEventBus(eventBus);
    this.observationBus = eventBus;
  }

  override async stopMission(missionId: string): Promise<void> {
    const turns = [...(this.activeSupervisorTurns.get(missionId) || [])];
    if (turns.length > 0) {
      for (const turn of turns) turn.cancel();
      await Promise.all(turns.map((turn) => turn.adapter.shutdown().catch(() => undefined)));
      this.activeSupervisorTurns.delete(missionId);
    }
    await super.stopMission(missionId);
  }

  private async resolveSupervisorPreference(missionId: string): Promise<EffectiveRoutingPreference | undefined> {
    const explicit = this.supervisorRouting.get(missionId);
    if (explicit) {
      return {
        modelCatalogId: explicit.modelCatalogId,
        accountProfileId: explicit.accountProfileId,
        reasoningLevel: explicit.reasoningLevel,
        fallbackCatalogIds: explicit.fallbackCatalogIds || [],
        selectionMode: explicit.selectionMode || (explicit.modelCatalogId ? 'fixed' : 'prefer'),
        source: 'explicit',
      };
    }
    return this.v2WorkspaceManager?.resolveRoleExecutionPolicy(missionId, 'orchestrator');
  }

  private createIsolatedAdapter(runtimeType: RuntimeType, eventBus: LocalEventBus): BaseRuntimeAdapter {
    switch (runtimeType) {
      case 'codex': return new CodexAdapter(eventBus);
      case 'claude_code': return new ClaudeCodeAdapter(eventBus);
      case 'antigravity': return new AntigravityAdapter(eventBus);
      case 'opencode': return new OpenCodeAdapter(eventBus);
      default: throw new Error(`Unsupported supervisor runtime '${runtimeType}'.`);
    }
  }

  async runSupervisorTurn(request: SupervisorTurnRuntimeRequest): Promise<string> {
    const preference = await this.resolveSupervisorPreference(request.missionId);
    const mergedPreference: EffectiveRoutingPreference | undefined = request.modelCatalogId
      || request.accountProfileId
      || request.reasoningLevel
      || request.fallbackCatalogIds?.length
      ? {
          modelCatalogId: request.modelCatalogId || preference?.modelCatalogId,
          accountProfileId: request.accountProfileId || preference?.accountProfileId,
          reasoningLevel: (request.reasoningLevel as CanonicalReasoning | undefined) || preference?.reasoningLevel,
          fallbackCatalogIds: request.fallbackCatalogIds || preference?.fallbackCatalogIds || [],
          selectionMode: request.selectionMode || preference?.selectionMode || (request.modelCatalogId ? 'fixed' : 'prefer'),
          source: 'explicit',
        }
      : preference;

    const profileManager = this.getAccountProfileManager();
    const catalog = this.getModelCatalogService();
    const connectedProfiles = (await profileManager.getProfiles()).filter((profile) => profile.authStatus === 'connected');
    const profiles = mergedPreference
      ? connectedProfiles
      : connectedProfiles.filter((profile) => profile.schedulerAuto !== false);

    let models = catalog.getCachedCatalog().filter((model) => profiles.some((profile) => profile.id === model.accountProfileId));
    const requiredCatalogIds = new Set([
      ...(mergedPreference?.modelCatalogId ? [mergedPreference.modelCatalogId] : []),
      ...(mergedPreference?.fallbackCatalogIds || []),
    ]);
    if (models.length === 0 || [...requiredCatalogIds].some((id) => !models.some((model) => model.catalogId === id))) {
      models = await catalog.discoverLiveModels(profiles);
    }

    const workerRequest: WorkerRequest = {
      role: 'orchestrator',
      capabilities: ['planning', 'evaluation', 'delegation', 'conversation'],
      task: request.prompt,
      priority: 'high',
      requiresWorktree: false,
      preferredCatalogId: mergedPreference?.modelCatalogId,
      preferredAccountProfileId: mergedPreference?.accountProfileId,
      preferredReasoning: mergedPreference?.reasoningLevel,
      fallbackCatalogIds: mergedPreference?.fallbackCatalogIds,
      routeSelectionMode: mergedPreference?.selectionMode,
      routingSource: mergedPreference?.source,
    };

    const scheduler = new Scheduler({ availableAdapters: ADAPTER_IDS });
    const route = scheduler.resolveRoute(workerRequest, profiles, models);
    const turnBus = new LocalEventBus();
    const adapter = this.createIsolatedAdapter(route.adapterId as RuntimeType, turnBus);
    if (route.profile) adapter.configureProfile(route.profile);

    const sessionId = `orchestrator-${request.turnId}`;
    const syntheticMissionId = `supervisor-${request.missionId}`;
    const syntheticTaskId = `turn-${request.turnId}`;
    let streamedText = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeDelta: Unsubscribe = () => undefined;
    let unsubscribeCompleted: Unsubscribe = () => undefined;
    let unsubscribeFailed: Unsubscribe = () => undefined;
    let unsubscribeActivity: Unsubscribe = () => undefined;
    let cancelTurn: () => void = () => undefined;
    const processBase = {
      missionId: request.missionId,
      turnId: request.turnId,
      processId: sessionId,
      runtimeSessionId: sessionId,
      role: 'orchestrator',
    } as const;
    const emitObservation = (event: Record<string, unknown>) => {
      this.observationBus?.emit({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ...processBase,
        ...event,
      } as any);
    };

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      unsubscribeDelta();
      unsubscribeCompleted();
      unsubscribeFailed();
      unsubscribeActivity();
      unsubscribeDelta = () => undefined;
      unsubscribeCompleted = () => undefined;
      unsubscribeFailed = () => undefined;
      unsubscribeActivity = () => undefined;
    };

    const resultPromise = new Promise<string>((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      cancelTurn = () => finish(() => reject(new Error('Supervisor turn cancelled.')));
      unsubscribeDelta = turnBus.on('text_delta', (event) => {
        if (event.agentInstanceId !== sessionId) return;
        streamedText += event.content || '';
        emitObservation({ type: 'process_output_delta', content: boundedObservationText(event.content, MAX_PROCESS_DELTA_CHARS) });
      });
      unsubscribeCompleted = turnBus.on('task_completed', (event) => {
        if (event.taskId !== syntheticTaskId) return;
        const output = String(event.result || streamedText || '').trim();
        emitObservation({ type: 'process_completed', summary: boundedObservationText(output, MAX_PROCESS_RESULT_CHARS) });
        finish(() => resolve(output));
      });
      unsubscribeFailed = turnBus.on('task_failed', (event) => {
        if (event.taskId !== syntheticTaskId) return;
        emitObservation({ type: 'process_failed', error: boundedObservationText(event.error || 'Supervisor runtime failed.', MAX_PROCESS_DELTA_CHARS) });
        finish(() => reject(new Error(event.error || 'Supervisor runtime failed.')));
      });
      unsubscribeActivity = turnBus.on('*', (event) => {
        if (!('agentInstanceId' in event) || event.agentInstanceId !== sessionId) return;
        if (event.type === 'tool_call_started') {
          emitObservation({
            type: 'process_tool_started',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
          });
        } else if (event.type === 'tool_call_completed') {
          emitObservation({
            type: 'process_tool_completed',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            success: event.success,
            result: boundedObservationText(event.result, MAX_PROCESS_RESULT_CHARS),
          });
        }
      });
      timeout = setTimeout(() => {
        emitObservation({ type: 'process_failed', error: `Supervisor turn timed out after ${SUPERVISOR_TIMEOUT_MS / 1000}s.` });
        finish(() => reject(new Error(`Supervisor turn timed out after ${SUPERVISOR_TIMEOUT_MS / 1000}s.`)));
      }, SUPERVISOR_TIMEOUT_MS);
    });
    const activeTurn = { adapter, cancel: () => cancelTurn() };
    const missionTurns = this.activeSupervisorTurns.get(request.missionId) || new Set();
    missionTurns.add(activeTurn);
    this.activeSupervisorTurns.set(request.missionId, missionTurns);

    try {
      try {
        emitObservation({ type: 'process_started', model: route.model?.displayName || route.model?.runtimeModelId, phase: 'turn' });
        await adapter.spawnAgent({
          sessionId,
          taskId: syntheticTaskId,
          missionId: syntheticMissionId,
          prompt: request.prompt,
          role: 'orchestrator',
          model: route.model?.runtimeModelId,
          reasoningLevel: route.reasoningLevel,
          profileId: route.profile?.id,
          isolated: false,
          cwd: request.workspacePath || this.v2WorkspacePath,
          enableCoordinationMcp: false,
        });
      } catch (error) {
        settled = true;
        cleanup();
        emitObservation({ type: 'process_failed', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return await resultPromise;
    } finally {
      cleanup();
      const active = this.activeSupervisorTurns.get(request.missionId);
      active?.delete(activeTurn);
      if (active?.size === 0) this.activeSupervisorTurns.delete(request.missionId);
      await adapter.shutdown().catch(() => undefined);
    }
  }
}
