import type { ChildProcess } from 'child_process';
import { StringDecoder } from 'node:string_decoder';
import readline from 'readline';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import { CODEX_PERMISSION_MODES } from '@atris-agent-code/domain';
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
  CodexPermissionMode,
  ProviderAttachment,
  RuntimeAdapterCapabilities,
} from '@atris-agent-code/domain';
import {
  BaseRuntimeAdapter,
  isReadOnlyAgentRole,
  validateLocalAttachments,
  type SessionContinuityCapabilities,
  type SpawnAgentOptions,
} from './base-adapter';
import {
  appendControlPlaneInstructions,
  codexControlPlaneArgs,
  controlPlaneEnv,
  prepareControlPlaneSession,
  revokeControlPlaneAgent,
} from '../control-plane';
import {
  findExecutable,
  getHelpText,
  getRuntimeProfileDir,
  redactSecrets,
  runCommand,
  runtimeProfileEnv,
  spawnHidden,
  terminateProcessTree,
} from '../runtime-utils';

const MAX_AUTH_OUTPUT_CHARS = 32_768;
const MAX_STREAM_BUFFER_CHARS = 2 * 1024 * 1024;
const APP_SERVER_RPC_TIMEOUT_MS = 15_000;

interface PendingRpcRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingApprovalRequest {
  rpcId: string | number;
  method: string;
  params: Record<string, any>;
}

interface AppServerSessionState {
  sessionId: string;
  child: ChildProcess;
  missionId: string;
  taskId: string;
  cwd: string;
  profileId?: string;
  preserveProviderSession: boolean;
  threadId?: string;
  activeTurnId?: string;
  finalMessage?: string;
  rpcCounter: number;
  closed: boolean;
  pendingRpc: Map<string, PendingRpcRequest>;
  pendingApprovals: Map<string, PendingApprovalRequest>;
  cleanupControlPlane: () => void;
}

interface PendingAuth {
  process?: ChildProcess;
  profileId?: string;
  output: string;
  error?: string;
}

interface CodexRpcModel {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string; effort?: string }> | string[];
  defaultReasoningEffort?: string;
  inputModalities?: string[];
  hidden?: boolean;
  isDefault?: boolean;
  upgrade?: { model?: string } | null;
}

export class CodexAdapter extends BaseRuntimeAdapter {
  readonly id = 'codex';
  readonly name = 'Codex CLI';
  readonly runtimeType: RuntimeType = 'codex';

  private authFlows = new Map<string, PendingAuth>();
  private sessionContext = new Map<string, { missionId: string; taskId: string }>();
  private terminalSessions = new Set<string>();
  private finalMessages = new Map<string, string>();
  private fallbackToolEventSequence = new Map<string, number>();
  private appServerBySession = new Map<string, AppServerSessionState>();
  private reusableAppServers = new Map<string, AppServerSessionState>();

  constructor(
    eventBus?: LocalEventBus,
    private readonly spawnProcess: typeof spawnHidden = spawnHidden,
  ) {
    super(eventBus);
  }

  private env(profileId?: string): NodeJS.ProcessEnv {
    return { ...runtimeProfileEnv(this.runtimeType, profileId) };
  }

  async discoverInstallation(): Promise<InstallationStatus> {
    const executable = await findExecutable('codex');
    if (!executable) return { installed: false, error: 'Codex CLI executable was not found in PATH.' };
    try {
      const version = (await runCommand(executable, ['--version'], { timeoutMs: 8_000 })).stdout.trim();
      return { installed: true, path: executable, version: version || undefined };
    } catch (error: any) {
      return { installed: true, path: executable, error: error?.message || 'Could not read Codex version.' };
    }
  }

  override getSessionContinuityCapabilities(): SessionContinuityCapabilities {
    return { reuseWhileAlive: true, resumeAfterRestart: true };
  }

  override getAdapterCapabilities(): RuntimeAdapterCapabilities {
    return {
      liveSteer: true,
      interactiveApproval: true,
      sessionResume: true,
      reuseWhileAlive: true,
      nativeAttachments: true,
    };
  }

  async probeCapabilities(profileId?: string): Promise<CapabilitySnapshot> {
    const install = await this.discoverInstallation();
    if (!install.installed) return this.emptyCapabilities();
    const help = (await getHelpText('codex', this.env(profileId))).toLowerCase();
    const execHelp = await this.commandHelp(['exec', '--help'], profileId);
    const appServerHelp = await this.commandHelp(['app-server', '--help'], profileId);
    const supportsAppServer = /app-server/.test(help) || /--stdio\b|app-server/.test(appServerHelp);
    return {
      structuredEventStreaming: /--json\b/.test(execHelp) || supportsAppServer,
      sessionResume: /resume/.test(execHelp) || /resume/.test(help) || supportsAppServer,
      modelSelection: /--model\b/.test(execHelp) || /-m,?\s+--model/.test(execHelp) || supportsAppServer,
      reasoningControl: /reasoning/.test(help) || /reasoning/.test(execHelp) || supportsAppServer,
      toolCallEvents: /--json\b/.test(execHelp) || supportsAppServer,
      interactiveApproval: supportsAppServer,
      usageInfo: /--json\b/.test(execHelp) || supportsAppServer,
      cancellation: true,
      worktreeAwareness: true,
      headlessAuth: /device-auth|with-api-key|with-access-token/.test(help),
      nativeSubAgent: false,
    };
  }

  private emptyCapabilities(): CapabilitySnapshot {
    return {
      structuredEventStreaming: false,
      sessionResume: false,
      modelSelection: false,
      reasoningControl: false,
      toolCallEvents: false,
      interactiveApproval: false,
      usageInfo: false,
      cancellation: false,
      worktreeAwareness: false,
      headlessAuth: false,
      nativeSubAgent: false,
    };
  }

  private async commandHelp(args: string[], profileId?: string): Promise<string> {
    try {
      const result = await runCommand('codex', args, { env: this.env(profileId), timeoutMs: 8_000 });
      return `${result.stdout}\n${result.stderr}`.toLowerCase();
    } catch (error: any) {
      return `${error?.stdout || ''}\n${error?.stderr || ''}`.toLowerCase();
    }
  }

