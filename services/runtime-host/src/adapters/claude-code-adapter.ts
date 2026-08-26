import type { ChildProcess } from 'child_process';
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
} from '@atris-agent-code/domain';
import { BaseRuntimeAdapter, isReadOnlyAgentRole, type SpawnAgentOptions } from './base-adapter';
import {
  appendControlPlaneInstructions,
  claudeAllowedMcpTools,
  controlPlaneEnv,
  createClaudeMcpConfig,
  prepareControlPlaneSession,
  revokeControlPlaneAgent,
} from '../control-plane';
import { findExecutable, getHelpText, redactSecrets, runCommand, runtimeProfileEnv, spawnHidden } from '../runtime-utils';

interface PendingAuth {
  process?: ChildProcess;
  profileId?: string;
  output: string;
  error?: string;
}

export class ClaudeCodeAdapter extends BaseRuntimeAdapter {
  readonly id = 'claude_code';
  readonly name = 'Claude Code';
  readonly runtimeType: RuntimeType = 'claude_code';

  private authFlows = new Map<string, PendingAuth>();
  private sessionContext = new Map<string, { missionId: string; taskId: string }>();
  private toolNamesBySession = new Map<string, Map<string, string>>();

  constructor(eventBus?: LocalEventBus) {
    super(eventBus);
  }

  private env(profileId?: string): NodeJS.ProcessEnv {
    return { ...runtimeProfileEnv(this.runtimeType, profileId) };
  }

  async discoverInstallation(): Promise<InstallationStatus> {
    const executable = await findExecutable('claude');
    if (!executable) {
      return {
        installed: false,
        error: process.platform === 'win32'
          ? 'Claude Code was not found. Install the native binary or configure Git Bash/WSL as documented by Anthropic.'
          : 'Claude Code executable was not found in PATH.',
      };
    }
    try {
      const version = (await runCommand(executable, ['--version'], { timeoutMs: 8_000 })).stdout.trim();
      return { installed: true, path: executable, version: version || undefined };
    } catch (error: any) {
      return { installed: true, path: executable, error: error?.message || 'Could not read Claude Code version.' };
    }
  }

  async probeCapabilities(profileId?: string): Promise<CapabilitySnapshot> {
    const install = await this.discoverInstallation();
    if (!install.installed) return this.emptyCapabilities();
    const help = (await getHelpText('claude', this.env(profileId))).toLowerCase();
    return {
      structuredEventStreaming: /stream-json/.test(help),
      sessionResume: /--resume/.test(help) || /--continue/.test(help),
      modelSelection: /--model/.test(help),
      reasoningControl: /--effort/.test(help),
      toolCallEvents: /stream-json/.test(help),
      // Help text alone is not enough: this adapter has no callback transport
      // for interactive permission decisions yet.
      interactiveApproval: false,
      usageInfo: /output-format/.test(help),
      cancellation: true,
      worktreeAwareness: /--worktree/.test(help),
      headlessAuth: /setup-token|auth login/.test(help),
      nativeSubAgent: /--agents/.test(help) || /agent/.test(help),
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
      { id: 'claude_subscription', name: 'Claude subscription / team account', type: 'browser', description: 'Runs the official `claude auth login` browser flow.' },
      { id: 'console', name: 'Anthropic Console', type: 'browser', description: 'Runs `claude auth login --console` for API usage billing.' },
      { id: 'sso', name: 'Organization SSO', type: 'browser', description: 'Runs `claude auth login --sso`.' },
      { id: 'setup_token', name: 'Long-lived OAuth token', type: 'command', description: 'Use the official `claude setup-token` flow for automation. The token must be stored in an OS secret store, not SQLite.' },
      { id: 'cloud_provider', name: 'Bedrock / Vertex / Foundry environment', type: 'command', description: 'Uses provider environment credentials configured outside AtrisAgent.' },
    ];
  }

