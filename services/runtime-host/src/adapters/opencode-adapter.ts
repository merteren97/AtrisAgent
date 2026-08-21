import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
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
  Provider,
} from '@atris-agent-code/domain';
import { BaseRuntimeAdapter, type SpawnAgentOptions } from './base-adapter';
import {
  appendControlPlaneInstructions,
  controlPlaneEnv,
  opencodeControlPlaneConfig,
  prepareControlPlaneSession,
  revokeControlPlaneAgent,
  type PreparedControlPlaneSession,
} from '../control-plane';
import {
  basicAuthHeader,
  findExecutable,
  getFreePort,
  getRuntimeProfileDir,
  runCommand,
  runtimeProfileEnv,
  spawnHidden,
  waitForHttp,
} from '../runtime-utils';

interface ServerInstance {
  key: string;
  profileId: string;
  cwd: string;
  url: string;
  username: string;
  password: string;
  process: ChildProcess;
  version?: string;
  dedicated?: boolean;
}

interface OpenCodeProvider {
  id?: string;
  name?: string;
  models?: Record<string, any> | any[];
}

export class OpenCodeAdapter extends BaseRuntimeAdapter {
  readonly id = 'opencode';
  readonly name = 'OpenCode';
  readonly runtimeType: RuntimeType = 'opencode';

  private servers = new Map<string, ServerInstance>();
  private authResults = new Map<string, AuthInitiationResult & { profileId: string }>();
  private abortControllers = new Map<string, AbortController>();
  private sessionContext = new Map<string, { missionId: string; taskId: string; serverKey: string; runtimeSessionId: string }>();
  private profileModes = new Map<string, 'isolated' | 'shared_cli'>();

  constructor(eventBus?: LocalEventBus) {
    super(eventBus);
  }

  override configureProfile(profile: AccountProfile): void {
    if (profile.runtimeType !== this.runtimeType) return;
    this.profileModes.set(profile.id, profile.profileMode || (['existing_cli', 'existing_store'].includes(profile.authMethod || '') ? 'shared_cli' : 'isolated'));
  }

  private profileEnv(profileId: string): NodeJS.ProcessEnv {
    return this.profileModes.get(profileId) === 'shared_cli'
      ? {}
      : runtimeProfileEnv(this.runtimeType, profileId);
  }

  async discoverInstallation(): Promise<InstallationStatus> {
    const executable = await findExecutable('opencode');
    if (!executable) return { installed: false, error: 'OpenCode executable was not found in PATH.' };
    try {
      const version = (await runCommand(executable, ['--version'], { timeoutMs: 8_000 })).stdout.trim();
      return { installed: true, path: executable, version: version || undefined };
    } catch (error: any) {
      return { installed: true, path: executable, error: error?.message || 'Could not read OpenCode version.' };
    }
  }

  async probeCapabilities(): Promise<CapabilitySnapshot> {
    const install = await this.discoverInstallation();
    if (!install.installed) return {
      structuredEventStreaming: false, sessionResume: false, modelSelection: false,
      reasoningControl: false, toolCallEvents: false, interactiveApproval: false,
      usageInfo: false, cancellation: false, worktreeAwareness: false,
      headlessAuth: false, nativeSubAgent: false,
    };
    return {
      structuredEventStreaming: true,
      sessionResume: true,
      modelSelection: true,
      reasoningControl: true,
      toolCallEvents: true,
      interactiveApproval: true,
      usageInfo: false,
      cancellation: true,
      worktreeAwareness: true,
      headlessAuth: true,
      nativeSubAgent: true,
    };
  }

  async getAuthMethods(): Promise<AuthMethodDescriptor[]> {
    return [
      { id: 'existing_cli', name: 'Attach existing OpenCode CLI', type: 'command', description: 'Uses the providers and models already configured by your normal OpenCode CLI. No OpenCode account is copied into AtrisAgent.' },
      { id: 'provider_oauth', name: 'Provider OAuth (isolated profile)', type: 'oauth', description: 'Uses the provider methods returned by OpenCode `/provider/auth` in an AtrisAgent-managed isolated profile.' },
      { id: 'provider_secret', name: 'Provider API key / token (isolated profile)', type: 'api_key', description: 'Sends credentials to the official OpenCode `/auth/:id` endpoint. AtrisAgent never writes the secret to its database.' },
    ];
  }

