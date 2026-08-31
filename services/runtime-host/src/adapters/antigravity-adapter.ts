import os from 'os';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type {
  RuntimeType,
  AgentSession,
  CapabilitySnapshot,
  StartSessionRequest,
  AgentInput,
  ApprovalDecision,
  UsageSnapshot,
  ModelDescriptor,
  AccountProfile,
  AccountProfileStatus,
  InstallationStatus,
  AuthMethodDescriptor,
  AuthInitiationResult,
  AuthPollResult,
  CanonicalReasoning,
  Provider,
  AgentRole,
} from '@atris-agent-code/domain';
import { BaseRuntimeAdapter, type SpawnAgentOptions } from './base-adapter';
import { parseAntigravityStreamLine } from './antigravity-stream';
import { resolveAntigravityPrintTimeout } from '../antigravity-run-policy';
import {
  parseAntigravityModelsOutput,
  resolveAntigravityModelRoute,
  type AntigravityCliModelFamily,
} from '../antigravity-model-catalog';
import {
  appendControlPlaneInstructions,
  controlPlaneEnv,
  createAntigravityMcpOverlay,
  prepareControlPlaneSession,
  revokeControlPlaneAgent,
} from '../control-plane';
import {
  findExecutable,
  getHelpText,
  launchInteractiveTerminal,
  redactSecrets,
  runCommand,
  spawnHidden,
  spawnHiddenChecked,
} from '../runtime-utils';

interface PendingAuth {
  launchedAt: string;
  output: string;
  error?: string;
}

interface DocumentedModel {
  slug: string;
  name: string;
  provider: Provider;
  efforts: CanonicalReasoning[];
  entitlement?: string;
}

type PendingTerminalOutcome =
  | { kind: 'completed'; result: string }
  | { kind: 'failed'; error: string; exitCode?: number | null };

const ALL_ROLES: AgentRole[] = ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'];
const MAX_STDERR_CHARS = 8_000;
const TERMINAL_EXIT_GRACE_MS = 750;
const TERMINAL_FORCE_KILL_MS = 3_000;
const PROCESS_EXIT_STREAM_DRAIN_MS = 150;
const FINAL_RESPONSE_QUIET_GRACE_MS = 2_500;
const TERMINAL_RELEASE_GRACE_MS = TERMINAL_EXIT_GRACE_MS + TERMINAL_FORCE_KILL_MS + 500;