  async getAuthMethods(): Promise<AuthMethodDescriptor[]> {
    return [
      { id: 'chatgpt_browser', name: 'ChatGPT subscription', type: 'browser', description: 'Runs the official `codex login` browser sign-in flow.' },
      { id: 'device_code', name: 'Device-code sign-in', type: 'oauth', description: 'Runs `codex login --device-auth` for SSH or browser callback limitations.' },
      { id: 'api_key', name: 'OpenAI API key', type: 'api_key', description: 'Pipes the key to the official `codex login --with-api-key` command. AtrisAgent does not persist it.' },
      { id: 'access_token', name: 'Access token', type: 'api_key', description: 'Pipes a token to `codex login --with-access-token`. AtrisAgent does not persist it.' },
    ];
  }

  async beginAuthentication(method = 'chatgpt_browser', options: Record<string, unknown> = {}): Promise<AuthInitiationResult> {
    const install = await this.discoverInstallation();
    const authId = crypto.randomUUID();
    if (!install.installed) return { authId, method, status: 'failed', instructions: install.error };

    const profileId = typeof options.profileId === 'string' ? options.profileId : undefined;
    const args = ['login'];
    let input: string | undefined;
    if (method === 'device_code') args.push('--device-auth');
    if (method === 'api_key') {
      args.push('--with-api-key');
      input = typeof options.secret === 'string' ? options.secret : undefined;
    }
    if (method === 'access_token') {
      args.push('--with-access-token');
      input = typeof options.secret === 'string' ? options.secret : undefined;
    }
    if ((method === 'api_key' || method === 'access_token') && !input) {
      return { authId, method, status: 'failed', instructions: 'A secret value is required and will only be piped to the official Codex login process.' };
    }

    const child = spawnHidden('codex', args, {
      env: { ...process.env, ...this.env(profileId) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const flow: PendingAuth = { process: child, profileId, output: '' };
    this.authFlows.set(authId, flow);
    const appendAuthOutput = (chunk: Buffer | string) => {
      flow.output += redactSecrets(chunk.toString());
      if (flow.output.length > MAX_AUTH_OUTPUT_CHARS) {
        flow.output = flow.output.slice(-MAX_AUTH_OUTPUT_CHARS);
      }
    };
    child.stdout?.on('data', appendAuthOutput);
    child.stderr?.on('data', appendAuthOutput);
    child.on('error', (error) => { flow.error = error.message; });
    child.on('close', (code) => {
      if (code !== 0 && !flow.error) flow.error = `Codex login exited with code ${code}`;
    });
    if (input) child.stdin?.end(`${input}\n`);

    return {
      authId,
      method,
      status: 'pending',
      instructions: method === 'device_code'
        ? 'Complete the URL and user-code instructions emitted by the official Codex CLI.'
        : method === 'chatgpt_browser'
          ? 'Complete the ChatGPT sign-in in the browser opened by Codex.'
          : 'The secret was passed directly to Codex through stdin and was not stored by AtrisAgent.',
    };
  }

  async pollAuthentication(authId: string): Promise<AuthPollResult> {
    const flow = this.authFlows.get(authId);
    if (!flow) return { authId, status: 'error', message: 'Authentication flow not found.' };
    const status = await this.verifyAuthentication(flow.profileId);
    if (status === 'connected') {
      if (flow.process) await terminateProcessTree(flow.process).catch(() => undefined);
      this.authFlows.delete(authId);
      return { authId, status, message: 'Codex login is connected.' };
    }
    return {
      authId,
      status: flow.error ? 'error' : 'awaiting_browser',
      message: flow.error || flow.output.trim().slice(-1_500) || 'Waiting for the official Codex login flow.',
    };
  }

  override async cancel(sessionId: string): Promise<void> {
    const appServer = this.appServerBySession.get(sessionId);
    if (appServer) {
      this.markSessionCancelled(sessionId);
      await this.closeAppServer(appServer);
      this.activeSessions.delete(sessionId);
      this.sessionContext.delete(sessionId);
      this.terminalSessions.delete(sessionId);
      this.finalMessages.delete(sessionId);
      this.fallbackToolEventSequence.delete(sessionId);
      return;
    }
    await super.cancel(sessionId);
  }

  override async shutdown(): Promise<void> {
    const flows = [...this.authFlows.values()];
    this.authFlows.clear();
    await Promise.all(flows.map((flow) => (flow.process ? terminateProcessTree(flow.process).catch(() => undefined) : Promise.resolve())));
    const servers = new Set<AppServerSessionState>([
      ...this.appServerBySession.values(),
      ...this.reusableAppServers.values(),
    ]);
    await Promise.all([...servers].map((state) => this.closeAppServer(state).catch(() => undefined)));
    this.appServerBySession.clear();
    this.reusableAppServers.clear();
    await super.shutdown();
  }

  override async probeProviderSession(providerSessionId: string): Promise<boolean> {
    const existing = this.reusableAppServers.get(providerSessionId);
    if (existing && !existing.closed && existing.child.exitCode === null && !existing.child.killed) {
      return true;
    }
    return Boolean(providerSessionId && typeof providerSessionId === 'string' && providerSessionId.trim());
  }

  override async releaseProviderSession(providerSessionId: string): Promise<void> {
    const existing = this.reusableAppServers.get(providerSessionId);
    this.reusableAppServers.delete(providerSessionId);
    if (existing) {
      await this.closeAppServer(existing).catch(() => undefined);
    }
  }

  async verifyAuthentication(profileId?: string): Promise<AccountProfileStatus> {
    const install = await this.discoverInstallation();
    if (!install.installed) return 'not_installed';
    try {
      await runCommand('codex', ['login', 'status'], { env: this.env(profileId), timeoutMs: 10_000 });
      return 'connected';
    } catch {
      return 'login_required';
    }
  }

  async logout(profileId?: string): Promise<void> {
    await runCommand('codex', ['logout'], { env: this.env(profileId), timeoutMs: 15_000 }).catch(() => undefined);
  }

  async discoverModels(profileId?: string): Promise<ModelDescriptor[]> {
    if ((await this.verifyAuthentication(profileId)) !== 'connected') return [];
    const models = await this.listModelsFromAppServer(profileId).catch(() => []);
    return models
      .filter((model) => !model.hidden)
      .map((model) => {
        const runtimeModelId = model.id || model.model || '';
        const efforts = (model.supportedReasoningEfforts || [])
          .map((item) => typeof item === 'string' ? item : item.reasoningEffort || item.effort)
          .filter(Boolean) as CanonicalReasoning[];
        return {
          catalogId: `${this.id}:${profileId || 'default'}:${runtimeModelId}`,
          runtimeId: this.runtimeType,
          accountProfileId: profileId || 'default',
          providerId: 'openai',
          runtimeModelId,
          displayName: model.displayName || runtimeModelId,
          description: model.description,
          supportedRoles: ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'],
          supportedReasoning: efforts,
          defaultReasoning: model.defaultReasoningEffort as CanonicalReasoning | undefined,
          inputModalities: model.inputModalities || ['text'],
          availability: 'available',
          source: 'discovered',
          isDefault: Boolean(model.isDefault),
          hidden: Boolean(model.hidden),
          replacementModelId: model.upgrade?.model,
          discoveredAt: new Date().toISOString(),
          routeLabel: 'Codex App Server',
        } satisfies ModelDescriptor;
      })
      .filter((model) => Boolean(model.runtimeModelId));
  }

  private async listModelsFromAppServer(profileId?: string): Promise<CodexRpcModel[]> {
    return new Promise((resolve, reject) => {
      const child = spawnHidden('codex', ['app-server'], {
        env: { ...process.env, ...this.env(profileId) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let settled = false;
      const rl = readline.createInterface({ input: child.stdout! });
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl.close();
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => {
          void terminateProcessTree(child).catch(() => undefined);
          reject(new Error('Codex app-server model discovery timed out.'));
        });
      }, 15_000);
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > MAX_AUTH_OUTPUT_CHARS) stderr = stderr.slice(-MAX_AUTH_OUTPUT_CHARS);
      });
      rl.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.id === 2) {
            settle(() => {
              void terminateProcessTree(child).catch(() => undefined);
              const result = message.result || {};
              resolve(result.data || result.models || result.items || []);
            });
          }
        } catch {
          // Ignore non-JSON diagnostic lines.
        }
      });
      child.on('error', (error) => {
        settle(() => reject(error));
      });
      child.on('close', (code) => {
        settle(() => reject(new Error(stderr || `Codex app-server exited with code ${code ?? 'null'} before returning model list.`)));
      });
      child.stdin?.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'AtrisAgent', version: '0.2.0' } } })}\n`);
      child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      child.stdin?.write(`${JSON.stringify({ id: 2, method: 'model/list', params: {} })}\n`);
    });
  }

  async discoverAccounts(): Promise<AccountProfile[]> {
    return [];
  }

  async discoverUsage(): Promise<UsageSnapshot | null> {
    return null;
  }

  async startSession(request: StartSessionRequest): Promise<AgentSession> {
    const session: AgentSession = {
      id: crypto.randomUUID(),
      agentInstanceId: request.model,
      runtimeSessionId: '',
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.activeSessions.set(session.id, session);
    return session;
  }

  async sendInput(sessionId: string, input: AgentInput): Promise<void> {
    const appServer = this.appServerBySession.get(sessionId);
    if (appServer && !appServer.closed && appServer.child.exitCode === null && !appServer.child.killed && appServer.threadId) {
      const rpcInput = buildCodexTurnInput(
        input.content,
        (input as AgentInput & { attachments?: ProviderAttachment[] }).attachments,
      );
      if (appServer.activeTurnId) {
        await this.sendAppServerRpc(appServer, 'turn/steer', {
          threadId: appServer.threadId,
          expectedTurnId: appServer.activeTurnId,
          input: rpcInput,
        });
      } else {
        const result = await this.sendAppServerRpc(appServer, 'turn/start', {
          threadId: appServer.threadId,
          input: rpcInput,
        });
        if (result?.turn?.id) appServer.activeTurnId = String(result.turn.id);
      }
      return;
    }
    const child = this.activeProcesses.get(sessionId);
    if (!child?.stdin || child.killed) throw new Error(`Codex session ${sessionId} is not interactive.`);
    child.stdin.write(`${input.content}\n`);
  }

  async *streamEvents(sessionId: string): AsyncIterable<AgentEvent> {
    if (!this.eventBus) return;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.eventBus.on('*', (event) => {
      if ((event as any).agentInstanceId !== sessionId) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    });
    try {
      while (this.activeSessions.has(sessionId) || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      unsubscribe();
    }
  }

  async respondToApproval(
    requestIdOrSessionId?: string,
    decisionOrApprovalId?: ApprovalDecision | string,
    approvedOverride?: boolean,
  ): Promise<void> {
    let sessionId = '';
    let approvalId = '';
    let approved = false;
    if (typeof approvedOverride === 'boolean') {
      sessionId = String(requestIdOrSessionId || '');
      approvalId = String(decisionOrApprovalId || '');
      approved = approvedOverride;
    } else if (typeof requestIdOrSessionId === 'string' && requestIdOrSessionId.includes(':')) {
      const colonIdx = requestIdOrSessionId.indexOf(':');
      sessionId = requestIdOrSessionId.slice(0, colonIdx);
      approvalId = requestIdOrSessionId.slice(colonIdx + 1);
      approved = decisionOrApprovalId === 'approved';
    }
    const appServer = sessionId ? this.appServerBySession.get(sessionId) : undefined;
    const pending = appServer && approvalId ? appServer.pendingApprovals.get(approvalId) : undefined;
    if (!appServer || !pending || appServer.closed || !appServer.child.stdin || appServer.child.stdin.destroyed) {
      throw new Error('Codex exec approvals must be configured before the run; no pending interactive app-server approval request was found.');
    }
    appServer.pendingApprovals.delete(approvalId);
    this.writeAppServerMessage(appServer, {
      id: pending.rpcId,
      result: { decision: approved ? 'accept' : 'decline' },
    });
  }

  async spawnAgent(options: SpawnAgentOptions): Promise<AgentSession> {
    const permissionMode = planningPermissionMode(options);
    const capabilities = await this.probeCapabilities(options.profileId);
    if (!capabilities.structuredEventStreaming) {
      throw new Error('Installed Codex CLI does not expose `codex exec --json` or `codex app-server`; update Codex before running a background agent.');
    }
    if (permissionMode !== undefined) {
      await this.assertPlanningPermissionsSupported(permissionMode, options.profileId);
    }

    const sessionId = options.sessionId || crypto.randomUUID();
    const cwd = options.worktreePath || options.cwd || process.cwd();
    const model = options.model || '';

    // 1. Reuse an already-live app-server process if providerSessionId matches
    // before minting a new control-plane session grant.
    if (options.providerSessionId) {
      const reusable = this.reusableAppServers.get(options.providerSessionId);
      if (reusable && !reusable.closed && reusable.child.exitCode === null && !reusable.child.killed && reusable.threadId) {
        this.reusableAppServers.delete(options.providerSessionId);
        return await this.reuseAppServerSession(reusable, sessionId, options);
      }
    }

    // 2. Try persistent `codex app-server --stdio` JSON-RPC mode first.
    try {
      return await this.spawnAppServerAgent(sessionId, options, cwd, model, permissionMode);
    } catch (appServerError: any) {
      // Automatic fallback to one-shot `codex exec --json` ONLY when app-server
      // probe/startup fails before the session/turn has started.
      if (this.isSessionCancelled(sessionId) || !appServerError?.appServerStartupFailed) {
        throw appServerError;
      }
    }

    // 3. Fallback to one-shot `codex exec --json` with its own fresh control-plane grant.
    return await this.spawnExecFallbackAgent(sessionId, options, cwd, model);
  }

  private async reuseAppServerSession(
    state: AppServerSessionState,
    sessionId: string,
    options: SpawnAgentOptions,
  ): Promise<AgentSession> {
    const previousSessionId = state.sessionId;
    if (previousSessionId !== sessionId) {
      this.appServerBySession.delete(previousSessionId);
      this.activeProcesses.delete(previousSessionId);
    }
    state.sessionId = sessionId;
    state.missionId = options.missionId;
    state.taskId = options.taskId;
    state.preserveProviderSession = Boolean(options.preserveProviderSession);
    state.finalMessage = undefined;

    const session: AgentSession = {
      id: sessionId,
      agentInstanceId: sessionId,
      runtimeSessionId: state.threadId || options.providerSessionId || '',
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.activeSessions.set(sessionId, session);
    this.sessionContext.set(sessionId, { missionId: options.missionId, taskId: options.taskId });
    this.terminalSessions.delete(sessionId);
    this.finalMessages.delete(sessionId);
    this.fallbackToolEventSequence.set(sessionId, 0);
    this.appServerBySession.set(sessionId, state);
    this.registerProcess(sessionId, state.child);

    this.emitEvent({
      id: crypto.randomUUID(),
      type: 'agent_started',
      missionId: options.missionId,
      agentInstanceId: sessionId,
      role: String(options.role || 'builder'),
      model: options.model || 'Codex default',
      timestamp: new Date().toISOString(),
    });

    const turnResult = await this.sendAppServerRpc(state, 'turn/start', {
      threadId: state.threadId,
      input: buildCodexTurnInput(options.prompt, options.attachments),
    });
    if (turnResult?.turn?.id) state.activeTurnId = String(turnResult.turn.id);
    return session;
  }

  private async spawnAppServerAgent(
    sessionId: string,
    options: SpawnAgentOptions,
    cwd: string,
    model: string,
    permissionMode: CodexPermissionMode | undefined,
  ): Promise<AgentSession> {
    const controlPlane = prepareControlPlaneSession(options, sessionId);
    const prompt = appendControlPlaneInstructions(options.prompt, controlPlane, cwd);
    const args = buildCodexAppServerArgs(options, cwd, codexControlPlaneArgs(controlPlane), permissionMode);
    let child: ChildProcess;
    try {
      child = this.spawnProcess('codex', args, {
        cwd,
        env: {
          ...process.env,
          ...this.env(options.profileId),
          ...options.env,
          ...controlPlaneEnv(controlPlane),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      revokeControlPlaneAgent(sessionId);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { appServerStartupFailed: true });
    }

    const state: AppServerSessionState = {
      sessionId,
      child,
      missionId: options.missionId,
      taskId: options.taskId,
      cwd,
      profileId: options.profileId,
      preserveProviderSession: Boolean(options.preserveProviderSession),
      rpcCounter: 0,
      closed: false,
      pendingRpc: new Map(),
      pendingApprovals: new Map(),
      cleanupControlPlane: () => revokeControlPlaneAgent(sessionId),
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let startupCompleted = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += stdoutDecoder.write(chunk);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      if (stdoutBuffer.length > MAX_STREAM_BUFFER_CHARS) stdoutBuffer = stdoutBuffer.slice(-MAX_STREAM_BUFFER_CHARS);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          this.handleAppServerMessage(state, message);
        } catch {
          // Ignore non-JSON diagnostic lines.
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += stderrDecoder.write(chunk);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      if (stderrBuffer.length > MAX_STREAM_BUFFER_CHARS) stderrBuffer = stderrBuffer.slice(-MAX_STREAM_BUFFER_CHARS);
      if (startupCompleted) {
        for (const line of lines) this.handleDiagnosticLine(state.sessionId, line);
      }
    });

    child.on('error', (error) => {
      this.failPendingAppServerRpcs(state, error);
      if (startupCompleted) {
        this.emitFailure(state.sessionId, error.message);
      }
    });

    child.on('close', (code, signal) => {
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail) stdoutBuffer += stdoutTail;
      if (stdoutBuffer.trim()) {
        try {
          this.handleAppServerMessage(state, JSON.parse(stdoutBuffer));
        } catch {
          // Ignore trailing non-JSON text.
        }
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail) stderrBuffer += stderrTail;
      if (startupCompleted && stderrBuffer.trim()) {
        this.handleDiagnosticLine(state.sessionId, stderrBuffer);
      }
      const exitError = new Error(signal ? `Codex app-server terminated by signal ${signal}` : `Codex app-server exited with code ${code}`);
      this.failPendingAppServerRpcs(state, exitError);
      state.closed = true;
      if (state.threadId && this.reusableAppServers.get(state.threadId) === state) {
        this.reusableAppServers.delete(state.threadId);
      }
      if (startupCompleted) {
        this.unregisterProcess(state.sessionId);
        this.appServerBySession.delete(state.sessionId);
        const activeSession = this.activeSessions.get(state.sessionId);
        if (activeSession) {
          activeSession.endedAt = new Date().toISOString();
          this.activeSessions.delete(state.sessionId);
        }
        state.cleanupControlPlane();
        if (!this.terminalSessions.has(state.sessionId) && !this.isSessionCancelled(state.sessionId)) {
          this.handleProcessExit(state.sessionId, code, signal);
        }
        this.sessionContext.delete(state.sessionId);
        this.terminalSessions.delete(state.sessionId);
        this.finalMessages.delete(state.sessionId);
        this.fallbackToolEventSequence.delete(state.sessionId);
        this.clearSessionCancellation(state.sessionId);
      }
    });

    try {
      await this.sendAppServerRpc(state, 'initialize', {
        clientInfo: { name: 'AtrisAgent', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      });
      this.writeAppServerMessage(state, { method: 'initialized', params: {} });

      const sandbox = resolveCodexSandboxMode(options, permissionMode);
      const approvalPolicy = permissionMode === undefined || permissionMode === 'full-access' ? 'never' : 'on-request';
      const threadResult = options.providerSessionId
        ? await this.sendAppServerRpc(state, 'thread/resume', {
          threadId: options.providerSessionId,
          cwd,
          ...(model ? { model } : {}),
          approvalPolicy,
          sandbox,
        })
        : await this.sendAppServerRpc(state, 'thread/start', {
          cwd,
          ...(model ? { model } : {}),
          approvalPolicy,
          sandbox,
        });

      const threadId = String(threadResult?.thread?.id || threadResult?.threadId || '');
      if (!threadId) {
        throw new Error('Codex app-server did not return a thread id.');
      }
      state.threadId = threadId;

      const session: AgentSession = {
        id: sessionId,
        agentInstanceId: sessionId,
        runtimeSessionId: threadId,
        startedAt: new Date().toISOString(),
        endedAt: null,
      };

      startupCompleted = true;
      this.activeSessions.set(sessionId, session);
      this.sessionContext.set(sessionId, { missionId: options.missionId, taskId: options.taskId });
      this.fallbackToolEventSequence.set(sessionId, 0);
      this.appServerBySession.set(sessionId, state);
      this.registerProcess(sessionId, child);
      this.emitEvent({
        id: crypto.randomUUID(),
        type: 'agent_started',
        missionId: options.missionId,
        agentInstanceId: sessionId,
        role: String(options.role || 'builder'),
        model: model || 'Codex default',
        timestamp: new Date().toISOString(),
      });

      const turnResult = await this.sendAppServerRpc(state, 'turn/start', {
        threadId,
        input: buildCodexTurnInput(prompt, options.attachments),
      });
      if (turnResult?.turn?.id) state.activeTurnId = String(turnResult.turn.id);
      return session;
    } catch (error) {
      await this.closeAppServer(state).catch(() => undefined);
      this.appServerBySession.delete(sessionId);
      this.activeSessions.delete(sessionId);
      this.sessionContext.delete(sessionId);
      this.unregisterProcess(sessionId);
      if (!startupCompleted) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { appServerStartupFailed: true });
      }
      throw error;
    }
  }

  private async spawnExecFallbackAgent(
    sessionId: string,
    options: SpawnAgentOptions,
    cwd: string,
    model: string,
  ): Promise<AgentSession> {
    const controlPlane = prepareControlPlaneSession(options, sessionId);
    const prompt = appendControlPlaneInstructions(options.prompt, controlPlane, cwd);
    const args = buildCodexExecArgs(options, prompt, codexControlPlaneArgs(controlPlane));
    const session: AgentSession = {
      id: sessionId,
      agentInstanceId: sessionId,
      runtimeSessionId: '',
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.activeSessions.set(sessionId, session);
    this.sessionContext.set(sessionId, { missionId: options.missionId, taskId: options.taskId });
    this.fallbackToolEventSequence.set(sessionId, 0);

    let child: ChildProcess;
    try {
      child = this.spawnProcess('codex', args, {
        cwd,
        env: {
          ...process.env,
          ...this.env(options.profileId),
          ...options.env,
          ...controlPlaneEnv(controlPlane),
        },
        // `codex exec` receives the prompt as an argument. Keeping stdin open
        // makes some CLI versions wait for an additional prompt indefinitely.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.activeSessions.delete(sessionId);
      this.sessionContext.delete(sessionId);
      revokeControlPlaneAgent(sessionId);
      throw error;
    }
    this.registerProcess(sessionId, child);
    this.emitEvent({
      id: crypto.randomUUID(), type: 'agent_started', missionId: options.missionId,
      agentInstanceId: sessionId, role: String(options.role || 'builder'),
      model: model || 'Codex default', timestamp: new Date().toISOString(),
    });

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += stdoutDecoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      if (buffer.length > MAX_STREAM_BUFFER_CHARS) buffer = buffer.slice(-MAX_STREAM_BUFFER_CHARS);
      for (const line of lines) this.handleJsonLine(sessionId, line);
    });
    let stderrBuffer = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += stderrDecoder.write(chunk);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      if (stderrBuffer.length > MAX_STREAM_BUFFER_CHARS) stderrBuffer = stderrBuffer.slice(-MAX_STREAM_BUFFER_CHARS);
      for (const line of lines) this.handleDiagnosticLine(sessionId, line);
    });
    child.on('error', (error) => this.emitFailure(sessionId, error.message));
    child.on('close', (code, signal) => {
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail) buffer += stdoutTail;
      const stderrTail = stderrDecoder.end();
      if (stderrTail) stderrBuffer += stderrTail;
      if (buffer.trim()) this.handleJsonLine(sessionId, buffer);
      if (stderrBuffer.trim()) this.handleDiagnosticLine(sessionId, stderrBuffer);
      this.unregisterProcess(sessionId);
      session.endedAt = new Date().toISOString();
      this.activeSessions.delete(sessionId);
      revokeControlPlaneAgent(sessionId);
      this.handleProcessExit(sessionId, code, signal);
      this.sessionContext.delete(sessionId);
      this.terminalSessions.delete(sessionId);
      this.finalMessages.delete(sessionId);
      this.fallbackToolEventSequence.delete(sessionId);
      this.clearSessionCancellation(sessionId);
    });
    return session;
  }

  private async assertPlanningPermissionsSupported(mode: CodexPermissionMode, profileId?: string): Promise<void> {
    const help = await this.commandHelp(['exec', '--help'], profileId);
    if (!/--sandbox\b/.test(help) || !/--config\b/.test(help)) {
      throw new Error('Installed Codex exec does not expose --sandbox and --config required for planning permissions.');
    }
    // The native automatic-review option is capability evidence for auto_review;
    // do not infer its availability from a CLI version or silently use user/never.
    if (mode === 'approve-for-me' && !/--approve-for-me\b/.test(help)) {
      throw new Error('Installed Codex exec does not expose --approve-for-me required for automatic planning approval review.');
    }
  }

  private handleJsonLine(sessionId: string, line: string): void {
    const context = this.sessionContext.get(sessionId);
    if (!context || this.isSessionCancelled(sessionId) || !line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    const timestamp = new Date().toISOString();
    if (event.type === 'thread.started' && event.thread_id) {
      const session = this.activeSessions.get(sessionId);
      if (session) session.runtimeSessionId = event.thread_id;
      return;
    }
    if (event.type === 'item.completed' || event.type === 'item.started' || event.type === 'item.updated') {
      const item = event.item || {};
      if (item.type === 'agent_message' && item.text) {
        if (event.type === 'item.completed') this.finalMessages.set(sessionId, redactSecrets(item.text));
        this.emitEvent({ id: crypto.randomUUID(), type: 'text_delta', missionId: context.missionId, agentInstanceId: sessionId, content: item.text, timestamp });
      } else if (item.type === 'reasoning' && (item.text || item.summary)) {
        this.emitEvent({ id: crypto.randomUUID(), type: 'agent_thought', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, thought: item.text || item.summary, timestamp });
      } else if (item.type === 'command_execution') {
        if (event.type === 'item.started') {
          const correlation = codexCorrelationFields(event, item, this.toolCallIdForEvent(sessionId, event, item));
          this.emitEvent({ id: crypto.randomUUID(), type: 'tool_call_started', missionId: context.missionId, agentInstanceId: sessionId, toolName: 'shell', args: { command: item.command }, ...correlation, timestamp });
        } else if (event.type === 'item.completed') {
          const correlation = codexCorrelationFields(event, item, this.toolCallIdForEvent(sessionId, event, item));
          this.emitEvent({ id: crypto.randomUUID(), type: 'tool_call_completed', missionId: context.missionId, agentInstanceId: sessionId, toolName: 'shell', result: redactSecrets(item.aggregated_output || ''), success: item.exit_code === 0, ...correlation, timestamp });
        }
      } else if (item.type === 'mcp_tool_call') {
        const name = item.tool || item.name || 'mcp_tool';
        if (event.type === 'item.started') {
          const correlation = codexCorrelationFields(event, item, this.toolCallIdForEvent(sessionId, event, item));
          this.emitEvent({ id: crypto.randomUUID(), type: 'tool_call_started', missionId: context.missionId, agentInstanceId: sessionId, toolName: name, args: item.arguments || {}, ...correlation, timestamp });
        }
        if (event.type === 'item.completed') {
          const correlation = codexCorrelationFields(event, item, this.toolCallIdForEvent(sessionId, event, item));
          this.emitEvent({ id: crypto.randomUUID(), type: 'tool_call_completed', missionId: context.missionId, agentInstanceId: sessionId, toolName: name, result: redactSecrets(JSON.stringify(item.error ? { error: item.error, result: item.result } : item.result ?? '')), success: !item.error && item.result?.isError !== true, ...correlation, timestamp });
        }
      } else if (item.type === 'file_change') {
        for (const change of item.changes || []) {
          this.emitEvent({ id: crypto.randomUUID(), type: 'file_changed', missionId: context.missionId, taskId: context.taskId, path: change.path || 'unknown', changeType: change.kind || 'modified', additions: change.additions || 0, deletions: change.deletions || 0, timestamp });
        }
      }
      return;
    }
    if (event.type === 'turn.completed') {
      this.recordProviderUsage(sessionId, event, { accumulate: true });
      this.emitCompleted(sessionId, this.finalMessages.get(sessionId) || 'Codex turn completed');
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      this.recordProviderUsage(sessionId, event, { accumulate: true });
      this.emitFailure(sessionId, event.error?.message || event.message || 'Codex turn failed');
    }
  }

  private handleProcessExit(sessionId: string, code: number | null, signal: string | null): void {
    if (code === 0) this.emitFailure(sessionId, 'Codex exited without a turn.completed event; task completion could not be verified.', code);
    else this.emitFailure(sessionId, signal ? `Codex terminated by signal ${signal}` : `Codex exited with code ${code}`, code);
  }

  private handleDiagnosticLine(sessionId: string, line: string): void {
    const context = this.sessionContext.get(sessionId);
    if (!context || this.isSessionCancelled(sessionId)) return;
    const message = redactSecrets(line).trim();
    if (!message) return;
    // This is a CLI input notice, not a provider failure. Keep it out of the
    // task transcript as well: text_delta is consumed as worker output.
    if (/^Reading additional input (?:from|for prompt from) stdin\.{0,3}$/i.test(message)) return;
    this.emitEvent({
      id: crypto.randomUUID(), type: 'agent_error', missionId: context.missionId,
      taskId: context.taskId, agentInstanceId: sessionId, error: message,
      timestamp: new Date().toISOString(),
    });
  }

  private toolCallIdForEvent(sessionId: string, event: any, item: any): string {
    const providerId = identifierValue(
      item.id,
      item.call_id,
      item.callId,
      item.tool_call_id,
      item.toolCallId,
      item.provider_id,
      item.providerId,
      event.item_id,
      event.itemId,
      event.provider_id,
      event.providerId,
    );
    if (providerId) return providerId;

    // Without a provider item ID, keep the fallback event-scoped. Reusing it
    // for a later completion would assert a pairing the provider did not give us.
    const sequence = (this.fallbackToolEventSequence.get(sessionId) || 0) + 1;
    this.fallbackToolEventSequence.set(sessionId, sequence);
    return `codex:${sessionId}:${item.type}:${event.type}:${sequence}`;
  }

  private writeAppServerMessage(state: AppServerSessionState, message: Record<string, unknown>): void {
    if (state.closed || !state.child.stdin || state.child.stdin.destroyed) {
      throw new Error('Codex app-server stdin is closed.');
    }
    state.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendAppServerRpc(state: AppServerSessionState, method: string, params: Record<string, unknown>): Promise<any> {
    const id = `atris-rpc-${++state.rpcCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pendingRpc.delete(id);
        reject(new Error(`Codex app-server RPC '${method}' timed out.`));
      }, APP_SERVER_RPC_TIMEOUT_MS);
      state.pendingRpc.set(id, { resolve, reject, timer });
      try {
        this.writeAppServerMessage(state, { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        state.pendingRpc.delete(id);
        reject(error);
      }
    });
  }

  private failPendingAppServerRpcs(state: AppServerSessionState, error: Error): void {
    for (const pending of state.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pendingRpc.clear();
  }

  private async closeAppServer(state: AppServerSessionState): Promise<void> {
    if (state.closed) return;
    state.closed = true;
    this.failPendingAppServerRpcs(state, new Error('Codex app-server closed.'));
    state.pendingApprovals.clear();
    if (state.threadId && this.reusableAppServers.get(state.threadId) === state) {
      this.reusableAppServers.delete(state.threadId);
    }
    this.appServerBySession.delete(state.sessionId);
    this.unregisterProcess(state.sessionId);
    state.cleanupControlPlane();
    if (state.child.exitCode === null && !state.child.killed) {
      await terminateProcessTree(state.child, true).catch(() => undefined);
    }
  }

  private handleAppServerMessage(state: AppServerSessionState, message: Record<string, any>): void {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && !message.method) {
      const pending = state.pendingRpc.get(String(message.id));
      if (pending) {
        state.pendingRpc.delete(String(message.id));
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(String(message.error.message || `Codex app-server error (${message.error.code ?? 'unknown'})`)));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    const sessionId = state.sessionId;
    const context = this.sessionContext.get(sessionId);
    if (message.id !== undefined && typeof message.method === 'string') {
      if (message.method.includes('requestApproval') && context && !this.isSessionCancelled(sessionId)) {
        const approvalId = String(message.id);
        const params = message.params || {};
        state.pendingApprovals.set(approvalId, { rpcId: message.id, method: message.method, params });
        this.emitEvent({
          id: crypto.randomUUID(),
          type: 'approval_requested',
          missionId: context.missionId,
          taskId: context.taskId,
          agentInstanceId: sessionId,
          approvalId: `${sessionId}:${approvalId}`,
          approvalType: message.method.toLowerCase().includes('file') ? 'file_change' : 'command_execution',
          toolName: message.method.toLowerCase().includes('file') ? 'file_change' : 'shell',
          command: typeof params.command === 'string' ? params.command : Array.isArray(params.parsedCmd) ? params.parsedCmd.join(' ') : undefined,
          path: typeof params.path === 'string' ? params.path : typeof params.filePath === 'string' ? params.filePath : undefined,
          description: typeof params.reason === 'string' ? params.reason : typeof params.description === 'string' ? params.description : `Codex requested approval (${message.method})`,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    if (!context || this.isSessionCancelled(sessionId)) return;
    const method = String(message.method || '');
    const params = message.params || {};
    const timestamp = new Date().toISOString();

    if (method === 'turn/started') {
      state.activeTurnId = identifierValue(params.turn?.id, params.turnId) || state.activeTurnId || 'active';
      return;
    }
    if (method === 'item/agentMessage/delta' || method === 'agent_message_delta') {
      const delta = typeof params.delta === 'string' ? params.delta : typeof params.text === 'string' ? params.text : '';
      if (delta) {
        state.finalMessage = `${state.finalMessage || ''}${delta}`;
        this.emitEvent({ id: crypto.randomUUID(), type: 'text_delta', missionId: context.missionId, agentInstanceId: sessionId, content: delta, timestamp });
      }
      return;
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const thought = typeof params.delta === 'string' ? params.delta : typeof params.text === 'string' ? params.text : '';
      if (thought) {
        this.emitEvent({ id: crypto.randomUUID(), type: 'agent_thought', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, thought, timestamp });
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed' || method === 'item.started' || method === 'item.completed') {
      const normalizedType = method.replace('/', '.');
      this.handleJsonLine(sessionId, JSON.stringify({ type: normalizedType, ...params, item: normalizeAppServerItem(params.item || params) }));
      if (normalizedType === 'item.completed' && (params.item?.type === 'agentMessage' || params.item?.type === 'agent_message') && params.item?.text) {
        state.finalMessage = redactSecrets(String(params.item.text));
      }
      return;
    }
    if (method === 'turn/completed') {
      state.activeTurnId = undefined;
      this.recordProviderUsage(sessionId, params, { accumulate: true });
      const status = String(params.turn?.status || params.status || '').toLowerCase();
      if (status === 'failed') {
        this.emitFailure(sessionId, params.turn?.error?.message || params.error?.message || 'Codex turn failed');
      } else {
        this.emitCompleted(sessionId, state.finalMessage || params.turn?.finalMessage || this.finalMessages.get(sessionId) || 'Codex turn completed');
      }
      const session = this.activeSessions.get(sessionId);
      if (session) session.endedAt = timestamp;
      this.activeSessions.delete(sessionId);
      this.sessionContext.delete(sessionId);
      this.terminalSessions.delete(sessionId);
      this.finalMessages.delete(sessionId);
      this.fallbackToolEventSequence.delete(sessionId);
      if (state.preserveProviderSession && state.threadId) {
        this.reusableAppServers.set(state.threadId, state);
      } else {
        void this.closeAppServer(state);
      }
      return;
    }
    if (method === 'error' && !params.willRetry) {
      state.activeTurnId = undefined;
      this.emitFailure(sessionId, params.error?.message || params.message || 'Codex app-server error');
    }
  }

  private emitCompleted(sessionId: string, result: string): void {
    if (this.isSessionCancelled(sessionId) || this.terminalSessions.has(sessionId)) return;
    const context = this.sessionContext.get(sessionId);
    if (!context) return;
    this.terminalSessions.add(sessionId);
    this.emitEvent({ id: crypto.randomUUID(), type: 'task_completed', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, result, timestamp: new Date().toISOString() });
  }

  private emitFailure(sessionId: string, error: string, exitCode?: number | null): void {
    if (this.isSessionCancelled(sessionId) || this.terminalSessions.has(sessionId)) return;
    const context = this.sessionContext.get(sessionId);
    if (!context) return;
    this.terminalSessions.add(sessionId);
    this.emitEvent({ id: crypto.randomUUID(), type: 'task_failed', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, error: redactSecrets(error), exitCode, timestamp: new Date().toISOString() });
  }
}

export function resolveCodexSandboxMode(
  options: Pick<SpawnAgentOptions, 'accessMode' | 'role' | 'planningControls'>,
  explicitMode?: CodexPermissionMode,
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  const mode = explicitMode ?? planningPermissionMode(options);
  return mode === undefined
    ? options.accessMode || (isReadOnlyAgentRole(options.role) ? 'read-only' : 'workspace-write')
    : mode === 'read-only' ? 'read-only' : mode === 'full-access' ? 'danger-full-access' : 'workspace-write';
}

export function buildCodexAppServerArgs(
  options: Pick<SpawnAgentOptions, 'accessMode' | 'model' | 'reasoningLevel' | 'role' | 'planningControls'>,
  cwd: string,
  controlPlaneArgs: string[] = [],
  explicitMode?: CodexPermissionMode,
): string[] {
  const mode = explicitMode ?? planningPermissionMode(options);
  const sandbox = resolveCodexSandboxMode(options, mode);
  const approvalPolicy = mode === undefined || mode === 'full-access' ? 'never' : 'on-request';
  return [
    'app-server',
    '--stdio',
    ...controlPlaneArgs,
    ...(options.model ? ['-c', `model=${JSON.stringify(options.model)}`] : []),
    ...(options.reasoningLevel ? ['-c', `model_reasoning_effort=${JSON.stringify(options.reasoningLevel)}`] : []),
    '-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`,
    '-c', `sandbox_mode=${JSON.stringify(sandbox)}`,
    '-c', `approval_policy=${JSON.stringify(approvalPolicy)}`,
    ...(mode === undefined ? [] : ['-c', `approvals_reviewer=${JSON.stringify(mode === 'approve-for-me' ? 'auto_review' : 'user')}`]),
  ];
}

export function buildCodexTurnInput(
  prompt: string,
  attachments?: ProviderAttachment[],
): Array<Record<string, unknown>> {
  const valid = validateLocalAttachments(attachments);
  const nonImages = valid.filter((att) => !att.mimeType?.toLowerCase().startsWith('image/'));
  const textWithNonImages = nonImages.length
    ? `${prompt}\n\n[Attachments]\n${nonImages.map((att) => `- ${att.name} (${att.mimeType || 'application/octet-stream'}): ${att.providerPath}`).join('\n')}`
    : prompt;
  const items: Array<Record<string, unknown>> = [{ type: 'text', text: textWithNonImages }];
  for (const att of valid) {
    if (att.mimeType?.toLowerCase().startsWith('image/')) {
      items.push({ type: 'localImage', path: att.providerPath });
    }
  }
  return items;
}

function normalizeAppServerItem(item: Record<string, any>): Record<string, any> {
  if (!item || typeof item !== 'object') return {};
  const typeMap: Record<string, string> = {
    agentMessage: 'agent_message',
    commandExecution: 'command_execution',
    mcpToolCall: 'mcp_tool_call',
    fileChange: 'file_change',
  };
  return {
    ...item,
    type: typeMap[item.type] || item.type,
    aggregated_output: item.aggregated_output ?? item.aggregatedOutput,
    exit_code: item.exit_code ?? item.exitCode,
  };
}

export function buildCodexExecArgs(
  options: Pick<SpawnAgentOptions, 'accessMode' | 'model' | 'reasoningLevel' | 'role' | 'planningControls' | 'attachments'>,
  prompt: string,
  controlPlaneArgs: string[] = [],
): string[] {
  const mode = planningPermissionMode(options);
  // Planning's explicit sandbox preference overrides the role-derived default;
  // the researcher's read-only content instructions remain in the prompt.
  const accessMode = resolveCodexSandboxMode(options, mode);
  const validAttachments = validateLocalAttachments(options.attachments);
  const imageArgs: string[] = [];
  const nonImageLines: string[] = [];
  for (const att of validAttachments) {
    if (att.mimeType?.toLowerCase().startsWith('image/')) {
      imageArgs.push('--image', att.providerPath);
    } else {
      nonImageLines.push(`- ${att.name} (${att.mimeType || 'application/octet-stream'}): ${att.providerPath}`);
    }
  }
  const finalPrompt = nonImageLines.length ? `${prompt}\n\n[Attachments]\n${nonImageLines.join('\n')}` : prompt;
  const args = [
    'exec',
    '--json',
    '--sandbox',
    accessMode,
    '-c',
    `approval_policy="${mode === undefined || mode === 'full-access' ? 'never' : 'on-request'}"`,
    // exec has no --ask-for-approval flag. Match Manual through config overrides.
    // Requests needing a human cannot be answered in exec; never auto-bypass them.
    ...(mode === undefined ? [] : ['-c', `approvals_reviewer="${mode === 'approve-for-me' ? 'auto_review' : 'user'}"`]),
    '--skip-git-repo-check',
    ...controlPlaneArgs,
  ];
  if (options.model) args.push('--model', options.model);
  if (options.reasoningLevel) args.push('-c', `model_reasoning_effort="${options.reasoningLevel}"`);
  args.push(...imageArgs);
  args.push(finalPrompt);
  return args;
}

function planningPermissionMode(options: Pick<SpawnAgentOptions, 'planningControls'>): CodexPermissionMode | undefined {
  const mode = options.planningControls?.codexPermissionMode;
  if (mode !== undefined && !CODEX_PERMISSION_MODES.includes(mode)) {
    throw new Error('Invalid Codex permission mode.');
  }
  return mode;
}

function identifierValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function codexCorrelationFields(
  event: Record<string, any>,
  item: Record<string, any>,
  toolCallId: string,
): { toolCallId: string; runId?: string; attemptId?: string } {
  const runId = identifierValue(
    event.run_id,
    event.runId,
    event.turn_id,
    event.turnId,
    item.run_id,
    item.runId,
    item.turn_id,
    item.turnId,
  );
  const attemptId = identifierValue(
    event.attempt_id,
    event.attemptId,
    item.attempt_id,
    item.attemptId,
  );
  return {
    toolCallId,
    ...(runId ? { runId } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
}