  async beginAuthentication(method = 'existing_cli', options: Record<string, unknown> = {}): Promise<AuthInitiationResult> {
    const authId = crypto.randomUUID();
    const profileId = typeof options.profileId === 'string' ? options.profileId : 'default';
    if (method === 'existing_cli' || method === 'existing_store') {
      const connected = await this.verifyAuthentication(profileId);
      const result = {
        authId,
        method,
        status: connected === 'connected' ? 'completed' as const : 'failed' as const,
        instructions: connected === 'connected'
          ? 'The existing OpenCode CLI configuration contains at least one connected provider.'
          : 'No provider is connected in the selected OpenCode CLI configuration. Open OpenCode and run /connect, then verify again.',
        profileId,
      };
      this.authResults.set(authId, result);
      return result;
    }

    const server = await this.ensureServer(profileId);
    const providerId = typeof options.providerId === 'string' ? options.providerId : '';
    if (!providerId) return { authId, method, status: 'failed', instructions: 'providerId is required.' };
    if (method === 'provider_secret') {
      const secret = typeof options.secret === 'string' ? options.secret : '';
      if (!secret) return { authId, method, status: 'failed', instructions: 'A provider secret is required.' };
      const schema = typeof options.authPayload === 'object' && options.authPayload ? options.authPayload as Record<string, unknown> : { key: secret };
      const response = await this.fetchServer(server, `/auth/${encodeURIComponent(providerId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schema),
      });
      const result = {
        authId, method, status: response.ok ? 'completed' as const : 'failed' as const,
        instructions: response.ok ? 'Credentials were handed to OpenCode and were not persisted by AtrisAgent.' : `OpenCode rejected credentials (${response.status}).`,
        profileId,
      };
      this.authResults.set(authId, result);
      return result;
    }

    const authIndex = Number(options.authIndex ?? 0);
    const response = await this.fetchServer(server, `/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: authIndex }),
    });
    if (!response.ok) return { authId, method, status: 'failed', instructions: `OAuth authorization failed (${response.status}).` };
    const authorization = await response.json() as any;
    const result = {
      authId,
      method,
      status: 'pending' as const,
      url: authorization.url,
      instructions: authorization.instructions || authorization.message || 'Complete the provider OAuth flow, then return to AtrisAgent.',
      profileId,
    };
    this.authResults.set(authId, result);
    return result;
  }

  async pollAuthentication(authId: string): Promise<AuthPollResult> {
    const flow = this.authResults.get(authId);
    if (!flow) return { authId, status: 'error', message: 'Authentication flow not found.' };
    const status = await this.verifyAuthentication(flow.profileId);
    return {
      authId,
      status,
      message: status === 'connected' ? 'At least one OpenCode provider is connected.' : flow.instructions,
    };
  }

  async verifyAuthentication(profileId = 'default'): Promise<AccountProfileStatus> {
    const install = await this.discoverInstallation();
    if (!install.installed || !install.path) return 'not_installed';
    try {
      if (this.profileModes.get(profileId) === 'shared_cli') {
        const result = await runCommand(install.path, ['auth', 'list'], {
          env: this.profileEnv(profileId),
          timeoutMs: 12_000,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim().toLowerCase();
        return !output || /no\s+(?:auth|credential|provider)|not\s+connected/.test(output)
          ? 'login_required'
          : 'connected';
      }

      const server = await this.ensureServer(profileId);
      const response = await this.fetchServer(server, '/provider');
      if (!response.ok) return 'error';
      const data = await response.json() as any;
      return Array.isArray(data.connected) && data.connected.length > 0 ? 'connected' : 'login_required';
    } catch {
      return 'error';
    }
  }

  async logout(profileId = 'default'): Promise<void> {
    for (const [key, server] of this.servers.entries()) {
      if (server.profileId !== profileId) continue;
      if (!server.process.killed) server.process.kill('SIGTERM');
      this.servers.delete(key);
    }
    if (this.profileModes.get(profileId) === 'shared_cli') {
      // Detaching a shared CLI must never delete the user's normal OpenCode auth/config files.
      this.profileModes.delete(profileId);
      return;
    }
    const profileRoot = getRuntimeProfileDir(this.runtimeType, profileId);
    // OpenCode stores provider credentials under its profile-scoped data directory.
    // Explicit logout removes only this AtrisAgent-managed isolated profile.
    fs.rmSync(profileRoot, { recursive: true, force: true });
    this.profileModes.delete(profileId);
  }

  async discoverModels(profileId = 'default'): Promise<ModelDescriptor[]> {
    if (this.profileModes.get(profileId) === 'shared_cli') {
      return this.discoverModelsFromCli(profileId);
    }

    const server = await this.ensureServer(profileId);
    const response = await this.fetchServer(server, '/config/providers');
    if (!response.ok) return [];
    const data = await response.json() as any;
    const providers: OpenCodeProvider[] = Array.isArray(data.providers) ? data.providers : [];
    const descriptors: ModelDescriptor[] = [];
    for (const provider of providers) {
      const providerId = provider.id || 'unknown';
      const models = Array.isArray(provider.models)
        ? provider.models.map((model: any) => [model.id || model.name, model] as const)
        : Object.entries(provider.models || {});
      for (const [modelId, modelValue] of models) {
        if (!modelId) continue;
        const model = modelValue as any;
        const variants = this.extractVariants(model);
        descriptors.push({
          catalogId: `${this.id}:${profileId}:${providerId}/${modelId}`,
          runtimeId: this.runtimeType,
          accountProfileId: profileId,
          providerId: this.mapProvider(providerId),
          runtimeModelId: `${providerId}/${modelId}`,
          displayName: model.name || model.displayName || modelId,
          description: model.description,
          supportedRoles: ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'],
          supportedReasoning: variants,
          defaultReasoning: variants.includes('medium') ? 'medium' : variants[0],
          inputModalities: model.modalities?.input || model.input || ['text'],
          outputModalities: model.modalities?.output || model.output,
          contextWindow: model.limit?.context || model.contextWindow,
          maxOutputTokens: model.limit?.output || model.maxOutputTokens,
          availability: 'available',
          source: 'discovered',
          routeLabel: `OpenCode · ${provider.name || providerId}`,
          discoveredAt: new Date().toISOString(),
          isDefault: data.default?.[providerId] === modelId,
        });
      }
    }
    return descriptors;
  }

  private async discoverModelsFromCli(profileId: string): Promise<ModelDescriptor[]> {
    const install = await this.discoverInstallation();
    if (!install.installed || !install.path) return [];
    const result = await runCommand(install.path, ['models', '--refresh'], {
      env: this.profileEnv(profileId),
      timeoutMs: 45_000,
    });
    const seen = new Set<string>();
    const models: ModelDescriptor[] = [];
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '').trim();
      const match = line.match(/^([A-Za-z0-9_.-]+)\/([^\s]+)(?:\s|$)/);
      if (!match) continue;
      const providerId = match[1];
      const modelId = match[2];
      const runtimeModelId = `${providerId}/${modelId}`;
      if (seen.has(runtimeModelId)) continue;
      seen.add(runtimeModelId);
      models.push({
        catalogId: `${this.id}:${profileId}:${runtimeModelId}`,
        runtimeId: this.runtimeType,
        accountProfileId: profileId,
        providerId: this.mapProvider(providerId),
        runtimeModelId,
        displayName: modelId.split(/[._-]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
        description: `Model reported by the attached OpenCode CLI provider ${providerId}.`,
        supportedRoles: ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'],
        supportedReasoning: [],
        inputModalities: ['text'],
        availability: 'available',
        source: 'discovered',
        routeLabel: `OpenCode CLI · ${providerId}`,
        entitlement: 'Available through the attached OpenCode CLI configuration',
        discoveredAt: new Date().toISOString(),
      });
    }
    return models;
  }

  private extractVariants(model: any): CanonicalReasoning[] {
    const keys = Array.isArray(model.variants) ? model.variants : Object.keys(model.variants || {});
    const normalized = keys
      .map((value: string) => value.toLowerCase().replace('extra-high', 'xhigh'))
      .filter((value: string) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) as CanonicalReasoning[];
    return [...new Set(normalized)];
  }

  private mapProvider(providerId: string): Provider {
    const id = providerId.toLowerCase();
    if (id.includes('openai')) return 'openai';
    if (id.includes('anthropic') || id.includes('claude')) return 'anthropic';
    if (id.includes('google') || id.includes('gemini')) return 'google';
    if (id.includes('local') || id.includes('ollama') || id.includes('lmstudio')) return 'local';
    return 'opencode';
  }

  async discoverAccounts(): Promise<AccountProfile[]> {
    return [];
  }

  async discoverUsage(): Promise<UsageSnapshot | null> {
    return null;
  }

  async startSession(request: StartSessionRequest): Promise<AgentSession> {
    const profileId = 'default';
    const server = await this.ensureServer(profileId);
    const response = await this.fetchServer(server, '/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `AtrisAgent · ${request.model}` }),
    });
    if (!response.ok) throw new Error(`OpenCode failed to create a session (${response.status}).`);
    const created = await response.json() as any;
    const id = created.id || created.sessionID || crypto.randomUUID();
    const session: AgentSession = { id, agentInstanceId: id, runtimeSessionId: id, startedAt: new Date().toISOString(), endedAt: null };
    this.activeSessions.set(id, session);
    return session;
  }

  async sendInput(sessionId: string, input: AgentInput): Promise<void> {
    const context = this.sessionContext.get(sessionId);
    const server = context ? this.getServer(context.serverKey) : await this.ensureServer('default');
    const runtimeSessionId = context?.runtimeSessionId || sessionId;
    const model = input.metadata?.model;
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: input.content }],
      noReply: false,
    };
    if (model && typeof model === 'object') body.model = model;
    const response = await this.fetchServer(server, `/session/${encodeURIComponent(runtimeSessionId)}/prompt_async`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`OpenCode message failed (${response.status}).`);
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

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const [sessionId, permissionId] = requestId.split(':', 2);
    const context = this.sessionContext.get(sessionId);
    if (!context || !permissionId) throw new Error('OpenCode approval request must be `<sessionId>:<permissionId>`.');
    const server = this.getServer(context.serverKey);
    const response = await this.fetchServer(server, `/session/${encodeURIComponent(context.runtimeSessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: decision === 'approved' ? 'once' : 'reject', remember: false }),
    });
    if (!response.ok) throw new Error(`OpenCode permission response failed (${response.status}).`);
  }

  override async cancel(sessionId: string): Promise<void> {
    this.markSessionCancelled(sessionId);
    const context = this.sessionContext.get(sessionId);
    if (context) {
      const server = this.getServer(context.serverKey);
      await this.fetchServer(server, `/session/${encodeURIComponent(context.runtimeSessionId)}/abort`, { method: 'POST' }).catch(() => undefined);
    }
    this.cleanupSession(sessionId);
  }

  override async shutdown(): Promise<void> {
    for (const sessionId of [...this.activeSessions.keys()]) await this.cancel(sessionId);
    for (const server of this.servers.values()) if (!server.process.killed) server.process.kill('SIGTERM');
    this.servers.clear();
    await super.shutdown();
  }

  async spawnAgent(options: SpawnAgentOptions): Promise<AgentSession> {
    const profileId = options.profileId || 'default';
    const workspaceCwd = path.resolve(options.worktreePath || options.cwd || process.cwd());
    const agentInstanceId = options.sessionId || crypto.randomUUID();
    const controlPlane = prepareControlPlaneSession(options, agentInstanceId);

    try {
      const server = await this.ensureServer(profileId, workspaceCwd, controlPlane, agentInstanceId);
      const createResponse = await this.fetchServer(server, '/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `${options.role || 'agent'} · ${options.taskId}` }),
      });
      if (!createResponse.ok) throw new Error(`OpenCode failed to create a session (${createResponse.status}).`);
      const created = await createResponse.json() as any;
      const runtimeSessionId = created.id || created.sessionID;
      if (!runtimeSessionId) throw new Error('OpenCode session response did not contain an id.');

      const session: AgentSession = {
        id: agentInstanceId,
        agentInstanceId,
        runtimeSessionId,
        startedAt: new Date().toISOString(),
        endedAt: null,
      };
      this.activeSessions.set(agentInstanceId, session);
      this.sessionContext.set(agentInstanceId, {
        missionId: options.missionId,
        taskId: options.taskId,
        serverKey: server.key,
        runtimeSessionId,
      });
      this.emitEvent({ id: crypto.randomUUID(), type: 'agent_started', missionId: options.missionId, agentInstanceId, role: String(options.role || 'builder'), model: options.model || 'OpenCode default', timestamp: new Date().toISOString() });

      this.startEventStream(agentInstanceId, server).catch((error) => this.emitFailure(agentInstanceId, error.message));
      const model = this.parseModelRoute(options.model);
      const prompt = appendControlPlaneInstructions(options.prompt, controlPlane, workspaceCwd);
      const response = await this.fetchServer(server, `/session/${encodeURIComponent(runtimeSessionId)}/prompt_async`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          agent: this.mapAgentMode(options.role),
          parts: [{ type: 'text', text: prompt }],
        }),
      });
      if (!response.ok) {
        await this.cancel(agentInstanceId);
        throw new Error(`OpenCode prompt submission failed (${response.status}).`);
      }
      return session;
    } catch (error) {
      revokeControlPlaneAgent(agentInstanceId);
      throw error;
    }
  }

  private mapAgentMode(role?: string): 'build' | 'plan' {
    const normalized = String(role || 'builder').toLowerCase();
    return normalized === 'builder' || normalized === 'qa' ? 'build' : 'plan';
  }

  private parseModelRoute(model?: string): { providerID: string; modelID: string } | undefined {
    if (!model) return undefined;
    const normalized = model.split('#')[0];
    const index = normalized.indexOf('/');
    if (index < 1) return undefined;
    return { providerID: normalized.slice(0, index), modelID: normalized.slice(index + 1) };
  }

  private async ensureServer(
    profileId = 'default',
    requestedCwd?: string,
    controlPlane?: PreparedControlPlaneSession,
    sessionKey?: string,
  ): Promise<ServerInstance> {
    const profileDir = getRuntimeProfileDir(this.runtimeType, profileId);
    const cwd = path.resolve(requestedCwd || profileDir);
    const key = controlPlane && sessionKey ? `${profileId}::${cwd}::agent:${sessionKey}` : `${profileId}::${cwd}`;
    const existing = this.servers.get(key);
    if (existing && !existing.process.killed) {
      try {
        await waitForHttp(`${existing.url}/global/health`, { headers: { Authorization: basicAuthHeader(existing.username, existing.password) } }, 1_000);
        return existing;
      } catch {
        existing.process.kill('SIGKILL');
        this.servers.delete(key);
      }
    }
    const install = await this.discoverInstallation();
    if (!install.installed) throw new Error(install.error || 'OpenCode is not installed.');
    fs.mkdirSync(cwd, { recursive: true });
    const port = await getFreePort();
    const username = 'opencode';
    const password = randomBytes(24).toString('base64url');
    const executable = install.path || 'opencode';
    const inlineControlPlaneConfig = opencodeControlPlaneConfig(controlPlane, install.version);
    const child = spawnHidden(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd,
      env: {
        ...processEnv(this.profileEnv(profileId)),
        ...controlPlaneEnv(controlPlane),
        ...(inlineControlPlaneConfig ? { OPENCODE_CONFIG_CONTENT: inlineControlPlaneConfig } : {}),
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startupError: Error | undefined;
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { startupError = error; });
    const instance: ServerInstance = {
      key,
      profileId,
      cwd,
      url: `http://127.0.0.1:${port}`,
      username,
      password,
      process: child,
      dedicated: Boolean(controlPlane),
    };
    child.on('close', () => { if (this.servers.get(key)?.process === child) this.servers.delete(key); });
    this.servers.set(key, instance);
    const health = await Promise.race([
      waitForHttp(`${instance.url}/global/health`, { headers: { Authorization: basicAuthHeader(username, password) } }, 15_000),
      new Promise<never>((_, reject) => {
        const check = () => {
          if (startupError) reject(new Error(`OpenCode server could not start: ${startupError.message}`));
          else if (child.exitCode !== null) reject(new Error(`OpenCode server exited with code ${child.exitCode}. ${stderr.trim()}`.trim()));
          else setTimeout(check, 50);
        };
        check();
      }),
    ]);
    const data = await health.json() as any;
    instance.version = data.version || install.version;
    return instance;
  }

  private getServer(serverKey: string): ServerInstance {
    const server = this.servers.get(serverKey);
    if (!server || server.process.killed) throw new Error('The OpenCode server for this session is no longer running. Retry the task to create a new session.');
    return server;
  }

  private fetchServer(server: ServerInstance, pathname: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', basicAuthHeader(server.username, server.password));
    return fetch(`${server.url}${pathname}`, { ...init, headers });
  }

  private async startEventStream(sessionId: string, server: ServerInstance): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);
    const response = await this.fetchServer(server, '/event', { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
    if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (${response.status}).`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data) continue;
        try { this.handleServerEvent(sessionId, JSON.parse(data)); } catch { /* ignore malformed SSE */ }
      }
    }
  }

  private handleServerEvent(sessionId: string, envelope: any): void {
    const context = this.sessionContext.get(sessionId);
    if (!context) return;
    const event = envelope.payload || envelope;
    const properties = event.properties || event;
    const relatedSessionId = properties.sessionID || properties.sessionId || properties.info?.sessionID || properties.part?.sessionID;
    if (relatedSessionId && relatedSessionId !== context.runtimeSessionId) return;
    const type = event.type || envelope.type;
    const timestamp = new Date().toISOString();
    if (type === 'message.part.updated') {
      const part = properties.part || {};
      const text = properties.delta || part.text;
      if (part.type === 'text' && text) this.emitEvent({ id: crypto.randomUUID(), type: 'text_delta', missionId: context.missionId, agentInstanceId: sessionId, content: text, timestamp });
      if (part.type === 'reasoning' && text) this.emitEvent({ id: crypto.randomUUID(), type: 'agent_thought', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, thought: text, timestamp });
      if (part.type === 'tool') {
        const correlation = openCodeCorrelationFields(part, properties);
        if (part.state?.status === 'running') this.emitEvent({ id: crypto.randomUUID(), type: 'tool_call_started', missionId: context.missionId, agentInstanceId: sessionId, toolName: part.tool || 'tool', args: part.state?.input || {}, ...correlation, timestamp });
        if (['completed', 'error'].includes(part.state?.status)) this.emitEvent({ id: crypto.randomUUID(), type: 'tool_call_completed', missionId: context.missionId, agentInstanceId: sessionId, toolName: part.tool || 'tool', result: JSON.stringify(part.state?.output || part.state?.error || ''), success: part.state?.status === 'completed', ...correlation, timestamp });
      }
    } else if (type === 'permission.updated' || type === 'permission.asked') {
      const permission = properties.permission || properties;
      this.emitEvent({ id: crypto.randomUUID(), type: 'approval_requested', missionId: context.missionId, approvalId: `${sessionId}:${permission.id}`, approvalType: permission.type || 'tool', description: permission.title || permission.description || 'OpenCode permission required', timestamp });
    } else if (type === 'session.idle') {
      this.emitEvent({ id: crypto.randomUUID(), type: 'task_completed', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, result: 'OpenCode session completed', timestamp });
      const session = this.activeSessions.get(sessionId);
      if (session) session.endedAt = timestamp;
      this.cleanupSession(sessionId);
    } else if (type === 'session.error') {
      this.emitFailure(sessionId, properties.error?.message || properties.error || 'OpenCode session failed');
      this.cleanupSession(sessionId);
    }
  }

  private cleanupSession(sessionId: string): void {
    const context = this.sessionContext.get(sessionId);
    this.abortControllers.get(sessionId)?.abort();
    this.abortControllers.delete(sessionId);
    this.activeSessions.delete(sessionId);
    revokeControlPlaneAgent(sessionId);
    if (context) {
      const server = this.servers.get(context.serverKey);
      if (server?.dedicated) {
        if (!server.process.killed) server.process.kill('SIGTERM');
        this.servers.delete(context.serverKey);
      }
      this.sessionContext.delete(sessionId);
    }
  }

  private emitFailure(sessionId: string, error: string): void {
    const context = this.sessionContext.get(sessionId);
    if (!context) return;
    this.emitEvent({ id: crypto.randomUUID(), type: 'task_failed', missionId: context.missionId, taskId: context.taskId, agentInstanceId: sessionId, error, timestamp: new Date().toISOString() });
  }
}

function processEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...extra };
}

function identifierValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function openCodeCorrelationFields(
  part: Record<string, any>,
  properties: Record<string, any>,
): { toolCallId?: string; runId?: string; attemptId?: string } {
  const toolCallId = identifierValue(part.id, part.callID, part.callId, part.toolCallId);
  const runId = identifierValue(
    part.run_id,
    part.runId,
    properties.run_id,
    properties.runId,
  );
  const attemptId = identifierValue(
    part.attempt_id,
    part.attemptId,
    properties.attempt_id,
    properties.attemptId,
  );
  return {
    ...(toolCallId ? { toolCallId } : {}),
    ...(runId ? { runId } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
}