  async beginAuthentication(method = 'claude_subscription', options: Record<string, unknown> = {}): Promise<AuthInitiationResult> {
    const authId = crypto.randomUUID();
    const install = await this.discoverInstallation();
    if (!install.installed) return { authId, method, status: 'failed', instructions: install.error };
    const profileId = typeof options.profileId === 'string' ? options.profileId : undefined;

    if (method === 'cloud_provider') {
      const status = await this.verifyAuthentication(profileId);
      return {
        authId, method, status: status === 'connected' ? 'completed' : 'failed',
        instructions: status === 'connected'
          ? 'Claude Code detected active cloud-provider credentials.'
          : 'Configure the official Bedrock, Vertex AI, or Foundry environment variables, then verify again.',
      };
    }

    const args = method === 'setup_token' ? ['setup-token'] : ['auth', 'login'];
    if (method === 'console') args.push('--console');
    if (method === 'sso') args.push('--sso');
    if (typeof options.email === 'string' && method !== 'setup_token') args.push('--email', options.email);

    const child = spawnHidden('claude', args, {
      env: { ...process.env, ...this.env(profileId) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const flow: PendingAuth = { process: child, profileId, output: '' };
    this.authFlows.set(authId, flow);
    child.stdout?.on('data', (chunk) => { flow.output += redactSecrets(chunk.toString()); });
    child.stderr?.on('data', (chunk) => { flow.output += redactSecrets(chunk.toString()); });
    child.on('error', (error) => { flow.error = error.message; });
    child.on('close', (code) => {
      if (code !== 0 && !flow.error) flow.error = `Claude authentication exited with code ${code}`;
    });

    return {
      authId,
      method,
      status: 'pending',
      instructions: method === 'setup_token'
        ? 'Complete the official setup-token flow in Developer Console. AtrisAgent will not capture or persist the generated token.'
        : 'Complete the browser sign-in opened by Claude Code. If a callback code is shown, paste it into the official CLI process.',
    };
  }

  async pollAuthentication(authId: string): Promise<AuthPollResult> {
    const flow = this.authFlows.get(authId);
    if (!flow) return { authId, status: 'error', message: 'Authentication flow not found.' };
    const status = await this.verifyAuthentication(flow.profileId);
    if (status === 'connected') {
      flow.process?.kill('SIGTERM');
      this.authFlows.delete(authId);
      return { authId, status, message: 'Claude Code authentication is connected.' };
    }
    return {
      authId,
      status: flow.error ? 'error' : 'awaiting_browser',
      message: flow.error || flow.output.trim().slice(-1_500) || 'Waiting for Claude Code authentication.',
    };
  }

  async verifyAuthentication(profileId?: string): Promise<AccountProfileStatus> {
    const install = await this.discoverInstallation();
    if (!install.installed) return 'not_installed';
    try {
      const result = await runCommand('claude', ['auth', 'status'], { env: this.env(profileId), timeoutMs: 10_000 });
      const text = result.stdout.trim();
      if (!text) return 'connected';
      try {
        const status = JSON.parse(text);
        const loggedIn = status.loggedIn ?? status.authenticated ?? (typeof status.status === 'string' ? status.status === 'logged_in' : true);
        return loggedIn ? 'connected' : 'login_required';
      } catch {
        return 'connected';
      }
    } catch {
      return 'login_required';
    }
  }

  async logout(profileId?: string): Promise<void> {
    await runCommand('claude', ['auth', 'logout'], { env: this.env(profileId), timeoutMs: 15_000 }).catch(() => undefined);
  }

  async discoverModels(profileId?: string): Promise<ModelDescriptor[]> {
    if ((await this.verifyAuthentication(profileId)) !== 'connected') return [];
    const capabilities = await this.probeCapabilities(profileId);
    const reasoning: CanonicalReasoning[] = capabilities.reasoningControl
      ? ['low', 'medium', 'high', 'xhigh']
      : [];

    // Claude Code does not expose a stable account-scoped model-list API in the CLI.
    // Use official aliases and let Claude resolve them for the connected account.
    return [
      { id: 'default', name: 'Claude default (account policy)' },
      { id: 'sonnet', name: 'Claude Sonnet (CLI alias)' },
      { id: 'opus', name: 'Claude Opus (CLI alias)' },
      { id: 'haiku', name: 'Claude Haiku (CLI alias)' },
    ].map(({ id, name }, index) => ({
      catalogId: `${this.id}:${profileId || 'default'}:${id}`,
      runtimeId: this.runtimeType,
      accountProfileId: profileId || 'default',
      providerId: 'anthropic',
      runtimeModelId: id,
      displayName: name,
      description: 'Official Claude Code model alias. Exact backing model and entitlement are resolved by the connected account at run time.',
      supportedRoles: ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'],
      supportedReasoning: reasoning,
      inputModalities: ['text', 'image'],
      availability: 'available',
      source: 'documented',
      routeLabel: 'Claude Code CLI',
      isDefault: index === 0,
      discoveredAt: new Date().toISOString(),
    }));
  }

  async discoverAccounts(): Promise<AccountProfile[]> {
    return [];
  }

  async discoverUsage(): Promise<UsageSnapshot | null> {
    return null;
  }

  async startSession(request: StartSessionRequest): Promise<AgentSession> {
    const session: AgentSession = {
      id: crypto.randomUUID(), agentInstanceId: request.model,
      runtimeSessionId: '', startedAt: new Date().toISOString(), endedAt: null,
    };
    this.activeSessions.set(session.id, session);
    return session;
  }

  async sendInput(sessionId: string, input: AgentInput): Promise<void> {
    const child = this.activeProcesses.get(sessionId);
    if (!child?.stdin || child.killed) throw new Error(`Claude session ${sessionId} is not interactive.`);
    child.stdin.write(`${input.content}\n`);
  }

  async *streamEvents(sessionId: string): AsyncIterable<AgentEvent> {
    if (!this.eventBus) return;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.eventBus.on('*', (event) => {
      if ((event as any).agentInstanceId !== sessionId) return;
      queue.push(event);
      wake?.(); wake = undefined;
    });
    try {
      while (this.activeSessions.has(sessionId) || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally { unsubscribe(); }
  }

  async respondToApproval(): Promise<void> {
    throw new Error('Interactive Claude approval callbacks require a configured permission-prompt tool and are not enabled in this CLI adapter yet.');
  }

  async spawnAgent(options: SpawnAgentOptions): Promise<AgentSession> {
    const capabilities = await this.probeCapabilities(options.profileId);
    if (!capabilities.structuredEventStreaming) {
      throw new Error('Installed Claude Code does not support `--output-format stream-json`. Update Claude Code before using background agents.');
    }
    const sessionId = options.sessionId || crypto.randomUUID();
    const cwd = options.worktreePath || options.cwd || process.cwd();
    const controlPlane = prepareControlPlaneSession(options, sessionId);
    const mcpConfig = createClaudeMcpConfig(controlPlane);
    const prompt = appendControlPlaneInstructions(options.prompt, controlPlane, cwd);
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (options.model) args.push('--model', options.model);
    if (options.reasoningLevel && capabilities.reasoningControl) args.push('--effort', options.reasoningLevel);
    const readOnly = isReadOnlyAgentRole(options.role);
    args.push('--permission-mode', readOnly ? 'plan' : 'acceptEdits');
    if (mcpConfig.path) {
      args.push('--mcp-config', mcpConfig.path, '--allowedTools', ...claudeAllowedMcpTools());
    }

    const session: AgentSession = {
      id: sessionId, agentInstanceId: sessionId, runtimeSessionId: '',
      startedAt: new Date().toISOString(), endedAt: null,
    };
    this.activeSessions.set(sessionId, session);
    this.sessionContext.set(sessionId, { missionId: options.missionId, taskId: options.taskId });
    this.toolNamesBySession.set(sessionId, new Map());
    this.emitEvent({ id: crypto.randomUUID(), type: 'agent_started', missionId: options.missionId, agentInstanceId: sessionId, role: String(options.role || 'builder'), model: options.model || 'Claude default', timestamp: new Date().toISOString() });

    const child = spawnHidden('claude', args, {
      cwd,
      env: {
        ...process.env,
        ...this.env(options.profileId),
        ...options.env,
        ...controlPlaneEnv(controlPlane),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.registerProcess(sessionId, child);
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
    child.on('error', (error) => this.emitAgentError(sessionId, error.message));
    child.on('close', (code) => {
      if (buffer.trim()) this.handleStreamLine(sessionId, buffer);
      this.unregisterProcess(sessionId);
      session.endedAt = new Date().toISOString();
      this.activeSessions.delete(sessionId);
      mcpConfig.cleanup();
      revokeControlPlaneAgent(sessionId);
      this.toolNamesBySession.delete(sessionId);
      if (code !== 0) this.emitFailure(sessionId, `Claude Code exited with code ${code}`, code);
      this.sessionContext.delete(sessionId);
    });
    return session;
  }

  private handleStreamLine(sessionId: string, line: string): void {
    const context = this.sessionContext.get(sessionId);
    if (!context || !line.trim()) return;
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    const timestamp = new Date().toISOString();
    if (message.session_id) {
      const session = this.activeSessions.get(sessionId);
      if (session) session.runtimeSessionId = message.session_id;
    }
    if (message.type === 'assistant') {
      const blocks = message.message?.content || message.content || [];
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block.type === 'text' && block.text) this.emitEvent({ id: crypto.randomUUID(), type: 'text_delta', missionId: context.missionId, agentInstanceId: sessionId, content: block.text, timestamp });
        if ((block.type === 'thinking' || block.type === 'reasoning') && block.thinking) this.emitEvent({ id: crypto.randomUUID(), type: 'agent_thought', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, thought: block.thinking, timestamp });
        if (block.type === 'tool_use') {
          const toolCallId = identifierValue(block.id);
          const toolName = stringValue(block.name) || 'tool';
          if (toolCallId) {
            const toolNames = this.toolNamesBySession.get(sessionId) || new Map<string, string>();
            toolNames.set(toolCallId, toolName);
            this.toolNamesBySession.set(sessionId, toolNames);
          }
          this.emitEvent({
            id: crypto.randomUUID(),
            type: 'tool_call_started',
            missionId: context.missionId,
            agentInstanceId: sessionId,
            toolName,
            args: block.input || {},
            ...(toolCallId ? { toolCallId } : {}),
            ...correlationFields(message),
            timestamp,
          });
        }
      }
    } else if (message.type === 'user') {
      for (const block of message.message?.content || []) {
        if (block.type === 'tool_result') {
          const toolCallId = identifierValue(block.tool_use_id);
          const toolName = (toolCallId ? this.toolNamesBySession.get(sessionId)?.get(toolCallId) : undefined)
            || stringValue(block.name, block.tool_name)
            || 'tool';
          this.emitEvent({
            id: crypto.randomUUID(),
            type: 'tool_call_completed',
            missionId: context.missionId,
            agentInstanceId: sessionId,
            toolName,
            result: redactSecrets(typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')),
            success: !block.is_error,
            ...(toolCallId ? { toolCallId } : {}),
            ...correlationFields(message),
            timestamp,
          });
        }
      }
    } else if (message.type === 'result') {
      if (message.is_error || message.subtype === 'error') this.emitFailure(sessionId, message.result || message.error || 'Claude run failed');
      else this.emitEvent({ id: crypto.randomUUID(), type: 'task_completed', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, result: message.result || 'Claude task completed', timestamp });
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

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function identifierValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function correlationFields(message: Record<string, any>): { runId?: string; attemptId?: string } {
  const runId = identifierValue(message.run_id, message.runId);
  const attemptId = identifierValue(message.attempt_id, message.attemptId);
  return {
    ...(runId ? { runId } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
}
