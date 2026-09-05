import fs from 'fs';
import os from 'os';
import path from 'path';
import type { LocalEventBus, Unsubscribe } from '@atris-agent-code/event-bus';
import type { ApprovalRequested, TaskCompleted, TaskCreated, TaskFailed } from '@atris-agent-code/event-schema';
import type {
  AgentSession,
  AgentProfile,
  AgentProfilePatch,
  AgentProfileResolution,
  AgentProfileRoutePolicy,
  WorkerRequest,
  AgentRole,
  EffectiveAttemptRoute,
  ModelDescriptor,
  AccountProfile,
  StartSessionRequest,
  RuntimeType,
  Provider,
  RuntimeStatus,
  AuthInitiationResult,
  AuthPollResult,
  CanonicalReasoning,
  RouteSelectionMode,
  EffectiveRoutingPreference,
} from '@atris-agent-code/domain';
import {
  defaultAgentProfile,
  mergeAgentProfiles,
  parseAgentProfile,
  resolveAgentProfile,
} from '@atris-agent-code/domain';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import { ActionBroker, type AutomationAction, type TrustProfile } from '@atris-agent-code/policy-engine';
import { BaseRuntimeAdapter } from './adapters/base-adapter';
import { CodexAdapter } from './adapters/codex-adapter';
import { AntigravityAdapter } from './adapters/antigravity-adapter';
import { ClaudeCodeAdapter } from './adapters/claude-code-adapter';
import { OpenCodeAdapter } from './adapters/opencode-adapter';
import { AccountProfileManager } from './account-profile-manager';
import { ModelCatalogService } from './model-catalog-service';
import { Scheduler } from './scheduler';

export interface MissionRoutingPreference {
  modelCatalogId?: string;
  accountProfileId?: string;
  reasoningLevel?: CanonicalReasoning;
  fallbackCatalogIds?: string[];
  selectionMode?: RouteSelectionMode;
  /** Role whose route is overridden without changing the mission DAG. */
  scopeRole?: AgentRole | 'mission';
  /** Backward-compatible direct-agent role used by older callers. */
  targetRole?: AgentRole;
  /** Optional named profile; the persisted core role still controls access. */
  profileId?: string;
  /** Alias accepted by newer clients. */
  agentProfileId?: string;
  profile?: AgentProfile | AgentProfilePatch;
}

export interface AgentDispatchTrace {
  missionId: string;
  taskId: string;
  agentInstanceId: string;
  role: AgentRole;
  /** Canonical named profile identity. */
  agentProfileId: string;
  /** @deprecated Use agentProfileId. */
  profileId: string;
  profileName: string;
  profileSource: AgentProfileResolution['source'];
  route: EffectiveAttemptRoute;
}

export type AgentProfileResolver = (input: {
  missionId: string;
  taskId?: string;
  role: AgentRole;
  agentProfileId?: string;
  profileId?: string;
}) => Promise<AgentProfile | AgentProfilePatch | AgentProfileResolution | null | undefined>
  | AgentProfile | AgentProfilePatch | AgentProfileResolution | null | undefined;

export interface RuntimeHostConfig {
  maxConcurrentSessions?: number;
  sessionTimeout?: number;
  watchdogInterval?: number;
  sessionIdleGrace?: number;
  maxProbeFailures?: number;
  supervisorSessionIdleTtl?: number;
  defaultAdapterId?: string;
  workspacePath?: string;
  workspaceManager?: WorkspaceManager;
  /** Optional named profiles available to all workspaces using this host. */
  agentProfiles?: AgentProfile[];
  /** Global per-role profile defaults; legacy hosts may omit them. */
  agentProfileDefaults?: Partial<Record<AgentRole, AgentProfile | AgentProfilePatch | string>>;
  /** Workspace-scoped profile overrides keyed by workspace ID (or workspaceID:role). */
  workspaceAgentProfileOverrides?: Record<string, AgentProfile | AgentProfilePatch | Record<string, unknown>>;
  /** Optional integration hook for durable dispatch tracing. */
  onAgentDispatch?: (trace: AgentDispatchTrace) => void | Promise<void>;
  /** Optional profile resolver supplied by a persistence layer. */
  resolveAgentProfile?: AgentProfileResolver;
}

interface TaskExecutionAccess {
  role: AgentRole;
  accessMode: 'read-only' | 'workspace-write';
  requiresIsolatedWorktree: boolean;
}

function isUnverifiedCatalogRoute(model?: ModelDescriptor): boolean {
  if (!model || model.runtimeModelId === 'antigravity-active-route') return false;
  return model.source === 'cached' || model.availability === 'unknown';
}

export class RuntimeHost {
  protected config: RuntimeHostConfig;
  private eventBus?: LocalEventBus;
  private workspaceManager?: WorkspaceManager;
  private adapters = new Map<string, BaseRuntimeAdapter>();
  private activeSessions = new Map<string, {
    adapterId: string;
    session: AgentSession;
    missionId?: string;
    taskId?: string;
    accountProfileId?: string;
    agentProfileId?: string;
    profileId?: string;
    profileName?: string;
    profileSource?: AgentProfileResolution['source'];
    route?: EffectiveAttemptRoute;
    queuedAt: number;
    startedAt: number;
    retryCount: number;
    attemptId?: string;
    role?: AgentRole | string;
    lastProtocolResponseAt: number;
    probeFailures: number;
  }>();
  private scheduler: Scheduler;
  private profileManager: AccountProfileManager;
  private catalogService: ModelCatalogService;
  private unsubscribeTaskCreated?: Unsubscribe;
  private unsubscribeRuntimeApproval?: Unsubscribe;
  private unsubscribeMissionTerminal?: Unsubscribe;
  private unsubscribeTaskTerminal?: Unsubscribe;
  private unsubscribeRuntimeActivity?: Unsubscribe;
  private missionRouting = new Map<string, MissionRoutingPreference>();
  private dispatchTraces = new Map<string, AgentDispatchTrace>();
  private watchdog?: ReturnType<typeof setInterval>;
  private watchdogRunning = false;
  private finishingSessions = new Set<string>();
  private pendingRuntimeApprovals = new Map<string, {
    missionId: string;
    taskId?: string;
    agentInstanceId?: string;
    approvalType: string;
    toolName?: string;
    path?: string;
    command?: string;
  }>();

  constructor(eventBus?: LocalEventBus, config: RuntimeHostConfig = {}, workspaceManager?: WorkspaceManager) {
    this.config = config;
    this.eventBus = eventBus;
    this.workspaceManager = workspaceManager ?? config.workspaceManager;
    this.profileManager = new AccountProfileManager();
    this.catalogService = new ModelCatalogService(this.adapters);

    this.registerAdapter(new CodexAdapter(this.eventBus));
    this.registerAdapter(new AntigravityAdapter(this.eventBus));
    this.registerAdapter(new ClaudeCodeAdapter(this.eventBus));
    this.registerAdapter(new OpenCodeAdapter(this.eventBus));
    this.scheduler = new Scheduler({ availableAdapters: [...this.adapters.keys()] });
    if (this.eventBus) this.subscribeToEventBus(this.eventBus);
    const interval = this.config.watchdogInterval ?? Math.min(this.sessionTimeoutMs(), 30_000);
    if (interval > 0) {
      this.watchdog = setInterval(() => { void this.runSessionWatchdog().catch((error) => console.error('[RuntimeHost] watchdog failed:', error)); }, interval);
      this.watchdog.unref?.();
    }
  }

  setEventBus(eventBus: LocalEventBus): void {
    this.unsubscribeToEventBus();
    this.eventBus = eventBus;
    for (const adapter of this.adapters.values()) adapter.setEventBus(eventBus);
    this.subscribeToEventBus(eventBus);
  }

  setWorkspaceManager(manager: WorkspaceManager): void { this.workspaceManager = manager; }

  registerAdapter(adapter: BaseRuntimeAdapter): void {
    if (this.eventBus) adapter.setEventBus(this.eventBus);
    this.adapters.set(adapter.id, adapter);
    this.catalogService.registerAdapter(adapter);
  }

  getAdapter(id: string): BaseRuntimeAdapter | undefined { return this.adapters.get(id); }
  getAccountProfileManager(): AccountProfileManager { return this.profileManager; }
  getModelCatalogService(): ModelCatalogService { return this.catalogService; }

  setMissionRoutingPreference(missionId: string, preference: MissionRoutingPreference): void {
    this.missionRouting.set(missionId, preference);
  }

  setAgentProfiles(profiles: AgentProfile[]): void {
    this.config.agentProfiles = profiles;
  }

