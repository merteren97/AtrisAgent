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

const ALL_ROLES: AgentRole[] = ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'];

// This list is a documented fallback only. Live account/runtime evidence always wins.
const DOCUMENTED_MODELS: DocumentedModel[] = [
  { slug: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'google', efforts: ['low', 'medium', 'high'], entitlement: 'Available on supported Antigravity plans' },
  { slug: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'google', efforts: ['low', 'high'], entitlement: 'Available on supported Antigravity plans' },
  { slug: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'google', efforts: ['low', 'medium', 'high'], entitlement: 'Available on supported Antigravity plans' },
  { slug: 'claude-sonnet-4.6-thinking', name: 'Claude Sonnet 4.6 (thinking)', provider: 'anthropic', efforts: ['high'], entitlement: 'Google AI Ultra / plan dependent' },
  { slug: 'claude-opus-4.6-thinking', name: 'Claude Opus 4.6 (thinking)', provider: 'anthropic', efforts: ['high'], entitlement: 'Google AI Ultra / plan dependent' },
  { slug: 'gpt-oss-120b', name: 'GPT-OSS-120b', provider: 'local', efforts: ['medium'], entitlement: 'Google AI Ultra / plan dependent' },
];

export class AntigravityAdapter extends BaseRuntimeAdapter {
  readonly id = 'antigravity';
  readonly name = 'Antigravity CLI';
  readonly runtimeType: RuntimeType = 'antigravity';

  private authFlows = new Map<string, PendingAuth>();
  private sessionContext = new Map<string, { missionId: string; taskId: string }>();
  private lastVerification?: { status: AccountProfileStatus; checkedAt: number; activeModel?: string; message?: string };

  constructor(eventBus?: LocalEventBus) {
    super(eventBus);
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
      interactiveApproval: /permissions|sandbox/.test(help),
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
  }