// Last-resort fallback only. `agy models` is authoritative when the installed CLI exposes it.
const DOCUMENTED_MODELS: DocumentedModel[] = [
  { slug: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', provider: 'google', efforts: ['low', 'medium', 'high'], entitlement: 'Availability is verified by the installed Antigravity CLI' },
  { slug: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', provider: 'google', efforts: ['low', 'medium', 'high'], entitlement: 'Availability is verified by the installed Antigravity CLI' },
  { slug: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google', efforts: ['low', 'medium', 'high'], entitlement: 'Availability is verified by the installed Antigravity CLI' },
  { slug: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'google', efforts: ['low', 'high'], entitlement: 'Availability is verified by the installed Antigravity CLI' },
  { slug: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', efforts: ['high'], entitlement: 'Availability is verified by the installed Antigravity CLI' },
  { slug: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6', provider: 'anthropic', efforts: ['high'], entitlement: 'Availability is verified by the installed Antigravity CLI' },
  { slug: 'gpt-oss-120b', name: 'GPT-OSS 120B', provider: 'local', efforts: ['medium'], entitlement: 'Availability is verified by the installed Antigravity CLI' },
];

export class AntigravityAdapter extends BaseRuntimeAdapter {
  readonly id = 'antigravity';
  readonly name = 'Antigravity CLI';
  readonly runtimeType: RuntimeType = 'antigravity';

  private authFlows = new Map<string, PendingAuth>();
  private sessionContext = new Map<string, { missionId: string; taskId: string }>();
  private terminalSessions = new Set<string>();
  private publishedTerminalSessions = new Set<string>();
  private pendingTerminalBySession = new Map<string, PendingTerminalOutcome>();
  private lastOutputBySession = new Map<string, string>();
  private softTerminalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private softTerminalResultsBySession = new Map<string, string>();
  private terminalReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private liveModelFamilies: AntigravityCliModelFamily[] = [];
  private lastVerification?: { status: AccountProfileStatus; checkedAt: number; activeModel?: string; message?: string };

  constructor(eventBus?: LocalEventBus) {
    super(eventBus);
  }

  override async cancel(sessionId: string): Promise<void> {
    await super.cancel(sessionId);
    this.cleanupSessionState(sessionId);
  }

  override async shutdown(): Promise<void> {
    await super.shutdown();
    this.cleanupAllSessionState();
  }

  async discoverInstallation(): Promise<InstallationStatus> {
    const executable = await findExecutable('agy');
    if (!executable) return { installed: false, error: 'Antigravity CLI (`agy`) was not found in PATH.' };
    try {
      const version = (await runCommand(executable, ['--version'], { timeoutMs: 8_000 })).stdout.trim();
      return { installed: true, path: executable, version: version || undefined };
    } catch (error: any) {
      return { installed: true, path: executable, error: error?.message || 'Could not read Antigravity version.' };
    }
  }

  async probeCapabilities(): Promise<CapabilitySnapshot> {
    const install = await this.discoverInstallation();
    if (!install.installed) return this.emptyCapabilities();
    const help = (await getHelpText(install.path || 'agy')).toLowerCase();
    return {
      structuredEventStreaming: /stream-json/.test(help) && /--print|-p\b/.test(help),
      sessionResume: /--continue|-c\b|--conversation/.test(help),
      modelSelection: /--model\b/.test(help),
      reasoningControl: /--effort\b/.test(help),
      toolCallEvents: /stream-json/.test(help),
      // Antigravity exposes sandbox flags but no in-process approval callback.
      interactiveApproval: false,
      usageInfo: /usage|quota/.test(help),
      cancellation: true,
      worktreeAwareness: true,
      headlessAuth: false,
      nativeSubAgent: true,
    };
  }

  private emptyCapabilities(): CapabilitySnapshot {
    return {
      structuredEventStreaming: false, sessionResume: false, modelSelection: false,
      reasoningControl: false, toolCallEvents: false, interactiveApproval: false,
      usageInfo: false, cancellation: false, worktreeAwareness: false,
      headlessAuth: false, nativeSubAgent: false,
    };
  }

  async getAuthMethods(): Promise<AuthMethodDescriptor[]> {
    return [
      {
        id: 'native_keyring',
        name: 'Google browser / native keyring',
        type: 'os_keyring',
        description: 'Opens Antigravity in a real terminal. The official CLI uses Windows Credential Manager, macOS Keychain, or Linux Secret Service and opens Google Sign-In when needed.',
      },
    ];
  }

  async beginAuthentication(method = 'native_keyring'): Promise<AuthInitiationResult> {
    const authId = crypto.randomUUID();
    const install = await this.discoverInstallation();
    if (!install.installed || !install.path) return { authId, method, status: 'failed', instructions: install.error };

    try {
      await launchInteractiveTerminal(install.path, [], { cwd: os.homedir(), title: 'Antigravity CLI Sign-In' });
      this.authFlows.set(authId, { launchedAt: new Date().toISOString(), output: '' });
      this.lastVerification = undefined;
      return {
        authId,
        method,
        status: 'pending',
        instructions: [
          'A separate Antigravity terminal window was opened.',
          'Complete the Google Sign-In in your browser, then wait until the Antigravity prompt is ready.',
          'Return to AtrisAgent and press “Check connection”.',
          'Credentials remain in the operating-system keyring; AtrisAgent never reads or copies the token.',
        ].join('\n'),
      };
    } catch (error: any) {
      return { authId, method, status: 'failed', instructions: error?.message || 'Could not open the Antigravity sign-in terminal.' };
    }
  }

  async pollAuthentication(authId: string): Promise<AuthPollResult> {
    const flow = this.authFlows.get(authId);
    if (!flow) return { authId, status: 'error', message: 'Authentication flow not found. Start the Antigravity sign-in flow again.' };

    const status = await this.verifyAuthentication();
    const verification = this.lastVerification;
    if (status === 'connected') {
      this.authFlows.delete(authId);
      return {
        authId,
        status,
        message: verification?.activeModel
          ? `Antigravity is connected. Active model detected: ${verification.activeModel}.`
          : 'Antigravity is connected and print mode is reachable.',
      };
    }
    if (status === 'rate_limited') {
      return { authId, status, message: verification?.message || 'Authentication is valid, but the selected Antigravity model is currently rate limited.' };
    }
    return {
      authId,
      status: status === 'login_required' ? 'awaiting_browser' : status,
      message: verification?.message || flow.error || 'Waiting for Google Sign-In to complete in the Antigravity terminal.',
    };
  }

  async verifyAuthentication(): Promise<AccountProfileStatus> {
    if (this.lastVerification && Date.now() - this.lastVerification.checkedAt < 120_000 && this.lastVerification.status === 'connected') {
      return this.lastVerification.status;
    }

    const install = await this.discoverInstallation();
    if (!install.installed || !install.path) return 'not_installed';
    const capabilities = await this.probeCapabilities();
    if (!capabilities.structuredEventStreaming) {
      this.lastVerification = {
        status: 'error',
        checkedAt: Date.now(),
        message: 'Antigravity print mode with structured output is unavailable. Update Antigravity CLI to 1.1.8 or newer.',
      };
      return 'error';
    }

    try {
      const result = await runCommand(install.path, [
        '--print',
        'Reply with exactly ATRIS_AUTH_OK. Do not use tools and do not modify files.',
        '--output-format',
        'json',
        '--sandbox',
      ], { timeoutMs: 75_000, cwd: os.homedir() });
      const activeModel = this.extractModelId(result.stdout);
      this.lastVerification = { status: 'connected', checkedAt: Date.now(), activeModel };
      return 'connected';
    } catch (error: any) {
      const raw = `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`;
      const text = raw.toLowerCase();
      const message = redactSecrets(raw).trim().slice(-1_500);
      const needsOnboarding = /first.?launch|onboarding|workspace trust|trust this|select.*theme|rendering mode/.test(text);
      const status: AccountProfileStatus = /rate.?limit|quota|resource exhausted|too many requests/.test(text)
        ? 'rate_limited'
        : /auth|login|sign.?in|credential|keyring|unauthorized|forbidden|account/.test(text)
          ? 'login_required'
          : 'error';
      this.lastVerification = {
        status,
        checkedAt: Date.now(),
        message: needsOnboarding
          ? 'Antigravity still requires first-launch setup or workspace trust. Finish the prompts in the opened Antigravity terminal, then check the connection again.'
          : message,
      };
      return status;
    }
  }

  async logout(): Promise<void> {
    const install = await this.discoverInstallation();
    if (!install.installed || !install.path) return;
    const child = spawnHidden(install.path, [], { stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.stdin?.write('/logout\n');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    child.kill('SIGTERM');
    this.lastVerification = undefined;
    this.liveModelFamilies = [];
  }

  private async discoverLiveModelFamilies(executable: string): Promise<AntigravityCliModelFamily[]> {
    try {
      const result = await runCommand(executable, ['models'], { timeoutMs: 12_000, cwd: os.homedir() });
      const families = parseAntigravityModelsOutput(result.stdout);
      if (families.length) this.liveModelFamilies = families;
      return families;
    } catch (error) {
      console.warn('[AntigravityAdapter] Live `agy models` discovery failed; using fallback catalog.', error);
      return [];
    }
  }

  private activeFamily(families: AntigravityCliModelFamily[], activeModel?: string): AntigravityCliModelFamily | undefined {
    if (!activeModel) return undefined;
    const target = this.normalizeModelId(activeModel);
    return families.find((family) => [family.id, family.displayName, family.defaultRoute, ...Object.values(family.routes)]
      .filter((value): value is string => Boolean(value))
      .some((value) => this.normalizeModelId(value) === target));
  }

  async discoverModels(profileId = 'default'): Promise<ModelDescriptor[]> {
    if ((await this.verifyAuthentication()) !== 'connected') return [];
    const install = await this.discoverInstallation();
    if (!install.installed || !install.path) return [];
    const capabilities = await this.probeCapabilities();
    const activeModel = this.lastVerification?.activeModel;
    const liveFamilies = await this.discoverLiveModelFamilies(install.path);
    const activeFamily = this.activeFamily(liveFamilies, activeModel);

    if (liveFamilies.length) {
      const models = liveFamilies.map<ModelDescriptor>((family) => ({
        catalogId: `${this.id}:${profileId}:${family.id}`,
        runtimeId: this.runtimeType,
        accountProfileId: profileId,
        providerId: family.provider,
        runtimeModelId: family.id,
        displayName: family.displayName,
        description: 'Live model family reported by the installed `agy models` command.',
        supportedRoles: ALL_ROLES,
        supportedReasoning: capabilities.reasoningControl ? family.efforts : [],
        defaultReasoning: capabilities.reasoningControl ? family.defaultReasoning : undefined,
        inputModalities: ['text', 'image'],
        availability: 'available',
        source: 'discovered',
        routeLabel: 'Antigravity CLI · live catalog',
        isDefault: activeFamily?.id === family.id,
        entitlement: 'Available to the connected Antigravity account',
        discoveredAt: new Date().toISOString(),
      }));

      if (!activeFamily) {
        models.unshift({
          catalogId: `${this.id}:${profileId}:antigravity-active-route`,
          runtimeId: this.runtimeType,
          accountProfileId: profileId,
          providerId: activeModel ? this.providerFor(activeModel) : 'google',
          runtimeModelId: 'antigravity-active-route',
          displayName: activeModel ? this.displayName(activeModel) : 'Antigravity Active Model',
          description: 'Uses the sticky model currently selected inside Antigravity when the CLI does not expose its active route in result metadata.',
          supportedRoles: ALL_ROLES,
          supportedReasoning: capabilities.reasoningControl ? ['low', 'medium', 'high'] : [],
          inputModalities: ['text', 'image'],
          availability: 'available',
          source: 'discovered',
          routeLabel: 'Antigravity CLI · active route',
          isDefault: true,
          warning: activeModel ? undefined : 'The exact active model was not reported by print mode; choose a live catalog model for a deterministic route.',
          discoveredAt: new Date().toISOString(),
        });
      }
      return models;
    }

    const models: ModelDescriptor[] = [];
    const activeRouteId = activeModel || 'antigravity-active-route';
    models.push({
      catalogId: `${this.id}:${profileId}:${activeRouteId}`,
      runtimeId: this.runtimeType,
      accountProfileId: profileId,
      providerId: activeModel ? this.providerFor(activeModel) : 'google',
      runtimeModelId: activeRouteId,
      displayName: activeModel ? this.displayName(activeModel) : 'Antigravity Active Model',
      description: 'The sticky model currently selected inside Antigravity. Live model discovery was unavailable.',
      supportedRoles: ALL_ROLES,
      supportedReasoning: capabilities.reasoningControl ? ['low', 'medium', 'high'] : [],
      inputModalities: ['text', 'image'],
      availability: 'available',
      source: 'discovered',
      routeLabel: 'Antigravity CLI · active route',
      isDefault: true,
      warning: 'Live `agy models` discovery failed. Refresh routes after confirming the CLI is reachable.',
      discoveredAt: new Date().toISOString(),
    });

    for (const model of DOCUMENTED_MODELS) {
      if (activeModel && this.normalizeModelId(activeModel) === this.normalizeModelId(model.slug)) continue;
      models.push({
        catalogId: `${this.id}:${profileId}:${model.slug}`,
        runtimeId: this.runtimeType,
        accountProfileId: profileId,
        providerId: model.provider,
        runtimeModelId: model.slug,
        displayName: model.name,
        description: 'Fallback Antigravity model metadata. Refresh routes to replace this with the installed CLI catalog.',
        supportedRoles: ALL_ROLES,
        supportedReasoning: capabilities.reasoningControl ? model.efforts : [],
        inputModalities: ['text', 'image'],
        availability: capabilities.modelSelection ? 'unknown' : 'unavailable',
        source: 'documented',
        routeLabel: 'Antigravity CLI · fallback',
        entitlement: model.entitlement,
        warning: 'This entry is a fallback because live `agy models` discovery did not return a catalog.',
        discoveredAt: new Date().toISOString(),
      });
    }
    return models;
  }

  private extractModelId(stdout: string): string | undefined {
    const candidates: unknown[] = [];
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      try { candidates.push(JSON.parse(line)); } catch { /* Text output is allowed. */ }
    }
    const visit = (value: unknown, depth = 0): string | undefined => {
      if (!value || depth > 5) return undefined;
      if (Array.isArray(value)) {
        for (const item of value) { const found = visit(item, depth + 1); if (found) return found; }
        return undefined;
      }
      if (typeof value !== 'object') return undefined;
      const record = value as Record<string, unknown>;
      for (const key of ['model_id', 'modelId', 'model', 'reasoning_model']) {
        if (typeof record[key] === 'string' && record[key]) return record[key] as string;
      }
      for (const nested of Object.values(record)) { const found = visit(nested, depth + 1); if (found) return found; }
      return undefined;
    };
    for (const candidate of candidates) { const found = visit(candidate); if (found) return found; }
    return undefined;
  }

  private normalizeModelId(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  private displayName(value: string): string { return value.split(/[-_]/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : '').join(' '); }
  private providerFor(slug: string): Provider {
    const id = String(slug).toLowerCase();
    if (id.includes('claude')) return 'anthropic';
    if (id.includes('gemini')) return 'google';
    return 'local';
  }

  async discoverAccounts(): Promise<AccountProfile[]> { return []; }
  async discoverUsage(): Promise<UsageSnapshot | null> { return null; }

  async startSession(request: StartSessionRequest): Promise<AgentSession> {
    const session: AgentSession = { id: crypto.randomUUID(), agentInstanceId: request.model, runtimeSessionId: '', startedAt: new Date().toISOString(), endedAt: null };
    this.activeSessions.set(session.id, session);
    return session;
  }

  async sendInput(sessionId: string, input: AgentInput): Promise<void> {
    const child = this.activeProcesses.get(sessionId);
    if (!child?.stdin || child.killed || child.stdin.destroyed || child.stdin.writableEnded) throw new Error(`Antigravity session ${sessionId} is not interactive.`);
    child.stdin.write(`${input.content}\n`);
  }

  async *streamEvents(sessionId: string): AsyncIterable<AgentEvent> {
    if (!this.eventBus) return;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.eventBus.on('*', (event) => {
      if ((event as any).agentInstanceId !== sessionId) return;
      queue.push(event); wake?.(); wake = undefined;
    });
    try {
      while (this.activeSessions.has(sessionId) || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally { unsubscribe(); }
  }

  async respondToApproval(_requestId: string, _decision: ApprovalDecision): Promise<void> {
    throw new Error('Antigravity print-mode permission decisions are controlled by its persisted permissions policy; interactive approval bridging is not available yet.');
  }

  private async resolveRequestedModelRoute(executable: string, model: string, reasoning?: string): Promise<string> {
    if (model === 'antigravity-active-route') return model;
    let families = this.liveModelFamilies;
    if (!families.length || !families.some((family) => family.id === model || Object.values(family.routes).includes(model))) {
      const discovered = await this.discoverLiveModelFamilies(executable);
      if (discovered.length) families = discovered;
    }
    return resolveAntigravityModelRoute(families, model, reasoning);
  }

  async spawnAgent(options: SpawnAgentOptions): Promise<AgentSession> {
    const capabilities = await this.probeCapabilities();
    if (!capabilities.structuredEventStreaming) {
      throw new Error('Antigravity 1.1.8 or newer with print-mode `stream-json` is required for background agents.');
    }
    const install = await this.discoverInstallation();
    if (!install.installed || !install.path) throw new Error(install.error || 'Antigravity CLI was not found.');

    const sessionId = options.sessionId || crypto.randomUUID();
    const workspaceCwd = options.worktreePath || options.cwd || process.cwd();
    const controlPlane = prepareControlPlaneSession(options, sessionId);
    const overlay = createAntigravityMcpOverlay(controlPlane, sessionId, workspaceCwd);
    const cwd = overlay?.cwd || workspaceCwd;
    const prompt = appendControlPlaneInstructions(options.prompt, controlPlane, workspaceCwd);
    const printTimeout = resolveAntigravityPrintTimeout(options.env?.ATRIS_ANTIGRAVITY_PRINT_TIMEOUT);
    const modelRoute = options.model && capabilities.modelSelection
      ? await this.resolveRequestedModelRoute(install.path, options.model, options.reasoningLevel)
      : options.model;
    const args = [
      '--print',
      prompt,
      '--output-format',
      'stream-json',
      '--sandbox',
      '--print-timeout',
      printTimeout,
    ];
    if (overlay) args.push(...overlay.extraArgs);
    if (modelRoute && modelRoute !== 'antigravity-active-route' && capabilities.modelSelection) args.push('--model', modelRoute);
    const routeEncodesReasoning = Boolean(modelRoute && /-(?:minimal|low|medium|high|xhigh|max)$/i.test(modelRoute));
    if (options.reasoningLevel && capabilities.reasoningControl && !routeEncodesReasoning) args.push('--effort', options.reasoningLevel);

    const session: AgentSession = { id: sessionId, agentInstanceId: sessionId, runtimeSessionId: '', startedAt: new Date().toISOString(), endedAt: null };
    let child;
    try {
      child = await spawnHiddenChecked(install.path, args, {
        cwd,
        env: {
          ...process.env,
          ...options.env,
          ...controlPlaneEnv(controlPlane),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      overlay?.cleanup();
      revokeControlPlaneAgent(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Antigravity process launch failed: ${message}`, { cause: error });
    }

    this.activeSessions.set(sessionId, session);
    this.sessionContext.set(sessionId, { missionId: options.missionId, taskId: options.taskId });
    this.terminalSessions.delete(sessionId);
    this.publishedTerminalSessions.delete(sessionId);
    this.pendingTerminalBySession.delete(sessionId);
    this.clearSoftTerminalCandidate(sessionId);
    this.clearTerminalRelease(sessionId);
    this.lastOutputBySession.delete(sessionId);
    this.stderrBuffers.delete(sessionId);
    this.registerProcess(sessionId, child);
    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'agent_started',
      missionId: options.missionId,
      agentInstanceId: sessionId,
      role: String(options.role || 'builder'),
      model: modelRoute || options.model || 'Antigravity active model',
      taskId: options.taskId,
      workspaceMode: options.isolated ? 'isolated_worktree' : options.role === 'orchestrator' ? 'shared' : 'read_only',
      timestamp: new Date().toISOString(),
    });

    let buffer = '';
    let finalized = false;
    let exitFinalizeTimer: ReturnType<typeof setTimeout> | undefined;

    const flushBufferedOutput = () => {
      if (!buffer.trim()) return;
      this.handleStreamLine(sessionId, buffer);
      buffer = '';
    };

    const finalizeNativeSession = (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (finalized) return;
      finalized = true;
      if (exitFinalizeTimer) clearTimeout(exitFinalizeTimer);
      this.clearSoftTerminalCandidate(sessionId);
      this.clearTerminalRelease(sessionId);
      flushBufferedOutput();
      this.recordProcessTerminationOutcome(sessionId, code, signal);

      const context = this.sessionContext.get(sessionId);
      const outcome = this.pendingTerminalBySession.get(sessionId);

      this.unregisterProcess(sessionId);
      session.endedAt = new Date().toISOString();
      this.activeSessions.delete(sessionId);
      overlay?.cleanup();
      revokeControlPlaneAgent(sessionId);
      this.sessionContext.delete(sessionId);
      this.stderrBuffers.delete(sessionId);
      this.lastOutputBySession.delete(sessionId);
      this.pendingTerminalBySession.delete(sessionId);
      this.terminalSessions.delete(sessionId);

      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.stdout?.destroy();
      child.stderr?.destroy();

      if (context && outcome) this.emitTerminalOutcome(sessionId, context, outcome);
      this.clearSessionCancellation(sessionId);
      this.publishedTerminalSessions.delete(sessionId);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) this.handleStreamLine(sessionId, line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const previous = this.stderrBuffers.get(sessionId) || '';
      const next = `${previous}${redactSecrets(chunk.toString('utf8'))}`;
      this.stderrBuffers.set(sessionId, next.slice(-MAX_STDERR_CHARS));
    });
    child.on('error', (error) => {
      this.recordTerminalOutcome(sessionId, {
        kind: 'failed',
        error: redactSecrets(error.message),
      });
    });
    child.on('exit', (code, signal) => {
      exitFinalizeTimer = setTimeout(() => finalizeNativeSession(code, signal), PROCESS_EXIT_STREAM_DRAIN_MS);
      exitFinalizeTimer.unref?.();
    });
    child.on('close', (code, signal) => {
      finalizeNativeSession(code, signal);
    });
    return session;
  }

  private handleStreamLine(sessionId: string, line: string): void {
    const context = this.sessionContext.get(sessionId);
    if (!context || this.isSessionCancelled(sessionId) || !line.trim()) return;
    const parsed = parseAntigravityStreamLine(line);
    const softTerminalResult = this.softTerminalResultsBySession.get(sessionId);
    this.clearSoftTerminalCandidate(sessionId);
    const timestamp = new Date().toISOString();

    if (parsed.kind === 'malformed') {
      if (softTerminalResult !== undefined) this.scheduleSoftTerminalCandidate(sessionId, softTerminalResult);
      return;
    }
    if (parsed.kind === 'unknown') {
      if (softTerminalResult !== undefined) this.scheduleSoftTerminalCandidate(sessionId, softTerminalResult);
      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'agent_progressed',
        missionId: context.missionId,
        taskId: context.taskId,
        agentInstanceId: sessionId,
        progress: `Antigravity event: ${parsed.eventName || 'unknown'}`,
        timestamp,
      });
      return;
    }
    if (parsed.kind === 'init') {
      const session = this.activeSessions.get(sessionId);
      if (session && parsed.conversationId) session.runtimeSessionId = parsed.conversationId;
      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'agent_progressed',
        missionId: context.missionId,
        taskId: context.taskId,
        agentInstanceId: sessionId,
        progress: 'Antigravity session initialized',
        timestamp,
      });
      return;
    }
    if (parsed.kind === 'step') {
      const stepType = parsed.stepType.toLowerCase();
      const isFinalResponseCandidate = /(?:^|[_-])(?:agent|final)[_-]?response(?:$|[_-])/.test(stepType)
        && /^(?:done|completed|success|succeeded)$/i.test(parsed.state || '');
      if (/thought|reason|plan/.test(stepType) && parsed.content) {
        this.emitEvent({ id: crypto.randomUUID(), type: 'agent_thought', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, thought: parsed.content, timestamp });
      } else if (/tool|command|shell|subagent/.test(stepType)) {
        this.emitEvent({ id: crypto.randomUUID(), type: 'agent_tool_call', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, toolName: parsed.toolName || parsed.stepType, args: parsed.args || {}, ...antigravityCorrelationFields(parsed.raw), timestamp });
      } else if (parsed.content) {
        this.lastOutputBySession.set(sessionId, parsed.content);
        this.emitEvent({ id: crypto.randomUUID(), type: 'text_delta', missionId: context.missionId, agentInstanceId: sessionId, content: parsed.content, timestamp });
      } else if (parsed.state) {
        this.emitEvent({ id: crypto.randomUUID(), type: 'agent_progressed', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, progress: `${parsed.stepType}: ${parsed.state}`, timestamp });
      }

      if (isFinalResponseCandidate) {
        const candidateResult = parsed.content || this.lastOutputBySession.get(sessionId) || 'Antigravity task completed';
        this.scheduleSoftTerminalCandidate(sessionId, candidateResult);
      }
      return;
    }
    if (parsed.kind === 'result') {
      this.recordProviderUsage(sessionId, parsed.raw);
      if (this.terminalSessions.has(sessionId)) return;
      if (!parsed.success) {
        this.recordTerminalOutcome(sessionId, {
          kind: 'failed',
          error: redactSecrets(parsed.error || `Antigravity task failed${parsed.status ? ` (${parsed.status})` : ''}`),
        });
        return;
      }
      if (parsed.content && parsed.content !== this.lastOutputBySession.get(sessionId)) {
        this.lastOutputBySession.set(sessionId, parsed.content);
        this.emitEvent({ id: crypto.randomUUID(), type: 'text_delta', missionId: context.missionId, agentInstanceId: sessionId, content: parsed.content, timestamp });
      }
      this.recordTerminalOutcome(sessionId, {
        kind: 'completed',
        result: parsed.content || this.lastOutputBySession.get(sessionId) || 'Antigravity task completed',
      });
    }
  }

  private clearSoftTerminalCandidate(sessionId: string): void {
    const timer = this.softTerminalTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.softTerminalTimers.delete(sessionId);
    this.softTerminalResultsBySession.delete(sessionId);
  }

  private clearTerminalRelease(sessionId: string): void {
    const timer = this.terminalReleaseTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.terminalReleaseTimers.delete(sessionId);
  }

  private cleanupSessionState(sessionId: string): void {
    this.clearSoftTerminalCandidate(sessionId);
    this.clearTerminalRelease(sessionId);
    this.activeProcesses.delete(sessionId);
    this.activeSessions.delete(sessionId);
    this.sessionContext.delete(sessionId);
    this.terminalSessions.delete(sessionId);
    this.publishedTerminalSessions.delete(sessionId);
    this.pendingTerminalBySession.delete(sessionId);
    this.lastOutputBySession.delete(sessionId);
    this.stdoutBuffers.delete(sessionId);
    this.stderrBuffers.delete(sessionId);
    revokeControlPlaneAgent(sessionId);
  }

  private cleanupAllSessionState(): void {
    for (const timer of this.softTerminalTimers.values()) clearTimeout(timer);
    for (const timer of this.terminalReleaseTimers.values()) clearTimeout(timer);
    for (const sessionId of this.sessionContext.keys()) revokeControlPlaneAgent(sessionId);
    this.sessionContext.clear();
    this.terminalSessions.clear();
    this.publishedTerminalSessions.clear();
    this.pendingTerminalBySession.clear();
    this.lastOutputBySession.clear();
    this.softTerminalTimers.clear();
    this.softTerminalResultsBySession.clear();
    this.terminalReleaseTimers.clear();
    this.stdoutBuffers.clear();
    this.stderrBuffers.clear();
  }

  private scheduleSoftTerminalCandidate(sessionId: string, result: string): void {
    this.clearSoftTerminalCandidate(sessionId);
    this.softTerminalResultsBySession.set(sessionId, result);
    const timer = setTimeout(() => {
      this.promoteSoftTerminalCandidate(sessionId, result);
    }, FINAL_RESPONSE_QUIET_GRACE_MS);
    timer.unref?.();
    this.softTerminalTimers.set(sessionId, timer);
  }

  private promoteSoftTerminalCandidate(sessionId: string, result: string): void {
    this.clearSoftTerminalCandidate(sessionId);
    if (this.terminalSessions.has(sessionId) || !this.sessionContext.has(sessionId)) return;
    const child = this.activeProcesses.get(sessionId);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    this.recordTerminalOutcome(sessionId, {
      kind: 'completed',
      result: result.trim() || this.lastOutputBySession.get(sessionId)?.trim() || 'Antigravity task completed',
    });
  }

  private recordProcessTerminationOutcome(
    sessionId: string,
    code: number | null,
    signal: NodeJS.Signals | null = null,
  ): void {
    if (this.terminalSessions.has(sessionId) || this.isSessionCancelled(sessionId)) return;

    const stderr = this.stderrBuffers.get(sessionId)?.trim();
    const detail = stderr ? `\n${stderr}` : '';
    if (code === 0) {
      const result = this.lastOutputBySession.get(sessionId)?.trim() || 'Antigravity task completed';
      this.recordTerminalOutcome(sessionId, { kind: 'completed', result }, false);
      return;
    }

    const reason = signal
      ? `Antigravity terminated by signal ${signal}.${detail}`
      : `Antigravity exited with code ${code}.${detail}`;
    this.recordTerminalOutcome(sessionId, {
      kind: 'failed',
      error: redactSecrets(reason),
      exitCode: code,
    }, false);
  }

  private recordTerminalOutcome(
    sessionId: string,
    outcome: PendingTerminalOutcome,
    requestShutdown = true,
  ): void {
    if (this.terminalSessions.has(sessionId) || this.isSessionCancelled(sessionId)) return;
    this.clearSoftTerminalCandidate(sessionId);
    this.terminalSessions.add(sessionId);
    this.pendingTerminalBySession.set(sessionId, outcome);
    if (requestShutdown) {
      this.requestTerminalProcessShutdown(sessionId);
      this.scheduleTerminalRelease(sessionId);
    }
  }

  private scheduleTerminalRelease(sessionId: string): void {
    this.clearTerminalRelease(sessionId);
    const timer = setTimeout(() => {
      this.terminalReleaseTimers.delete(sessionId);
      const context = this.sessionContext.get(sessionId);
      const outcome = this.pendingTerminalBySession.get(sessionId);
      if (context && outcome) this.emitTerminalOutcome(sessionId, context, outcome);
    }, TERMINAL_RELEASE_GRACE_MS);
    timer.unref?.();
    this.terminalReleaseTimers.set(sessionId, timer);
  }

  private requestTerminalProcessShutdown(sessionId: string): void {
    const child = this.activeProcesses.get(sessionId);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();

    const terminate = setTimeout(() => {
      const active = this.activeProcesses.get(sessionId);
      if (!active || active.exitCode !== null || active.signalCode !== null) return;
      active.kill('SIGTERM');

      const forceKill = setTimeout(() => {
        const stillActive = this.activeProcesses.get(sessionId);
        if (!stillActive || stillActive.exitCode !== null || stillActive.signalCode !== null) return;
        stillActive.kill('SIGKILL');
      }, TERMINAL_FORCE_KILL_MS);
      forceKill.unref?.();
    }, TERMINAL_EXIT_GRACE_MS);
    terminate.unref?.();
  }

  private emitTerminalOutcome(
    sessionId: string,
    context: { missionId: string; taskId: string },
    outcome: PendingTerminalOutcome,
  ): void {
    if (this.publishedTerminalSessions.has(sessionId) || this.isSessionCancelled(sessionId)) return;
    this.publishedTerminalSessions.add(sessionId);
    const timestamp = new Date().toISOString();
    if (outcome.kind === 'completed') {
      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'task_completed',
        missionId: context.missionId,
        taskId: context.taskId,
        agentInstanceId: sessionId,
        result: outcome.result,
        timestamp,
      });
      return;
    }

    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'task_failed',
      missionId: context.missionId,
      taskId: context.taskId,
      agentInstanceId: sessionId,
      error: outcome.error,
      exitCode: outcome.exitCode,
      timestamp,
    });
  }
}

function identifierValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function antigravityCorrelationFields(
  raw: Record<string, any>,
): { toolCallId?: string; runId?: string; attemptId?: string } {
  const stepUpdate = recordValue(raw.step_update);
  const step = Object.keys(stepUpdate).length ? stepUpdate : raw;
  const nestedStep = recordValue(step.step);
  const toolCallId = identifierValue(
    raw.step_id,
    raw.stepId,
    step.step_id,
    step.stepId,
    step.id,
    nestedStep.step_id,
    nestedStep.stepId,
    nestedStep.id,
    step.step_index,
    nestedStep.step_index,
  );
  const runId = identifierValue(
    raw.run_id,
    raw.runId,
    step.run_id,
    step.runId,
    nestedStep.run_id,
    nestedStep.runId,
  );
  const attemptId = identifierValue(
    raw.attempt_id,
    raw.attemptId,
    step.attempt_id,
    step.attemptId,
    nestedStep.attempt_id,
    nestedStep.attemptId,
  );
  return {
    ...(toolCallId ? { toolCallId } : {}),
    ...(runId ? { runId } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
}