  getLastDispatchTrace(missionId: string, taskId: string): AgentDispatchTrace | undefined {
    const trace = this.dispatchTraces.get(`${missionId}:${taskId}`);
    return trace ? { ...trace, route: { ...trace.route } } : undefined;
  }

  clearMissionRoutingPreference(missionId: string, _preserveSupervisor = true): void {
    this.missionRouting.delete(missionId);
  }

  /**
   * Resolve a named profile without allowing it to replace the persisted core
   * role. Persistence layers can provide the optional resolver while legacy
   * callers continue to receive the safe role baseline.
   */
  protected async resolveAgentProfileForDispatch(input: {
    missionId: string;
    taskId?: string;
    role: AgentRole;
    profileId?: string;
    explicitProfile?: unknown;
  }): Promise<AgentProfileResolution> {
    const manager = this.workspaceManager as (WorkspaceManager & {
      resolveAgentProfile?: (...args: any[]) => Promise<unknown> | unknown;
    }) | undefined;
    const explicitProfile = parseAgentProfile(input.explicitProfile, input.role);
    const explicitRecord = input.explicitProfile && typeof input.explicitProfile === 'object' && !Array.isArray(input.explicitProfile)
      ? input.explicitProfile as Record<string, unknown>
      : undefined;
    const explicitProfileId = explicitRecord
      ? String(explicitRecord.id || explicitRecord.profileId || '').trim() || undefined
      : undefined;
    if (input.profileId && explicitProfile && explicitProfileId !== input.profileId) {
      throw new Error(`Inline agent profile does not match requested profile '${input.profileId}' for fixed role '${input.role}'.`);
    }
    let workspaceId: string | undefined;
    if (manager && typeof (manager as any).getMission === 'function') {
      const mission = await manager.getMission(input.missionId);
      workspaceId = mission?.workspaceId;
    }

    const configuredProfiles = this.config.agentProfiles || [];
    const configuredById = input.profileId
      ? configuredProfiles.find((candidate) => candidate.id === input.profileId)
      : undefined;
    // The role id is the stable legacy/default profile and is safe to recover
    // without a named catalog entry. Any other requested id must be found.
    const isRoleBaseline = input.profileId === input.role;
    if (input.profileId && configuredById && configuredById.role !== input.role) {
      throw new Error(`Agent profile '${input.profileId}' is assigned to fixed role '${configuredById.role}', not '${input.role}'.`);
    }
    const configuredDefault = this.config.agentProfileDefaults?.[input.role];
    const templateProfile = typeof configuredDefault === 'string'
      ? configuredProfiles.find((candidate) => candidate.id === configuredDefault)
      : configuredDefault || (!input.profileId ? configuredProfiles.find((candidate) => candidate.role === input.role) : undefined);

    const workspaceOverrides = this.config.workspaceAgentProfileOverrides;
    const workspaceOverride = workspaceId && workspaceOverrides
      ? workspaceOverrides[`${workspaceId}:${input.role}`] || workspaceOverrides[workspaceId]
      : undefined;
    const workspaceCandidate = this.profileCandidateForRole(workspaceOverride, input.role, input.profileId)
      || this.profileCandidateForRole(
        await manager?.resolveAgentProfile?.(input.missionId, input.role, input.taskId, input.profileId),
        input.role,
        input.profileId,
      );

    const resolverCandidate = await this.config.resolveAgentProfile?.({
      missionId: input.missionId,
      taskId: input.taskId,
      role: input.role,
      profileId: input.profileId,
      agentProfileId: input.profileId,
    });
    const resolvedCandidate = this.profileCandidateForRole(resolverCandidate, input.role, input.profileId);
    const requestedCandidate = explicitProfile
      ? { ...explicitProfile, id: explicitProfile.id, role: input.role }
      : input.profileId && !isRoleBaseline
        ? configuredById
        : undefined;

    if (input.profileId && !isRoleBaseline && !configuredById && !workspaceCandidate && !resolvedCandidate && !explicitProfile) {
      throw new Error(`Agent profile '${input.profileId}' was not found for fixed role '${input.role}'.`);
    }

    const resolution = resolveAgentProfile(input.role, {
      teamTemplate: templateProfile as AgentProfile | AgentProfilePatch | undefined,
      workspace: (resolvedCandidate || workspaceCandidate) as AgentProfile | AgentProfilePatch | undefined,
      explicit: requestedCandidate as AgentProfile | AgentProfilePatch | undefined,
      requestedProfileId: input.profileId,
    });
    if (input.profileId && resolution.profile.id !== input.profileId) {
      throw new Error(`Agent profile '${input.profileId}' could not be resolved for fixed role '${input.role}'.`);
    }
    return resolution;
  }