  async discoverModels(profileId = 'default'): Promise<ModelDescriptor[]> {
    if ((await this.verifyAuthentication()) !== 'connected') return [];
    const capabilities = await this.probeCapabilities();
    const activeModel = this.lastVerification?.activeModel;
    const models: ModelDescriptor[] = [];

    // Print-mode result metadata is not guaranteed to include a model identifier.
    // Even in that case the authenticated, sticky model selected in Antigravity is a
    // valid route; expose it explicitly instead of leaving the profile with 0 models.
    const activeRouteId = activeModel || 'antigravity-active-route';
    models.push({
      catalogId: `${this.id}:${profileId}:${activeRouteId}`,
      runtimeId: this.runtimeType,
      accountProfileId: profileId,
      providerId: activeModel ? this.providerFor(activeModel) : 'google',
      runtimeModelId: activeRouteId,
      displayName: activeModel ? this.displayName(activeModel) : 'Antigravity Active Model',
      description: activeModel
        ? 'Active model reported by the authenticated Antigravity print-mode session.'
        : 'The sticky model currently selected inside Antigravity. The CLI did not expose its exact identifier in result metadata.',
      supportedRoles: ALL_ROLES,
      supportedReasoning: capabilities.reasoningControl ? ['low', 'medium', 'high'] : [],
      inputModalities: ['text', 'image'],
      availability: 'available',
      source: 'discovered',
      routeLabel: 'Antigravity CLI · active route',
      isDefault: true,
      warning: activeModel ? undefined : 'Use /model inside Antigravity to change this sticky route; AtrisAgent will use the active selection.',
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
        description: 'Documented Antigravity model. Availability remains plan-dependent until the installed CLI proves the route.',
        supportedRoles: ALL_ROLES,
        supportedReasoning: capabilities.reasoningControl ? model.efforts : [],
        inputModalities: ['text', 'image'],
        availability: capabilities.modelSelection ? 'unknown' : 'unavailable',
        source: 'documented',
        routeLabel: 'Antigravity CLI',
        entitlement: model.entitlement,
        warning: capabilities.modelSelection
          ? 'Account entitlement is verified when the run starts.'
          : 'This CLI build does not expose a --model flag. Select the model with /model in Antigravity; AtrisAgent can use only the active route.',
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
    if (!child?.stdin || child.killed) throw new Error(`Antigravity session ${sessionId} is not interactive.`);
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
    const args = ['--print', prompt, '--output-format', 'stream-json', '--sandbox'];
    if (overlay) args.push(...overlay.extraArgs);
    if (options.model && options.model !== 'antigravity-active-route' && capabilities.modelSelection) args.push('--model', options.model);
    if (options.reasoningLevel && capabilities.reasoningControl) args.push('--effort', options.reasoningLevel);

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
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      overlay?.cleanup();
      revokeControlPlaneAgent(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Antigravity process launch failed: ${message}`, { cause: error });
    }

    // A session is not visible to the UI until the OS confirms the CLI process
    // exists. This prevents a Windows spawn ENOENT from creating ghost agents.
    this.activeSessions.set(sessionId, session);
    this.sessionContext.set(sessionId, { missionId: options.missionId, taskId: options.taskId });
    this.registerProcess(sessionId, child);
    this.emitEvent({ id: crypto.randomUUID(), type: 'agent_started', missionId: options.missionId, agentInstanceId: sessionId, role: String(options.role || 'builder'), model: options.model || 'Antigravity active model', timestamp: new Date().toISOString() });

    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) this.handleStreamLine(sessionId, line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const error = redactSecrets(chunk.toString('utf8'));
      if (error.trim()) this.emitAgentError(sessionId, error);
    });
    child.on('error', (error) => this.emitFailure(sessionId, error.message));
    child.on('close', (code) => {
      if (buffer.trim()) this.handleStreamLine(sessionId, buffer);
      this.unregisterProcess(sessionId);
      session.endedAt = new Date().toISOString();
      this.activeSessions.delete(sessionId);
      overlay?.cleanup();
      revokeControlPlaneAgent(sessionId);
      if (code !== 0) this.emitFailure(sessionId, `Antigravity exited with code ${code}`, code);
      this.sessionContext.delete(sessionId);
    });
    return session;
  }

  private handleStreamLine(sessionId: string, line: string): void {
    const context = this.sessionContext.get(sessionId);
    if (!context || !line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    const timestamp = new Date().toISOString();
    if (event.type === 'init') {
      const session = this.activeSessions.get(sessionId);
      if (session) session.runtimeSessionId = event.conversation_id || event.session_id || '';
      return;
    }
    if (event.type === 'step_update') {
      const stepType = event.step_type || event.step?.type || 'progress';
      const content = event.text || event.message || event.summary || event.step?.summary || '';
      if (/thought|reason|plan/.test(stepType) && content) this.emitEvent({ id: crypto.randomUUID(), type: 'agent_thought', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, thought: content, timestamp });
      else if (/tool|command|shell|subagent/.test(stepType)) this.emitEvent({ id: crypto.randomUUID(), type: 'agent_tool_call', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, toolName: event.tool_name || stepType, args: event.args || event.input || {}, timestamp });
      else if (content) this.emitEvent({ id: crypto.randomUUID(), type: 'text_delta', missionId: context.missionId, agentInstanceId: sessionId, content, timestamp });
      return;
    }
    if (event.type === 'result') {
      if (event.error || event.success === false) this.emitFailure(sessionId, event.error?.message || event.error || 'Antigravity task failed');
      else {
        const content = event.text || event.result || event.output;
        if (content) this.emitEvent({ id: crypto.randomUUID(), type: 'text_delta', missionId: context.missionId, agentInstanceId: sessionId, content: typeof content === 'string' ? content : JSON.stringify(content), timestamp });
        this.emitEvent({ id: crypto.randomUUID(), type: 'task_completed', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, result: 'Antigravity task completed', timestamp });
      }
    }
  }

  private emitAgentError(sessionId: string, error: string): void {
    const context = this.sessionContext.get(sessionId);
    if (!context) return;
    this.emitEvent({ id: crypto.randomUUID(), type: 'agent_error', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, error: redactSecrets(error), timestamp: new Date().toISOString() });
  }

  private emitFailure(sessionId: string, error: string, exitCode?: number | null): void {
    const context = this.sessionContext.get(sessionId);
    if (!context) return;
    this.emitEvent({ id: crypto.randomUUID(), type: 'task_failed', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, error: redactSecrets(error), exitCode, timestamp: new Date().toISOString() });
  }
}
