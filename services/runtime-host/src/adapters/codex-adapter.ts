import type { ChildProcess } from 'child_process';
import readline from 'readline';
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
import { BaseRuntimeAdapter, type SpawnAgentOptions } from './base-adapter';
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
} from '../runtime-utils';

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
  private fallbackToolEventSequence = new Map<string, number>();

  constructor(eventBus?: LocalEventBus) {
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

  async probeCapabilities(profileId?: string): Promise<CapabilitySnapshot> {
    const install = await this.discoverInstallation();
    if (!install.installed) return this.emptyCapabilities();
    const help = (await getHelpText('codex', this.env(profileId))).toLowerCase();
    const execHelp = await this.commandHelp(['exec', '--help'], profileId);
    return {
      structuredEventStreaming: /--json\b/.test(execHelp),
      sessionResume: /resume/.test(execHelp) || /resume/.test(help),
      modelSelection: /--model\b/.test(execHelp) || /-m,?\s+--model/.test(execHelp),
      reasoningControl: /reasoning/.test(help) || /reasoning/.test(execHelp),
      toolCallEvents: /--json\b/.test(execHelp),
      interactiveApproval: /approval/.test(help),
      usageInfo: false,
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
    child.stdout?.on('data', (chunk) => { flow.output += redactSecrets(chunk.toString()); });
    child.stderr?.on('data', (chunk) => { flow.output += redactSecrets(chunk.toString()); });
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
      flow.process?.kill('SIGTERM');
      this.authFlows.delete(authId);
      return { authId, status, message: 'Codex login is connected.' };
    }
    return {
      authId,
      status: flow.error ? 'error' : 'awaiting_browser',
      message: flow.error || flow.output.trim().slice(-1_500) || 'Waiting for the official Codex login flow.',
    };
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
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Codex app-server model discovery timed out.'));
      }, 15_000);
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.id === 2) {
            clearTimeout(timer);
            rl.close();
            child.kill('SIGTERM');
            const result = message.result || {};
            resolve(result.data || result.models || result.items || []);
          }
        } catch {
          // Ignore non-JSON diagnostic lines.
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (code && code !== 0) {
          clearTimeout(timer);
          reject(new Error(stderr || `Codex app-server exited with code ${code}`));
        }
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

  async respondToApproval(): Promise<void> {
    throw new Error('Codex exec approvals must be configured before the run; interactive app-server approvals are not enabled in this adapter yet.');
  }

  async spawnAgent(options: SpawnAgentOptions): Promise<AgentSession> {
    const capabilities = await this.probeCapabilities(options.profileId);
    if (!capabilities.structuredEventStreaming) {
      throw new Error('Installed Codex CLI does not expose `codex exec --json`; update Codex before running a background agent.');
    }

    const sessionId = options.sessionId || crypto.randomUUID();
    const cwd = options.worktreePath || options.cwd || process.cwd();
    const model = options.model || '';
    const controlPlane = prepareControlPlaneSession(options, sessionId);
    const prompt = appendControlPlaneInstructions(options.prompt, controlPlane, cwd);
    const readOnly = ['orchestrator', 'reviewer', 'researcher'].includes(String(options.role || '').toLowerCase());
    const args = ['exec', '--json', '--sandbox', readOnly ? 'read-only' : 'workspace-write', '--skip-git-repo-check'];
    args.push(...codexControlPlaneArgs(controlPlane));
    if (model) args.push('--model', model);
    if (options.reasoningLevel) args.push('-c', `model_reasoning_effort="${options.reasoningLevel}"`);
    args.push(prompt);

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
      child = spawnHidden('codex', args, {
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

    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) this.handleJsonLine(sessionId, line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.isSessionCancelled(sessionId)) return;
      const error = redactSecrets(chunk.toString('utf8'));
      if (error.trim()) this.emitEvent({
        id: crypto.randomUUID(), type: 'agent_error', missionId: options.missionId,
        taskId: options.taskId, agentInstanceId: sessionId, error,
        timestamp: new Date().toISOString(),
      });
    });
    child.on('error', (error) => this.emitFailure(sessionId, error.message));
    child.on('close', (code, signal) => {
      if (buffer.trim()) this.handleJsonLine(sessionId, buffer);
      this.unregisterProcess(sessionId);
      session.endedAt = new Date().toISOString();
      this.activeSessions.delete(sessionId);
      revokeControlPlaneAgent(sessionId);
      if (!this.isSessionCancelled(sessionId) && !this.terminalSessions.has(sessionId)) {
        if (code === 0) this.emitCompleted(sessionId, 'Codex process completed.');
        else this.emitFailure(
          sessionId,
          signal ? `Codex terminated by signal ${signal}` : `Codex exited with code ${code}`,
          code,
        );
      }
      this.sessionContext.delete(sessionId);
      this.terminalSessions.delete(sessionId);
      this.fallbackToolEventSequence.delete(sessionId);
      this.clearSessionCancellation(sessionId);
    });
    return session;
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
          this.emitEvent({ id: crypto.randomUUID(), type: 'tool_call_completed', missionId: context.missionId, agentInstanceId: sessionId, toolName: name, result: redactSecrets(JSON.stringify(item.result || '')), success: !item.error, ...correlation, timestamp });
        }
      } else if (item.type === 'file_change') {
        for (const change of item.changes || []) {
          this.emitEvent({ id: crypto.randomUUID(), type: 'file_changed', missionId: context.missionId, taskId: context.taskId, path: change.path || 'unknown', changeType: change.kind || 'modified', additions: change.additions || 0, deletions: change.deletions || 0, timestamp });
        }
      }
      return;
    }
    if (event.type === 'turn.completed') {
      this.emitCompleted(sessionId, 'Codex turn completed');
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      this.emitFailure(sessionId, event.error?.message || event.message || 'Codex turn failed');
    }
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