  private profileCandidateForRole(
    value: unknown,
    role: AgentRole,
    requestedProfileId?: string,
  ): AgentProfile | AgentProfilePatch | undefined {
    if (!value) return undefined;
    if (typeof value === 'object' && !Array.isArray(value) && 'profile' in (value as Record<string, unknown>)) {
      const wrapped = value as { profile?: unknown };
      return this.profileCandidateForRole(wrapped.profile, role, requestedProfileId);
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const roleScoped = record[role];
      if (roleScoped) return this.profileCandidateForRole(roleScoped, role, requestedProfileId);
      const defaults = record.profileDefaults;
      if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
        const candidate = (defaults as Record<string, unknown>)[role];
        if (candidate) return this.profileCandidateForRole(candidate, role, requestedProfileId);
      }
      const profiles = [
        ...(Array.isArray(record.agentProfiles) ? record.agentProfiles : []),
        ...(Array.isArray(record.profiles) ? record.profiles : []),
      ];
      if (profiles.length) {
        const selected = (requestedProfileId && profiles.find((candidate) => (candidate as any)?.id === requestedProfileId))
          || profiles.find((candidate) => (candidate as any)?.role === role);
        if (selected) return this.profileCandidateForRole(selected, role, requestedProfileId);
      }
    }
    const parsed = parseAgentProfile(value, role);
    if (!parsed) return undefined;
    if (parsed.role !== role) {
      throw new Error(`Agent profile '${parsed.id}' is assigned to fixed role '${parsed.role}', not '${role}'.`);
    }
    if (requestedProfileId && parsed.id !== requestedProfileId) return undefined;
    return parsed;
  }

  protected profileRoutePolicy(profile: AgentProfile): AgentProfileRoutePolicy | undefined {
    const preferred = profile.routePolicy;
    const allowed = profile.allowedRoutePolicy;
    if (!preferred) return allowed;
    if (!allowed) return preferred;
    const intersect = (left?: string[], right?: string[]): string[] | undefined => {
      if (!left) return right;
      if (!right) return left;
      const rightSet = new Set(right);
      return left.filter((value) => rightSet.has(value));
    };
    return {
      ...preferred,
      ...allowed,
      allowedCatalogIds: intersect(preferred.allowedCatalogIds ?? preferred.allowedModelCatalogIds, allowed.allowedCatalogIds ?? allowed.allowedModelCatalogIds),
      allowedModelCatalogIds: intersect(preferred.allowedModelCatalogIds ?? preferred.allowedCatalogIds, allowed.allowedModelCatalogIds ?? allowed.allowedCatalogIds),
      allowedAccountProfileIds: intersect(preferred.allowedAccountProfileIds, allowed.allowedAccountProfileIds),
      allowedRuntimeTypes: preferred.allowedRuntimeTypes && allowed.allowedRuntimeTypes
        ? preferred.allowedRuntimeTypes.filter((value) => allowed.allowedRuntimeTypes?.includes(value))
        : allowed.allowedRuntimeTypes ?? preferred.allowedRuntimeTypes,
    };
  }

  protected constrainProfileRoutes(
    profile: AgentProfile,
    profiles: AccountProfile[],
    models: ModelDescriptor[],
  ): { profiles: AccountProfile[]; models: ModelDescriptor[] } {
    const policy = this.profileRoutePolicy(profile);
    if (!policy) return { profiles, models };
    const allowedAccounts = policy.allowedAccountProfileIds;
    const allowedRuntimes = policy.allowedRuntimeTypes;
    const catalogAllowlists = [policy.allowedCatalogIds, policy.allowedModelCatalogIds]
      .filter((value): value is string[] => Array.isArray(value));
    const allowedCatalogs = catalogAllowlists.length ? catalogAllowlists : undefined;
    const filteredProfiles = profiles.filter((candidate) => {
      if (allowedAccounts && !allowedAccounts.includes(candidate.id)) return false;
      if (allowedRuntimes && !allowedRuntimes.includes(candidate.runtimeType)) return false;
      return true;
    });
    const accountIds = new Set(filteredProfiles.map((candidate) => candidate.id));
    const filteredModels = models.filter((model) => {
      if (!accountIds.has(model.accountProfileId)) return false;
      if (allowedCatalogs && allowedCatalogs.some((allowlist) => !allowlist.includes(model.catalogId))) return false;
      return true;
    });
    return { profiles: filteredProfiles, models: filteredModels };
  }

  protected profileRoutingPreference(
    profile: AgentProfile,
    source: AgentProfileResolution['source'],
  ): EffectiveRoutingPreference | undefined {
    const policy = profile.routePolicy || profile.allowedRoutePolicy;
    if (!policy || (!policy.modelCatalogId && !policy.accountProfileId && !policy.reasoningLevel && !policy.fallbackCatalogIds?.length)) return undefined;
    const preferenceSource = source === 'workspace' || source === 'team_template' ? source : 'scheduler';
    return {
      modelCatalogId: policy.modelCatalogId,
      accountProfileId: policy.accountProfileId,
      reasoningLevel: policy.reasoningLevel,
      fallbackCatalogIds: [...new Set(policy.fallbackCatalogIds || [])],
      selectionMode: policy.selectionMode || (policy.modelCatalogId ? 'fixed' : 'prefer'),
      source: preferenceSource,
    };
  }

  private async recordAgentDispatch(trace: AgentDispatchTrace): Promise<void> {
    this.dispatchTraces.set(`${trace.missionId}:${trace.taskId}`, trace);
    const manager = this.workspaceManager as (WorkspaceManager & {
      recordAgentDispatch?: (value: AgentDispatchTrace) => Promise<void> | void;
      persistAgentDispatch?: (value: AgentDispatchTrace) => Promise<void> | void;
    }) | undefined;
    const recorder = manager?.recordAgentDispatch || manager?.persistAgentDispatch;
    try {
      await recorder?.call(manager, trace);
      await this.config.onAgentDispatch?.(trace);
    } catch (error) {
      // Dispatch tracing must never make a legacy runtime unavailable. The
      // durable task-attempt route remains the source of truth when a hook is
      // unavailable or temporarily fails.
      console.warn('[RuntimeHost] Agent dispatch trace could not be persisted:', error instanceof Error ? error.message : String(error));
    }
  }

  private subscribeToEventBus(eventBus: LocalEventBus): void {
    this.unsubscribeTaskCreated = eventBus.on('task_created', (event: TaskCreated) => {
      this.handleTaskCreated(event).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[RuntimeHost] task_created failed:', error);
        if (this.workspaceManager) {
          await this.workspaceManager.updateTask(event.taskId, { status: 'rejected' }).catch(() => undefined);
        }
        eventBus.emit({
          id: crypto.randomUUID(),
          type: 'task_failed',
          missionId: event.missionId,
          taskId: event.taskId,
          agentInstanceId: event.agentInstanceId,
          agentProfileId: (event as TaskCreated & Record<string, unknown>).agentProfileId as string | undefined,
          error: message,
          timestamp: new Date().toISOString(),
        });
      });
    });

    this.unsubscribeRuntimeApproval = eventBus.on('approval_requested', (event: ApprovalRequested) => {
      // Runtime-originated approval IDs are session-scoped. Orchestrator
      // approvals are persisted separately and must not enter this map.
      if (!event.approvalId.includes(':')) return;
      this.pendingRuntimeApprovals.set(event.approvalId, {
        missionId: event.missionId,
        taskId: event.taskId,
        agentInstanceId: event.agentInstanceId,
        approvalType: event.approvalType,
        toolName: event.toolName,
        path: event.path,
        command: event.command,
      });
    });

    const clearRouting = (event: { missionId: string }) => this.clearMissionRoutingPreference(event.missionId);
    const completed = eventBus.on('mission_completed', clearRouting);
    const failed = eventBus.on('mission_failed', clearRouting);
    this.unsubscribeMissionTerminal = () => { completed(); failed(); };

    const taskCompleted = eventBus.on('task_completed', async (event) => {
      for (const [sessionId, active] of this.activeSessions.entries()) {
        if (active.missionId !== event.missionId || active.taskId !== event.taskId) continue;
        if (!this.isCorrelatedTerminalEvent(event, sessionId, active)) continue;
        if (this.finishingSessions.has(sessionId)) continue;
        this.finishingSessions.add(sessionId);
        try {
          await this.finishAttempt(active, 'completed', { resultSummary: event.result });
          eventBus.emit({
            id: crypto.randomUUID(),
            type: 'agent_completed',
            missionId: event.missionId,
            agentInstanceId: sessionId,
            agentProfileId: active.agentProfileId,
            summary: event.result,
            timestamp: new Date().toISOString(),
          });
          void this.emitRuntimeTelemetry(event, active, 'completed').catch(() => undefined);
          this.activeSessions.delete(sessionId);
        } finally {
          this.finishingSessions.delete(sessionId);
        }
      }
    });
    const taskFailed = eventBus.on('task_failed', async (event) => {
      for (const [sessionId, active] of this.activeSessions.entries()) {
        if (active.missionId !== event.missionId || active.taskId !== event.taskId) continue;
        if (!this.isCorrelatedTerminalEvent(event, sessionId, active)) continue;
        if (this.finishingSessions.has(sessionId)) continue;
        this.finishingSessions.add(sessionId);
        try {
          await this.finishAttempt(active, 'failed', { error: event.error, retryable: true });
          eventBus.emit({
            id: crypto.randomUUID(),
            type: 'agent_error',
            missionId: event.missionId,
            taskId: event.taskId,
            agentInstanceId: sessionId,
            agentProfileId: active.agentProfileId,
            error: event.error,
            timestamp: new Date().toISOString(),
          });
          void this.emitRuntimeTelemetry(event, active, 'failed').catch(() => undefined);
          this.activeSessions.delete(sessionId);
        } finally {
          this.finishingSessions.delete(sessionId);
        }
      }
    });
    this.unsubscribeTaskTerminal = () => { taskCompleted(); taskFailed(); };
    this.unsubscribeRuntimeActivity = eventBus.on('*', (event) => {
      if (!('agentInstanceId' in event) || typeof event.agentInstanceId !== 'string') return;
      if (!this.activeSessions.has(event.agentInstanceId)) return;
      const active = this.activeSessions.get(event.agentInstanceId);
      if (active) {
        active.lastProtocolResponseAt = Date.now();
        active.probeFailures = 0;
      }
      void this.heartbeatSession(event.agentInstanceId).catch(() => undefined);
    });
  }

  private unsubscribeToEventBus(): void {
    this.unsubscribeTaskCreated?.();
    this.unsubscribeTaskCreated = undefined;
    this.unsubscribeRuntimeApproval?.();
    this.unsubscribeRuntimeApproval = undefined;
    this.unsubscribeMissionTerminal?.();
    this.unsubscribeMissionTerminal = undefined;
    this.unsubscribeTaskTerminal?.();
    this.unsubscribeTaskTerminal = undefined;
    this.unsubscribeRuntimeActivity?.();
    this.unsubscribeRuntimeActivity = undefined;
  }

  private isCorrelatedTerminalEvent(
    event: TaskCompleted | TaskFailed,
    sessionId: string,
    active: { missionId?: string; taskId?: string; attemptId?: string; session: AgentSession },
  ): boolean {
    const identity = event as TaskCompleted & Record<string, unknown>;
    // Once an attempt has a durable identity, a terminal signal must carry at
    // least one matching identity. This prevents a late signal from an older
    // process from closing a replacement attempt for the same task.
    if (typeof identity.attemptId === 'string') return identity.attemptId === active.attemptId;
    if (event.runId) {
      return event.runId === active.session.runtimeSessionId || event.runId === sessionId;
    }
    if (event.agentInstanceId) {
      return event.agentInstanceId === sessionId || event.agentInstanceId === active.session.agentInstanceId;
    }
    // An uncorrelated terminal event is only safe when this task has one live
    // attempt. During retries, ignore it instead of closing the new session.
    const matches = [...this.activeSessions.entries()].filter(([, candidate]) =>
      candidate.missionId === active.missionId && candidate.taskId === active.taskId);
    return !active.attemptId && matches.length === 1;
  }

  private async emitRuntimeTelemetry(
    event: TaskCompleted | TaskFailed,
    active: {
      adapterId: string;
      session: AgentSession;
      accountProfileId?: string;
      agentProfileId?: string;
      profileId?: string;
      profileName?: string;
      profileSource?: AgentProfileResolution['source'];
      queuedAt: number;
      startedAt: number;
      retryCount: number;
      attemptId?: string;
      role?: AgentRole | string;
    },
    outcome: 'completed' | 'failed',
  ): Promise<void> {
    if (!this.eventBus) return;
    const now = Date.now();
    const adapter = this.adapters.get(active.adapterId);
    let usage: Awaited<ReturnType<BaseRuntimeAdapter['getUsage']>> = null;
    try {
      usage = adapter ? await adapter.getUsage(active.session.id) : null;
    } catch {
      // Usage discovery is best effort; lifecycle telemetry remains durable.
    }
    const maxSessions = Math.max(1, this.config.maxConcurrentSessions || 1);
    this.eventBus.emit({
      id: `runtime-telemetry:${active.attemptId || active.session.id}`,
      type: 'runtime_telemetry',
      missionId: event.missionId,
      taskId: event.taskId,
      agentInstanceId: active.session.agentInstanceId || active.session.id,
      adapterId: active.adapterId,
      accountProfileId: active.accountProfileId,
      agentProfileId: active.agentProfileId,
      profileId: active.profileId,
      profileName: active.profileName,
      profileSource: active.profileSource,
      attemptId: active.attemptId,
      outcome,
      usageAvailable: usage !== null,
      usageSource: usage ? 'provider_reported' : 'unavailable',
      inputTokens: Math.max(0, Math.round(usage?.inputTokens || 0)),
      outputTokens: Math.max(0, Math.round(usage?.outputTokens || 0)),
      cost: usage?.totalCost == null ? null : Math.max(0, Number(usage.totalCost) || 0),
      currency: usage?.currency || null,
      queueWaitMs: Math.max(0, active.startedAt - active.queuedAt),
      durationMs: Math.max(0, now - active.startedAt),
      retryCount: Math.max(0, active.retryCount - 1),
      workerUtilization: Math.min(1, this.activeSessions.size / maxSessions),
      timestamp: new Date(now).toISOString(),
    });
  }

  async discoverRuntimeStatuses(): Promise<RuntimeStatus[]> {
    return Promise.all([...this.adapters.values()].map(async (adapter) => {
      const installation = await adapter.discoverInstallation();
      const capabilities = installation.installed ? await adapter.probeCapabilities() : await adapter.getCapabilities();
      const authMethods = await adapter.getAuthMethods();
      return {
        runtimeType: adapter.runtimeType,
        name: adapter.name,
        installation,
        capabilities: capabilities as unknown as Record<string, boolean>,
        authMethods,
      };
    }));
  }

  async createAccountProfile(input: {
    runtimeType: RuntimeType;
    provider?: Provider;
    profileName: string;
    allowedRoles?: string[];
    schedulerAuto?: boolean;
    authMethod?: string;
    profileMode?: 'isolated' | 'shared_cli';
  }): Promise<AccountProfile> {
    if (input.runtimeType === 'antigravity') {
      const existing = (await this.profileManager.getProfiles()).find((profile) => profile.runtimeType === 'antigravity');
      if (existing) {
        throw new Error('Antigravity currently exposes one operating-system keyring profile per user. Remove the existing Antigravity profile before adding another one.');
      }
    }
    const adapter = this.requireAdapter(input.runtimeType);
    const installation = await adapter.discoverInstallation();
    const capabilities = installation.installed ? await adapter.probeCapabilities() : undefined;
    return this.profileManager.createProfile({
      provider: input.provider || this.defaultProvider(input.runtimeType),
      runtimeType: input.runtimeType,
      profileName: input.profileName,
      authStatus: installation.installed ? 'login_required' : 'not_installed',
      configDir: '',
      supportedModels: [],
      usageScope: null,
      allowedRoles: input.allowedRoles || ['Orchestrator', 'Builder', 'Reviewer', 'Researcher', 'QA'],
      schedulerAuto: input.schedulerAuto ?? true,
      executablePath: installation.path,
      installedVersion: installation.version,
      integrationMode: this.integrationMode(input.runtimeType, capabilities),
      authMethod: input.authMethod,
      capabilitySnapshot: capabilities as unknown as Record<string, boolean> | undefined,
      statusMessage: installation.error,
      profileMode: input.profileMode || (input.runtimeType === 'opencode' && ['existing_cli', 'existing_store'].includes(input.authMethod || '') ? 'shared_cli' : input.runtimeType === 'antigravity' ? 'shared_cli' : 'isolated'),
    });
  }

  async beginAuthentication(profileId: string, method: string, options: Record<string, unknown> = {}): Promise<AuthInitiationResult> {
    const profile = await this.requireProfile(profileId);
    const adapter = this.requireAdapter(profile.runtimeType);
    adapter.configureProfile(profile);
    const result = await adapter.beginAuthentication(method, { ...options, profileId });
    const nextStatus = result.status === 'failed'
      ? 'error'
      : method.includes('device') ? 'awaiting_device_code' : result.status === 'completed' ? 'connected' : 'awaiting_browser';
    await this.profileManager.updateProfile(profileId, {
      authMethod: method,
      authStatus: nextStatus,
      loginUrl: result.url,
      deviceCode: result.userCode,
      statusMessage: result.instructions,
    });
    return result;
  }

  async pollAuthentication(profileId: string, authId: string): Promise<AuthPollResult> {
    const profile = await this.requireProfile(profileId);
    const adapter = this.requireAdapter(profile.runtimeType);
    adapter.configureProfile(profile);
    const result = await adapter.pollAuthentication(authId);
    await this.profileManager.updateProfile(profileId, {
      authStatus: result.status,
      lastVerifiedAt: result.status === 'connected' ? new Date().toISOString() : profile.lastVerifiedAt,
      statusMessage: result.message,
    });
    if (result.status === 'connected') await this.refreshModels(profileId).catch(() => []);
    return result;
  }

  async verifyAccount(profileId: string): Promise<AccountProfile> {
    const profile = await this.requireProfile(profileId);
    const adapter = this.requireAdapter(profile.runtimeType);
    adapter.configureProfile(profile);
    const [installation, authStatus, capabilities] = await Promise.all([
      adapter.discoverInstallation(profileId),
      adapter.verifyAuthentication(profileId),
      adapter.probeCapabilities(profileId),
    ]);
    const updated = await this.profileManager.updateProfile(profileId, {
      authStatus,
      executablePath: installation.path,
      installedVersion: installation.version,
      integrationMode: this.integrationMode(profile.runtimeType, capabilities),
      capabilitySnapshot: capabilities as unknown as Record<string, boolean>,
      lastVerifiedAt: new Date().toISOString(),
      statusMessage: installation.error,
    });
    if (authStatus === 'connected') await this.refreshModels(profileId).catch(() => []);
    return updated;
  }

  async refreshModels(profileId: string): Promise<ModelDescriptor[]> {
    const profile = await this.requireProfile(profileId);
    this.requireAdapter(profile.runtimeType).configureProfile(profile);
    const models = await this.catalogService.discoverForProfile(profile);
    await this.profileManager.updateProfile(profileId, {
      supportedModels: models.map((model) => model.runtimeModelId),
      lastModelDiscoveryAt: new Date().toISOString(),
      statusMessage: models.length ? undefined : 'No models were returned by the connected runtime.',
    });
    return models;
  }

  async logoutAccount(profileId: string): Promise<AccountProfile> {
    const profile = await this.requireProfile(profileId);
    const adapter = this.requireAdapter(profile.runtimeType);
    adapter.configureProfile(profile);
    await adapter.logout(profileId);
    this.catalogService.removeProfile(profileId);
    return this.profileManager.updateProfile(profileId, {
      authStatus: 'login_required', supportedModels: [], loginUrl: undefined,
      deviceCode: undefined, statusMessage: 'Signed out through the official runtime.',
    });
  }

  async deleteAccount(profileId: string): Promise<boolean> {
    const profile = await this.profileManager.getProfileById(profileId);
    if (profile) {
      const adapter = this.requireAdapter(profile.runtimeType);
      adapter.configureProfile(profile);
      await adapter.logout(profileId).catch(() => undefined);
    }
    this.catalogService.removeProfile(profileId);
    return this.profileManager.deleteProfile(profileId);
  }

  async updateAccount(profileId: string, updates: Partial<AccountProfile>): Promise<AccountProfile> {
    const allowed: Partial<AccountProfile> = {
      profileName: updates.profileName,
      allowedRoles: updates.allowedRoles,
      schedulerAuto: updates.schedulerAuto,
      authStatus: updates.authStatus,
    };
    return this.profileManager.updateProfile(profileId, Object.fromEntries(Object.entries(allowed).filter(([, value]) => value !== undefined)) as Partial<AccountProfile>);
  }

  async discoverModels(): Promise<ModelDescriptor[]> {
    return this.catalogService.discoverLiveModels(await this.profileManager.getProfiles());
  }

  getCachedModels(): ModelDescriptor[] { return this.catalogService.getCachedCatalog(); }
  async discoverAccounts(): Promise<AccountProfile[]> { return this.profileManager.getProfiles(); }
  async discoverRuntimes(): Promise<string[]> { return [...this.adapters.keys()]; }

  private async resolveEffectiveRoutingPreference(missionId: string, role: AgentRole): Promise<EffectiveRoutingPreference | undefined> {
    const missionPreference = this.missionRouting.get(missionId);
    const explicitRole = missionPreference?.scopeRole || missionPreference?.targetRole;
    // Older clients did not send a route scope. Treat an unscoped manual model
    // selection as an Orchestrator override rather than leaking one model across
    // Builder/Reviewer/QA roles.
    const explicitAppliesToRole = explicitRole === 'mission'
      || (explicitRole ? explicitRole === role : role === 'orchestrator');
    const hasExplicitPreference = explicitAppliesToRole && Boolean(
      missionPreference?.modelCatalogId
      || missionPreference?.accountProfileId
      || missionPreference?.reasoningLevel
      || missionPreference?.fallbackCatalogIds?.length,
    );
    if (missionPreference && hasExplicitPreference) {
      return {
        modelCatalogId: missionPreference.modelCatalogId,
        accountProfileId: missionPreference.accountProfileId,
        reasoningLevel: missionPreference.reasoningLevel,
        fallbackCatalogIds: missionPreference.fallbackCatalogIds || [],
        selectionMode: missionPreference.selectionMode || (missionPreference.modelCatalogId ? 'fixed' : 'prefer'),
        source: 'explicit',
      };
    }
    return this.workspaceManager?.resolveRoleExecutionPolicy(missionId, role);
  }

  async handleTaskCreated(event: TaskCreated): Promise<AgentSession> {
    const missionPreference = this.missionRouting.get(event.missionId);
    const task = this.workspaceManager ? await this.workspaceManager.getTask(event.taskId) : null;
    if (this.workspaceManager && !task) {
      throw new Error(`Persisted task ${event.taskId} was not found; refusing to derive execution access from the event.`);
    }
    if (task && task.missionId !== event.missionId) {
      throw new Error(`Task ${event.taskId} belongs to mission ${task.missionId}, not event mission ${event.missionId}.`);
    }
    const persistedRole = task ? normalizeAgentRole(task.assignedRole) : undefined;
    if (task && !persistedRole) {
      throw new Error(`Persisted task ${event.taskId} has no valid assigned role; refusing to launch it.`);
    }
    const eventRole = normalizeAgentRole(event.assignedRole);
    if (persistedRole && eventRole && persistedRole !== eventRole) {
      console.warn(`[RuntimeHost] task_created role mismatch for ${event.taskId}: event=${eventRole}, persisted=${persistedRole}; using persisted role.`);
    }
    const role = persistedRole || eventRole || missionPreference?.targetRole || 'builder';
    const taskRecord = task as (typeof task & Record<string, unknown>) | null;
    const eventRecord = event as TaskCreated & Record<string, unknown>;
    const profileId = String(
      taskRecord?.agentProfileId
      || taskRecord?.profileId
      || eventRecord.agentProfileId
      || eventRecord.profileId
      || missionPreference?.agentProfileId
      || missionPreference?.profileId
      || '',
    ).trim() || undefined;
    const explicitProfile = taskRecord?.agentProfileId ? undefined : eventRecord.profile
      || eventRecord.agentProfile
      || taskRecord?.profile
      || taskRecord?.agentProfile;
    // Display metadata cannot manufacture a requested profile. An explicit
    // profile id must resolve through a catalog/resolver or a matching inline
    // profile object; otherwise dispatch fails closed.
    const profileInline = explicitProfile || (!task && !profileId && (eventRecord.displayName || eventRecord.specialty || eventRecord.instructions || eventRecord.capabilities)
      ? {
          id: profileId,
          role,
          name: eventRecord.displayName || eventRecord.specialty,
          specialty: eventRecord.specialty,
          instructions: eventRecord.instructions,
          capabilities: eventRecord.capabilities,
          routePolicy: eventRecord.routePolicy,
          allowedRoutePolicy: eventRecord.allowedRoutePolicy,
        }
      : undefined);
    const profileResolution = await this.resolveAgentProfileForDispatch({
      missionId: event.missionId,
      taskId: event.taskId,
      role,
      profileId,
      explicitProfile: profileInline,
    });
    const agentProfile = profileResolution.profile;
    if (this.workspaceManager && task && profileId && !taskRecord?.agentProfileId && !taskRecord?.profileId) {
      // Persist the resolved identity before creating the attempt whenever the
      // task came from a legacy row that carried it only on the event.
      await this.workspaceManager.updateTask(event.taskId, { agentProfileId: agentProfile.id });
    }
    const executionAccess: TaskExecutionAccess = role === 'builder'
      ? { role, accessMode: 'workspace-write', requiresIsolatedWorktree: true }
      : { role, accessMode: 'read-only', requiresIsolatedWorktree: false };
    const queuedAt = Date.parse(event.timestamp);
    const queuedAtMs = Number.isFinite(queuedAt) ? queuedAt : Date.now();
    const eventPreference: EffectiveRoutingPreference | undefined = Boolean(
      event.modelCatalogId || event.accountProfileId || event.reasoningLevel || event.fallbackCatalogIds?.length,
    ) ? {
      modelCatalogId: event.modelCatalogId,
      accountProfileId: event.accountProfileId,
      reasoningLevel: event.reasoningLevel as CanonicalReasoning | undefined,
      fallbackCatalogIds: event.fallbackCatalogIds || [],
      selectionMode: event.routeSelectionMode || (event.modelCatalogId ? 'fixed' : 'prefer'),
      source: 'explicit',
    } : undefined;
    const profilePreference = this.profileRoutingPreference(agentProfile, profileResolution.source);
    const effectivePreference = eventPreference
      || await this.resolveEffectiveRoutingPreference(event.missionId, role)
      || profilePreference;
    const workerRequest: WorkerRequest = {
      role,
      capabilities: [...new Set([
        ...(((task?.requiredCapabilities as string[] | undefined) || [])),
        ...agentProfile.capabilities,
      ])],
      task: task?.description || event.title,
      priority: task?.priority || 'medium',
      requiresWorktree: executionAccess.requiresIsolatedWorktree,
      preferredCatalogId: effectivePreference?.modelCatalogId,
      preferredAccountProfileId: effectivePreference?.accountProfileId,
      preferredReasoning: effectivePreference?.reasoningLevel,
      fallbackCatalogIds: effectivePreference?.fallbackCatalogIds,
      routeSelectionMode: effectivePreference?.selectionMode,
      routingSource: effectivePreference?.source,
    };

    const connectedProfiles = (await this.profileManager.getProfiles()).filter((profile) => profile.authStatus === 'connected');
    // schedulerAuto controls automatic discovery only. A user/team/workspace policy
    // is an explicit route declaration and may intentionally target a profile that
    // has automatic scheduler selection disabled.
    const routedProfiles = effectivePreference
      ? connectedProfiles
      : connectedProfiles.filter((profile) => profile.schedulerAuto !== false);
    const constrainedCached = this.constrainProfileRoutes(agentProfile, routedProfiles, this.catalogService.getCachedCatalog());
    const profiles = constrainedCached.profiles;
    let models = constrainedCached.models;
    const configuredCatalogIds = new Set([
      ...(effectivePreference?.modelCatalogId ? [effectivePreference.modelCatalogId] : []),
      ...(effectivePreference?.fallbackCatalogIds || []),
    ]);
    const selectedRouteMissing = [...configuredCatalogIds].some((catalogId) => !models.some((model) => model.catalogId === catalogId));
    if (models.length === 0 || selectedRouteMissing || models.some((model) => model.source === 'cached' || model.availability === 'unknown')) {
      models = await this.catalogService.discoverLiveModels(profiles);
    }
    models = this.constrainProfileRoutes(agentProfile, profiles, models).models;
    const route = this.scheduler.resolveRoute(workerRequest, profiles, models);
    if (isUnverifiedCatalogRoute(route.model)) {
      throw new Error(
        `The selected ${route.model?.displayName || route.model?.runtimeModelId || 'model'} route is not verified by a live runtime catalog. Refresh the connected runtime before starting the task.`,
      );
    }
    console.info(
      `[RuntimeHost] ${role}/${agentProfile.name} route -> ${route.adapterId}/${route.profile?.profileName || 'profile'}/${route.model?.displayName || 'runtime-default'} (${route.reasons.join('; ') || 'scheduler'})`,
    );
    const adapter = this.requireAdapter(route.adapterId as RuntimeType);
    const mission = this.workspaceManager ? await this.workspaceManager.getMission(event.missionId) : null;
    const automationPolicy = mission?.automationPolicy as {
      profile?: TrustProfile;
      overrides?: Partial<Record<AutomationAction, 'ask' | 'review' | 'auto' | 'deny'>>;
    } | null;
    const governedActions: AutomationAction[] = role === 'builder' && automationPolicy
      ? ['fileWrite', 'commandExecution', 'packageInstall', 'gitCommit']
      : role === 'qa' && automationPolicy
        ? ['commandExecution']
        : [];
    const actionBroker = new ActionBroker();
    const runtimeCapabilities = await adapter.probeCapabilities(route.profile?.id);
    const actionDecisions = governedActions.map((action) => actionBroker.authorize({
      action,
      profile: automationPolicy?.profile || 'review',
      overrides: automationPolicy?.overrides,
      requiredCapabilities: workerRequest.capabilities,
      role,
       // QA validates the upstream Builder worktree with a read-only runtime
       // mode, so its allowlisted checks do not require an interactive prompt.
       boundary: role === 'builder' || role === 'qa' ? 'isolated' : 'control_plane',
      runtimeCapabilities,
    }));
    const denied = actionDecisions.find((item) => !item.allowed && !item.requiresApproval);
    if (denied) throw new Error(`Mission policy denies ${role} action '${denied.action}': ${denied.reason || 'policy denied'}`);
    const approvalRequired = actionDecisions.filter((item) => item.requiresApproval);
    const unsupportedApproval = approvalRequired.filter((item) => !item.allowed);
    if (unsupportedApproval.length > 0) {
      throw new Error(`The selected runtime cannot pause for governed approvals (${unsupportedApproval.map((item) => item.action).join(', ')}). Select a runtime with interactive approval support or use Review mode.`);
    }
    if (route.profile) adapter.configureProfile(route.profile);
    const execution = await this.resolveTaskExecutionContext(event, role);
    if (executionAccess.requiresIsolatedWorktree) {
      if (!execution.worktreePath || execution.cwd !== execution.worktreePath) {
        throw new Error(`Builder task ${event.taskId} did not resolve to one isolated worktree.`);
      }
      this.assertBuilderWorktreeWritable(execution.worktreePath, event.taskId);
    }
    const prompt = [
      `Task: ${event.title}`,
      agentProfile.name !== `${role === 'qa' ? 'QA' : role.charAt(0).toUpperCase() + role.slice(1)} Agent`
        ? `Agent profile: ${agentProfile.name}${agentProfile.specialty ? ` (${agentProfile.specialty})` : ''}`
        : undefined,
      task?.description ? `Instructions:\n${task.description}` : undefined,
      agentProfile.instructions ? `Profile instructions:\n${agentProfile.instructions}` : undefined,
      execution.promptContext,
      role === 'builder'
         ? `Work only inside the assigned isolated worktree. Preserve the existing architecture, make the smallest correct change, run relevant checks, and report exactly what changed.${approvalRequired.length ? ` Request approval before: ${approvalRequired.map((item) => item.action).join(', ')}.` : ''}`
        : role === 'reviewer'
          ? 'Review only. Do not modify source files. Return exactly one QualityResultEnvelope JSON object: {"type":"quality_result","version":1,"role":"reviewer","verdict":"pass|fail","summary":"...","findings":["..."],"evidence":["file:line ..."]}. Do not wrap it in prose or Markdown.'
          : role === 'qa'
            ? 'Validate the selected Builder result without implementing product changes. Return exactly one QualityResultEnvelope JSON object: {"type":"quality_result","version":1,"role":"qa","verdict":"pass|fail","summary":"...","findings":["..."],"evidence":["exact command and result"]}. Do not wrap it in prose or Markdown.'
            : role === 'orchestrator'
              ? 'Plan, coordinate, and evaluate. Do not implement source changes directly.'
              : 'Investigate and report evidence. Do not modify source files.',
    ].filter(Boolean).join('\n\n');

    const claimedAt = new Date().toISOString();
    const routeSource = effectivePreference?.source
      || (profileResolution.source === 'workspace' || profileResolution.source === 'team_template' ? profileResolution.source : 'scheduler');
    const routeSnapshot: EffectiveAttemptRoute = {
      adapterId: route.adapterId,
      provider: route.profile?.provider,
      accountProfileId: route.profile?.id,
      modelCatalogId: route.model?.catalogId,
      runtimeModelId: route.model?.runtimeModelId,
      reasoningLevel: route.reasoningLevel,
      source: routeSource,
      selectionMode: effectivePreference?.selectionMode || 'auto',
      agentProfileId: agentProfile.id,
    };
    const attempt = this.workspaceManager ? await this.workspaceManager.claimTaskAttempt({
      taskId: event.taskId,
      missionId: event.missionId,
      agentInstanceId: event.agentInstanceId || event.taskId,
      worktreePath: execution.worktreePath ?? null,
      leaseExpiresAt: new Date(Date.parse(claimedAt) + this.sessionTimeoutMs()).toISOString(),
      now: claimedAt,
      agentProfileId: agentProfile.id,
      route: routeSnapshot,
    }) : undefined;
    await this.recordAgentDispatch({
      missionId: event.missionId,
      taskId: event.taskId,
      agentInstanceId: event.agentInstanceId || event.taskId,
      role,
      agentProfileId: agentProfile.id,
      profileId: agentProfile.id,
      profileName: agentProfile.name,
      profileSource: profileResolution.source,
      route: routeSnapshot,
    });
    let session: AgentSession;
    try {
      session = await adapter.spawnAgent({
        sessionId: event.agentInstanceId,
        taskId: event.taskId,
        missionId: event.missionId,
        prompt,
        role: executionAccess.role,
        accessMode: executionAccess.accessMode,
        model: route.model?.runtimeModelId,
        reasoningLevel: route.reasoningLevel,
        profileId: route.profile?.id,
        agentProfileId: agentProfile.id,
        isolated: executionAccess.requiresIsolatedWorktree,
        worktreePath: execution.worktreePath,
        cwd: execution.cwd,
        // Additive metadata for adapters/auditors that understand named
        // profiles; older adapters safely ignore these fields.
        profileName: agentProfile.name,
        specialty: agentProfile.specialty,
        profileInstructions: agentProfile.instructions,
        profileCapabilities: agentProfile.capabilities,
        allowedRoutePolicy: (agentProfile.allowedRoutePolicy || agentProfile.routePolicy) as Record<string, unknown> | undefined,
      });
    } catch (error) {
      if (attempt && this.workspaceManager) {
        await this.workspaceManager.finishTaskAttempt(attempt.id, 'failed', {
          error: error instanceof Error ? error.message : String(error), retryable: true,
        }).catch(() => undefined);
      }
      throw error;
    }
    const startedAt = Date.now();
    if (attempt && this.workspaceManager) {
      const heartbeatAt = new Date(startedAt).toISOString();
      const attemptStarted = await this.workspaceManager.markTaskAttemptRunning(
        attempt.id, session.id, heartbeatAt, new Date(startedAt + this.sessionTimeoutMs()).toISOString(), session.runtimeSessionId || session.id,
      );
      if (!attemptStarted) {
        await adapter.cancel(session.id).catch(() => undefined);
        throw new Error(`Task attempt ${attempt.id} expired before runtime startup completed.`);
      }
    }
      this.activeSessions.set(session.id, {
      adapterId: adapter.id,
      session,
      missionId: event.missionId,
      taskId: event.taskId,
      accountProfileId: route.profile?.id,
      agentProfileId: agentProfile.id,
      profileId: agentProfile.id,
      profileName: agentProfile.name,
      profileSource: profileResolution.source,
      route: routeSnapshot,
      queuedAt: queuedAtMs,
      startedAt,
        retryCount: attempt?.attemptNumber ?? 1,
        attemptId: attempt?.id,
        role,
        lastProtocolResponseAt: startedAt,
        probeFailures: 0,
    });
    if (this.workspaceManager && task?.assignedAgentId !== session.id) {
      await this.workspaceManager.updateTask(event.taskId, { assignedAgentId: session.id }).catch(() => undefined);
    }
    return session;
  }

  private assertBuilderWorktreeWritable(worktreePath: string, taskId: string): void {
    const probePath = path.join(worktreePath, `.atris-write-probe-${process.pid}-${crypto.randomUUID()}.tmp`);
    let failure: Error | undefined;
    try {
      fs.writeFileSync(probePath, taskId, { encoding: 'utf8', flag: 'wx' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failure = new Error(`Builder worktree is not writable (${worktreePath}): ${message}`);
    } finally {
      try {
        fs.rmSync(probePath, { force: true });
      } catch (error: unknown) {
        if (!failure) {
          const message = error instanceof Error ? error.message : String(error);
          failure = new Error(`Builder worktree probe could not be cleaned up (${probePath}): ${message}`);
        }
      }
    }
    if (failure) throw failure;
  }

  private async resolveTaskExecutionContext(
    event: TaskCreated,
    role: AgentRole,
  ): Promise<{ cwd: string; worktreePath?: string; promptContext?: string }> {
    if (!this.workspaceManager) {
      if (role === 'builder') throw new Error('Builder tasks require a WorkspaceManager so they can run in an isolated worktree.');
      return { cwd: this.config.workspacePath || process.cwd() };
    }

    const task = await this.workspaceManager.getTask(event.taskId);
    const mission = await this.workspaceManager.getMission(event.missionId);
    const workspace = mission ? await this.workspaceManager.getWorkspace(mission.workspaceId) : null;
    const workspacePath = workspace?.path || this.config.workspacePath || process.cwd();

    if (role === 'builder') {
      if (task?.worktreeId && path.isAbsolute(task.worktreeId) && fs.existsSync(task.worktreeId)) {
        const record = await this.workspaceManager.getWorktreeForTask(event.taskId);
        if (!record || record.missionId !== event.missionId || record.taskId !== event.taskId || path.resolve(record.path) !== path.resolve(task.worktreeId)) {
          throw new Error(`Persisted Builder worktree ownership is invalid for task ${event.taskId}.`);
        }
        const worktreePath = await fs.promises.realpath(record.path);
        const worktreeStat = await fs.promises.lstat(worktreePath);
        if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink()) {
          throw new Error(`Persisted Builder worktree is not a real directory for task ${event.taskId}.`);
        }
        return {
          cwd: worktreePath,
          worktreePath,
          promptContext: 'This is a revision or resumed attempt. Continue in the existing Builder worktree; do not create a second implementation branch.',
        };
      }
      try {
        const worktreePath = await this.workspaceManager.createWorktreeForTask(event.taskId);
        return { cwd: worktreePath, worktreePath };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not create an isolated worktree for task ${event.taskId}: ${message}`);
      }
    }

    const allTasks = await this.workspaceManager.listTasks(event.missionId);
    const byId = new Map(allTasks.map((item) => [item.id, item]));
    const builderWorktrees = new Map<string, { taskId: string; title: string; path: string }>();
    const visited = new Set<string>();
    const visitDependencies = (taskId: string) => {
      if (visited.has(taskId)) return;
      visited.add(taskId);
      const current = byId.get(taskId);
      if (!current) return;
      if (current.assignedRole === 'builder' && current.worktreeId && path.isAbsolute(current.worktreeId) && fs.existsSync(current.worktreeId)) {
        builderWorktrees.set(current.worktreeId, { taskId: current.id, title: current.title, path: current.worktreeId });
      }
      for (const dependencyId of (current.dependsOn as string[] | undefined) || []) visitDependencies(dependencyId);
    };
    visitDependencies(event.taskId);

    if (builderWorktrees.size === 0) {
      const completedBuilders = allTasks
        .filter((item) => item.assignedRole === 'builder' && item.worktreeId && path.isAbsolute(item.worktreeId) && fs.existsSync(item.worktreeId))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      if (completedBuilders.length === 1) {
        const builder = completedBuilders[0];
        builderWorktrees.set(builder.worktreeId!, { taskId: builder.id, title: builder.title, path: builder.worktreeId! });
      }
    }

    const candidates = [...builderWorktrees.values()];
    if (candidates.length === 1) {
      const candidate = candidates[0];
      return {
        cwd: candidate.path,
        worktreePath: candidate.path,
        promptContext: `Inspect and validate the Builder result from task "${candidate.title}" (${candidate.taskId}) in this worktree.`,
      };
    }
    if (candidates.length > 1) {
      if (role === 'qa') {
        throw new Error('QA cannot run against multiple candidate worktrees. Complete the candidate comparison and select one Builder result before starting QA.');
      }
      const reviewPackPath = await this.createCandidateReviewPack(event.missionId, event.taskId, candidates);
      return {
        cwd: reviewPackPath,
        promptContext: `Multiple Builder candidates exist. Compare the candidate manifests and unified diffs in ${reviewPackPath}. Do not assume either candidate is selected.`,
      };
    }

    return {
      cwd: workspacePath,
      promptContext: 'No Builder worktree is associated with this task. Work against the base workspace in read-only mode.',
    };
  }

  private async createCandidateReviewPack(
    missionId: string,
    taskId: string,
    candidates: Array<{ taskId: string; title: string; path: string }>,
  ): Promise<string> {
    if (!this.workspaceManager) throw new Error('Candidate review packs require a WorkspaceManager.');
    const packPath = path.join(os.tmpdir(), 'AtrisAgent', 'review-packs', missionId, taskId);
    fs.rmSync(packPath, { recursive: true, force: true });
    fs.mkdirSync(packPath, { recursive: true });
    const manifest: Array<{ label: string; taskId: string; title: string; worktreePath: string; changedFiles: unknown; diffFile: string }> = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const label = `candidate-${index + 1}`;
      const [changedFiles, diff] = await Promise.all([
        this.workspaceManager.getWorktreeManager().getChangedFiles(candidate.path),
        this.workspaceManager.getWorktreeManager().getDiff(candidate.path),
      ]);
      fs.writeFileSync(path.join(packPath, `${label}.diff`), diff || '(no diff returned)\n', 'utf8');
      manifest.push({
        label,
        taskId: candidate.taskId,
        title: candidate.title,
        worktreePath: candidate.path,
        changedFiles,
        diffFile: `${label}.diff`,
      });
    }
    fs.writeFileSync(path.join(packPath, 'manifest.json'), JSON.stringify({ missionId, reviewTaskId: taskId, candidates: manifest }, null, 2), 'utf8');
    fs.writeFileSync(path.join(packPath, 'README.md'), [
      '# AtrisAgent Candidate Review Pack',
      '',
      'Compare every candidate against the original task, architecture, security constraints, test evidence, and change scope.',
      'Do not modify candidate files. Return a winner only when the evidence is sufficient; otherwise request a revision.',
      '',
      ...manifest.map((item) => `- ${item.label}: ${item.title} — diff: ${item.diffFile}`),
      '',
    ].join('\n'), 'utf8');
    return packPath;
  }

  async startSession(adapterId: string, request: StartSessionRequest): Promise<string> {
    const session = await this.requireAdapter(adapterId).startSession(request);
    this.activeSessions.set(session.id, {
      adapterId,
      session,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      retryCount: 1,
      lastProtocolResponseAt: Date.now(),
      probeFailures: 0,
    });
    return session.id;
  }

  async stopSession(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId);
    if (!active) return;
    await this.adapters.get(active.adapterId)?.cancel(sessionId);
    await this.finishAttempt(active, 'cancelled');
    this.activeSessions.delete(sessionId);
  }

  async heartbeatSession(sessionId: string, now = new Date()): Promise<boolean> {
    const active = this.activeSessions.get(sessionId);
    if (!active?.attemptId || !this.workspaceManager) return false;
    return this.workspaceManager.heartbeatTaskAttempt(
      active.attemptId,
      now.toISOString(),
      new Date(now.getTime() + this.sessionTimeoutMs()).toISOString(),
    );
  }

  async reconcileStartup(now = new Date()): Promise<number> {
    if (!this.workspaceManager) return 0;
    const expired = await this.workspaceManager.expireOrphanedTaskAttempts(now.toISOString());
    for (const attempt of expired) {
      if (attempt.runtimeSessionId) this.activeSessions.delete(attempt.runtimeSessionId);
    }
    return expired.length;
  }

  async runSessionWatchdog(now = new Date()): Promise<number> {
    if (!this.workspaceManager) return 0;
    if (this.watchdogRunning) return 0;
    this.watchdogRunning = true;
    try {
      await Promise.all([...this.activeSessions.entries()].map(async ([sessionId, active]) => {
        if (this.finishingSessions.has(sessionId)) return;
        const adapter = this.adapters.get(active.adapterId);
        if (!adapter?.isSessionAlive(sessionId)) return;
        const idleFor = Math.max(0, now.getTime() - active.lastProtocolResponseAt);
        if (idleFor <= this.sessionIdleGraceMs()) {
          await this.heartbeatSession(sessionId, now).catch(() => false);
          return;
        }

        const responsive = await adapter.probeSessionResponsiveness(sessionId).catch(() => false);
        if (responsive) {
          active.lastProtocolResponseAt = now.getTime();
          active.probeFailures = 0;
          await this.heartbeatSession(sessionId, now).catch(() => false);
          return;
        }

        active.probeFailures += 1;
        if (active.probeFailures >= this.maxProbeFailures()) {
          this.finishingSessions.add(sessionId);
          try {
            await adapter.cancel(sessionId).catch(() => undefined);
            const finished = await this.finishAttempt(active, 'expired', {
              error: responsive === null
                ? 'Runtime session exceeded the bounded quiet CLI allowance'
                : 'Runtime session stopped responding to health probes',
              retryable: true,
            }).catch(() => false);
            this.activeSessions.delete(sessionId);
            if (finished) {
              const failure = {
                id: crypto.randomUUID(), type: 'task_failed', missionId: active.missionId || '',
                taskId: active.taskId || '', agentInstanceId: active.session.agentInstanceId || sessionId,
                agentProfileId: active.agentProfileId,
                attemptId: active.attemptId,
                error: responsive === null
                  ? 'Runtime session exceeded the bounded quiet CLI allowance'
                  : 'Runtime session stopped responding to health probes',
                timestamp: now.toISOString(),
              } as TaskFailed & { attemptId?: string };
              this.eventBus?.emit(failure);
              void this.emitRuntimeTelemetry(failure, active, 'failed').catch(() => undefined);
            }
          } finally {
            this.finishingSessions.delete(sessionId);
          }
        }
      }));
      const expired = await this.workspaceManager.expireStaleTaskAttempts(now.toISOString(), now.toISOString());
      for (const attempt of expired) {
        const sessionId = attempt.runtimeSessionId;
        const active = sessionId ? this.activeSessions.get(sessionId) : undefined;
        // A runtime session id can be reused by a replacement attempt. Only
        // cancel/remove the process that owns the expired durable attempt.
        const ownsExpiredAttempt = Boolean(active && active.attemptId === attempt.id);
        if (active && ownsExpiredAttempt && !this.finishingSessions.has(sessionId!)) {
          await this.adapters.get(active.adapterId)?.cancel(sessionId!).catch(() => undefined);
          this.activeSessions.delete(sessionId!);
        }
        this.eventBus?.emit({
          id: crypto.randomUUID(), type: 'task_failed', missionId: attempt.missionId,
          taskId: attempt.taskId, agentInstanceId: attempt.agentInstanceId,
          agentProfileId: attempt.agentProfileId || active?.agentProfileId,
          attemptId: attempt.id,
          error: attempt.error || 'Runtime session timed out', timestamp: now.toISOString(),
        } as TaskFailed & { attemptId?: string });
      }
      return expired.length;
    } finally {
      this.watchdogRunning = false;
    }
  }

  async respondToRuntimeApproval(requestId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const sessionId = requestId.split(':', 1)[0];
    const active = this.activeSessions.get(sessionId);
    if (!active) throw new Error(`No active runtime session was found for approval ${requestId}.`);
    const adapter = this.adapters.get(active.adapterId);
    if (!adapter) throw new Error(`Runtime adapter ${active.adapterId} is not registered.`);
    const pending = this.pendingRuntimeApprovals.get(requestId);
    if (pending?.agentInstanceId && pending.agentInstanceId !== sessionId) {
      throw new Error(`Runtime approval ${requestId} does not belong to the active session.`);
    }
    if (decision === 'approved') {
      const mission = this.workspaceManager ? await this.workspaceManager.getMission(pending?.missionId || active.missionId || '') : null;
      const workspace = mission && this.workspaceManager ? await this.workspaceManager.getWorkspace(mission.workspaceId) : null;
      const automationPolicy = mission?.automationPolicy as {
        profile?: TrustProfile;
        overrides?: Partial<Record<AutomationAction, 'ask' | 'review' | 'auto' | 'deny'>>;
      } | null;
      const runtimeCapabilities = await adapter.probeCapabilities();
      new ActionBroker().assertAllowed({
        action: automationActionForApproval(pending?.approvalType || 'tool'),
        profile: automationPolicy?.profile || 'review',
        overrides: automationPolicy?.overrides,
        role: active.role,
        toolName: pending?.toolName,
        path: pending?.path,
        command: pending?.command,
        workspacePath: workspace?.path,
        boundary: active.role === 'builder' ? 'isolated' : 'control_plane',
        runtimeCapabilities,
      });
    }
    await adapter.approveToolCall(requestId, decision);
    this.pendingRuntimeApprovals.delete(requestId);
  }

  async stopMission(missionId: string): Promise<void> {
    const sessionIds = [...this.activeSessions.entries()]
      .filter(([, active]) => active.missionId === missionId)
      .map(([sessionId]) => sessionId);
    for (const sessionId of sessionIds) {
      const active = this.activeSessions.get(sessionId);
      if (active && this.eventBus) {
        this.eventBus.emit({
          id: crypto.randomUUID(),
          type: 'agent_cancelled',
          missionId,
          taskId: active.taskId || null,
          agentInstanceId: active.session.agentInstanceId || sessionId,
          reason: 'Mission cancelled by the user.',
          timestamp: new Date().toISOString(),
        });
      }
      await this.stopSession(sessionId);
    }
    this.clearMissionRoutingPreference(missionId);
  }

  async stopAll(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    for (const sessionId of [...this.activeSessions.keys()]) await this.stopSession(sessionId);
    for (const adapter of this.adapters.values()) await adapter.shutdown();
  }

  private requireAdapter(id: string): BaseRuntimeAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Runtime adapter '${id}' is not registered.`);
    return adapter;
  }

  private async requireProfile(profileId: string): Promise<AccountProfile> {
    const profile = await this.profileManager.getProfileById(profileId);
    if (!profile) throw new Error(`Account profile '${profileId}' was not found.`);
    return profile;
  }

  private defaultProvider(runtimeType: RuntimeType): Provider {
    return runtimeType === 'codex' ? 'openai'
      : runtimeType === 'claude_code' ? 'anthropic'
        : runtimeType === 'antigravity' ? 'google' : 'opencode';
  }

  private integrationMode(runtimeType: RuntimeType, capabilities?: Record<string, boolean>): string {
    if (runtimeType === 'codex') return 'App Server + structured exec';
    if (runtimeType === 'claude_code') return 'Structured CLI stream-json';
    if (runtimeType === 'antigravity') return capabilities?.structuredEventStreaming ? 'Print mode stream-json' : 'TUI only (update required)';
    return 'Local HTTP server + SSE';
  }

  private sessionTimeoutMs(): number {
    return Math.max(1, this.config.sessionTimeout ?? 5 * 60_000);
  }

  private sessionIdleGraceMs(): number {
    return Math.max(this.sessionTimeoutMs(), this.config.sessionIdleGrace ?? 15 * 60_000);
  }

  private maxProbeFailures(): number {
    return Math.max(1, Math.floor(this.config.maxProbeFailures ?? 2));
  }

  private async finishAttempt(
    active: { attemptId?: string },
    status: 'completed' | 'failed' | 'cancelled' | 'expired',
    options: { error?: string | null; resultSummary?: string | null; retryable?: boolean } = {},
  ): Promise<boolean> {
    if (!active.attemptId || !this.workspaceManager) return false;
    return this.workspaceManager.finishTaskAttempt(active.attemptId, status, options);
  }
}

function automationActionForApproval(approvalType: string): AutomationAction {
  const type = approvalType.trim().toLowerCase().replace(/[\s.-]+/g, '_');
  if (type.includes('file') || type.includes('write') || type.includes('edit')) return 'fileWrite';
  if (type.includes('delete') || type.includes('remove')) return 'deleteFiles';
  if (type.includes('package') || type.includes('depend')) return 'packageInstall';
  if (type.includes('commit')) return 'gitCommit';
  if (type.includes('migration') || type.includes('database')) return 'databaseMigration';
  if (type.includes('push')) return 'gitPush';
  if (type.includes('pull') || type.includes('request')) return 'pullRequest';
  return 'commandExecution';
}

function normalizeAgentRole(role: unknown): AgentRole | undefined {
  const normalized = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'].includes(normalized)
    ? normalized as AgentRole
    : undefined;
}
