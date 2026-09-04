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
  ModelDescriptor,
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
const DEFAULT_SUPERVISOR_IDLE_TTL_MS = 10 * 60_000;

interface SupervisorSession {
  adapter: BaseRuntimeAdapter;
  adapterId: RuntimeType;
  providerSessionId: string;
  profileId?: string;
  cwd: string;
  busy: boolean;
  lastUsedAt: number;
  evictionTimer?: ReturnType<typeof setTimeout>;
}

function boundedObservationText(value: unknown, maxChars: number): string {
  const safe = String(redactSensitiveValue(String(value ?? '')));
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}\n[truncated]` : safe;
}

function isUnverifiedCatalogRoute(model?: ModelDescriptor): boolean {
  if (!model || model.runtimeModelId === 'antigravity-active-route') return false;
  return model.source === 'cached' || model.availability === 'unknown';
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
  private readonly supervisorSessions = new Map<string, SupervisorSession>();
  private readonly supervisorIdleTtlMs: number;
  private observationBus?: LocalEventBus;

  constructor(
    eventBus?: LocalEventBus,
    config: RuntimeHostConfig = {},
    workspaceManager?: WorkspaceManager,
  ) {
    super(eventBus, config, workspaceManager);
    this.v2WorkspaceManager = workspaceManager ?? config.workspaceManager;
    this.v2WorkspacePath = config.workspacePath || process.cwd();
    this.supervisorIdleTtlMs = Math.max(1, config.supervisorSessionIdleTtl ?? DEFAULT_SUPERVISOR_IDLE_TTL_MS);
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
    const sessions = [...this.supervisorSessions.values()];
    this.supervisorSessions.clear();
    for (const session of sessions) {
      if (session.evictionTimer) clearTimeout(session.evictionTimer);
      await session.adapter.releaseProviderSession(session.providerSessionId).catch(() => undefined);
      await session.adapter.shutdown().catch(() => undefined);
    }
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
    await this.discardSupervisorSession(missionId);
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
    const persisted = await this.v2WorkspaceManager?.getLatestSupervisorSessionMetadata(missionId);
    if (persisted?.route) {
      return {
        modelCatalogId: persisted.route.modelCatalogId || undefined,
        accountProfileId: persisted.route.accountProfileId || undefined,
        reasoningLevel: persisted.route.reasoningLevel || undefined,
        fallbackCatalogIds: [],
        selectionMode: persisted.route.selectionMode,
        source: persisted.route.source,
      };
    }
    return this.v2WorkspaceManager?.resolveRoleExecutionPolicy(missionId, 'orchestrator');
  }

  private async discardSupervisorSession(missionId: string): Promise<void> {
    const session = this.supervisorSessions.get(missionId);
    if (!session) return;
    this.supervisorSessions.delete(missionId);
    if (session.evictionTimer) clearTimeout(session.evictionTimer);
    await session.adapter.releaseProviderSession(session.providerSessionId).catch(() => undefined);
    await session.adapter.shutdown().catch(() => undefined);
  }

  private scheduleSupervisorEviction(missionId: string, session: SupervisorSession): void {
    if (session.evictionTimer) clearTimeout(session.evictionTimer);
    session.evictionTimer = setTimeout(() => {
      if (!session.busy && Date.now() - session.lastUsedAt >= this.supervisorIdleTtlMs) {
        void this.discardSupervisorSession(missionId);
      }
    }, this.supervisorIdleTtlMs);
    session.evictionTimer.unref?.();
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
    const selectedModels = models.filter((model) => requiredCatalogIds.has(model.catalogId));
    if (
      models.length === 0
      || [...requiredCatalogIds].some((id) => !models.some((model) => model.catalogId === id))
      || models.some((model) => model.source === 'cached' || model.availability === 'unknown')
      || selectedModels.some((model) => isUnverifiedCatalogRoute(model))
    ) {
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
    if (isUnverifiedCatalogRoute(route.model)) {
      throw new Error(
        `The selected ${route.model?.displayName || route.model?.runtimeModelId || 'model'} route is not verified by a live runtime catalog. Refresh the connected runtime before starting the supervisor.`,
      );
    }
    const turnBus = new LocalEventBus();
    const cwd = request.workspacePath || this.v2WorkspacePath;
    let continuity = this.supervisorSessions.get(request.missionId);
    let continuityRejected = false;
    if (continuity?.busy) throw new Error('A supervisor turn is already in flight for this conversation.');
    if (continuity && (continuity.adapterId !== route.adapterId || continuity.profileId !== route.profile?.id
      || !(await continuity.adapter.probeProviderSession(continuity.providerSessionId, { profileId: continuity.profileId, cwd: continuity.cwd })))) {
      await this.discardSupervisorSession(request.missionId);
      continuity = undefined;
      continuityRejected = true;
    }
    let adapter = continuity?.adapter || this.createIsolatedAdapter(route.adapterId as RuntimeType, turnBus);
    if (continuity) adapter.setEventBus(turnBus);
    if (route.profile) adapter.configureProfile(route.profile);
    const capabilities = adapter.getSessionContinuityCapabilities();
    if (!continuity && !continuityRejected && capabilities.resumeAfterRestart) {
      const persisted = await this.v2WorkspaceManager?.getLatestSupervisorSessionMetadata(request.missionId);
      if (persisted?.providerSessionId && persisted.resumeCapability === 'restart'
        && persisted.route.adapterId === route.adapterId
        && await adapter.probeProviderSession(persisted.providerSessionId, { profileId: route.profile?.id, cwd })) {
        continuity = {
          adapter, adapterId: route.adapterId as RuntimeType, providerSessionId: persisted.providerSessionId,
          profileId: route.profile?.id, cwd, busy: false, lastUsedAt: Date.now(),
        };
        this.supervisorSessions.set(request.missionId, continuity);
      }
    }
    if (continuity) continuity.busy = true;

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
        const spawned = await adapter.spawnAgent({
          sessionId,
          taskId: syntheticTaskId,
          missionId: syntheticMissionId,
          prompt: request.prompt,
          role: 'orchestrator',
          model: route.model?.runtimeModelId,
          reasoningLevel: route.reasoningLevel,
          profileId: route.profile?.id,
          isolated: false,
          cwd,
          enableCoordinationMcp: false,
          providerSessionId: continuity?.providerSessionId,
          preserveProviderSession: capabilities.reuseWhileAlive,
        });
        if (capabilities.reuseWhileAlive) {
          const reusable = continuity || {
            adapter, adapterId: route.adapterId as RuntimeType, providerSessionId: spawned.runtimeSessionId || spawned.id,
            profileId: route.profile?.id, cwd, busy: true, lastUsedAt: Date.now(),
          };
          this.supervisorSessions.set(request.missionId, reusable);
          continuity = reusable;
          await this.v2WorkspaceManager?.saveSupervisorSessionMetadata(request.turnId, {
            providerSessionId: reusable.providerSessionId,
            resumeCapability: capabilities.resumeAfterRestart ? 'restart' : 'live',
            route: {
              adapterId: route.adapterId, provider: route.profile?.provider, accountProfileId: route.profile?.id,
              modelCatalogId: route.model?.catalogId, runtimeModelId: route.model?.runtimeModelId,
              reasoningLevel: route.reasoningLevel, source: mergedPreference?.source || 'scheduler',
              selectionMode: mergedPreference?.selectionMode || 'auto',
            },
            updatedAt: new Date().toISOString(),
          });
        } else {
          await this.v2WorkspaceManager?.saveSupervisorSessionMetadata(request.turnId, {
            resumeCapability: 'none',
            route: {
              adapterId: route.adapterId, provider: route.profile?.provider, accountProfileId: route.profile?.id,
              modelCatalogId: route.model?.catalogId, runtimeModelId: route.model?.runtimeModelId,
              reasoningLevel: route.reasoningLevel, source: mergedPreference?.source || 'scheduler',
              selectionMode: mergedPreference?.selectionMode || 'auto',
            },
            updatedAt: new Date().toISOString(),
          });
        }
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
      if (continuity) {
        continuity.busy = false;
        continuity.lastUsedAt = Date.now();
        this.scheduleSupervisorEviction(request.missionId, continuity);
      } else {
        await adapter.shutdown().catch(() => undefined);
      }
    }
  }
}
