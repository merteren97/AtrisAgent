import fs from 'fs';
import os from 'os';
import path from 'path';
import type { LocalEventBus, Unsubscribe } from '@atris-agent-code/event-bus';
import type { ApprovalRequested, TaskCompleted, TaskCreated, TaskFailed } from '@atris-agent-code/event-schema';
import type {
  AgentSession,
  WorkerRequest,
  AgentRole,
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
}

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
}

interface TaskExecutionAccess {
  role: AgentRole;
  accessMode: 'read-only' | 'workspace-write';
  requiresIsolatedWorktree: boolean;
}

export class RuntimeHost {
  private config: RuntimeHostConfig;
  private eventBus?: LocalEventBus;
  private workspaceManager?: WorkspaceManager;
  private adapters = new Map<string, BaseRuntimeAdapter>();
  private activeSessions = new Map<string, {
    adapterId: string;
    session: AgentSession;
    missionId?: string;
    taskId?: string;
    accountProfileId?: string;
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

  clearMissionRoutingPreference(missionId: string, _preserveSupervisor = true): void {
    this.missionRouting.delete(missionId);
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
    active: { missionId?: string; taskId?: string; session: AgentSession },
  ): boolean {
    if (event.agentInstanceId) {
      return event.agentInstanceId === sessionId || event.agentInstanceId === active.session.agentInstanceId;
    }
    // An uncorrelated terminal event is only safe when this task has one live
    // attempt. During retries, ignore it instead of closing the new session.
    const matches = [...this.activeSessions.entries()].filter(([, candidate]) =>
      candidate.missionId === active.missionId && candidate.taskId === active.taskId);
    return matches.length === 1;
  }

  private async emitRuntimeTelemetry(
    event: TaskCompleted | TaskFailed,
    active: {
      adapterId: string;
      session: AgentSession;
      accountProfileId?: string;
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
    const effectivePreference = eventPreference || await this.resolveEffectiveRoutingPreference(event.missionId, role);
    const workerRequest: WorkerRequest = {
      role,
      capabilities: (task?.requiredCapabilities as string[] | undefined) || [],
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
    const profiles = effectivePreference
      ? connectedProfiles
      : connectedProfiles.filter((profile) => profile.schedulerAuto !== false);
    let models = this.catalogService.getCachedCatalog().filter((model) => profiles.some((profile) => profile.id === model.accountProfileId));
    const configuredCatalogIds = new Set([
      ...(effectivePreference?.modelCatalogId ? [effectivePreference.modelCatalogId] : []),
      ...(effectivePreference?.fallbackCatalogIds || []),
    ]);
    const selectedRouteMissing = [...configuredCatalogIds].some((catalogId) => !models.some((model) => model.catalogId === catalogId));
    if (models.length === 0 || selectedRouteMissing) {
      models = await this.catalogService.discoverLiveModels(profiles);
    }
    const route = this.scheduler.resolveRoute(workerRequest, profiles, models);
    console.info(
      `[RuntimeHost] ${role} route -> ${route.adapterId}/${route.profile?.profileName || 'profile'}/${route.model?.displayName || 'runtime-default'} (${route.reasons.join('; ') || 'scheduler'})`,
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
      requiredCapabilities: task?.requiredCapabilities as string[] | undefined,
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
      task?.description ? `Instructions:\n${task.description}` : undefined,
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
    const attempt = this.workspaceManager ? await this.workspaceManager.claimTaskAttempt({
      taskId: event.taskId,
      missionId: event.missionId,
      agentInstanceId: event.agentInstanceId || event.taskId,
      worktreePath: execution.worktreePath ?? null,
      leaseExpiresAt: new Date(Date.parse(claimedAt) + this.sessionTimeoutMs()).toISOString(),
      now: claimedAt,
      route: {
        adapterId: route.adapterId,
        provider: route.profile?.provider,
        accountProfileId: route.profile?.id,
        modelCatalogId: route.model?.catalogId,
        runtimeModelId: route.model?.runtimeModelId,
        reasoningLevel: route.reasoningLevel,
        source: effectivePreference?.source || 'scheduler',
        selectionMode: effectivePreference?.selectionMode || 'auto',
      },
    }) : undefined;
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
      isolated: executionAccess.requiresIsolatedWorktree,
      worktreePath: execution.worktreePath,
      cwd: execution.cwd,
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
          await adapter.cancel(sessionId).catch(() => undefined);
          await this.finishAttempt(active, 'expired', {
            error: responsive === null
              ? 'Runtime session exceeded the bounded quiet CLI allowance'
              : 'Runtime session stopped responding to health probes',
            retryable: true,
          }).catch(() => false);
          this.activeSessions.delete(sessionId);
          this.eventBus?.emit({
            id: crypto.randomUUID(), type: 'task_failed', missionId: active.missionId || '',
            taskId: active.taskId || '', agentInstanceId: active.session.agentInstanceId || sessionId,
            error: responsive === null
              ? 'Runtime session exceeded the bounded quiet CLI allowance'
              : 'Runtime session stopped responding to health probes',
            timestamp: now.toISOString(),
          });
        }
      }));
      const expired = await this.workspaceManager.expireStaleTaskAttempts(now.toISOString(), now.toISOString());
      for (const attempt of expired) {
        const sessionId = attempt.runtimeSessionId;
        const active = sessionId ? this.activeSessions.get(sessionId) : undefined;
        if (active) {
          await this.adapters.get(active.adapterId)?.cancel(sessionId!).catch(() => undefined);
          this.activeSessions.delete(sessionId!);
        }
        this.eventBus?.emit({
          id: crypto.randomUUID(), type: 'task_failed', missionId: attempt.missionId,
          taskId: attempt.taskId, agentInstanceId: attempt.agentInstanceId,
          error: attempt.error || 'Runtime session timed out', timestamp: now.toISOString(),
        });
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
