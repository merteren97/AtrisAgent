import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { CodexPermissionMode } from '@atris-agent-code/domain';
import { isCodexPermissionMode } from './manual-codex-permissions';

type Json = Record<string, any>;
const unavailable = (message: string, status = 409) => Object.assign(new Error(message), {status});
const MAX_RPC_BYTES = 64 * 1024 * 1024;
const profileIds = {'ask-for-approval':':workspace', 'approve-for-me':':workspace', 'full-access':':danger-full-access', 'read-only':':read-only'};

export function codexChildEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  // Gateway credentials and lifecycle variables belong to the application, not
  // to Codex or the commands it runs. Preserve the user's provider environment.
  return Object.fromEntries(Object.entries({...process.env, ...overrides}).filter(([key]) => !key.toUpperCase().startsWith('ATRIS_') && key.toUpperCase() !== 'PORT'));
}

export function effectiveCodexMode(settings?: Json): CodexPermissionMode | undefined {
  if (!settings) return;
  const {approvalPolicy: approval, approvalsReviewer: reviewer, sandboxPolicy: sandbox} = settings;
  if (sandbox?.type === 'dangerFullAccess' && approval === 'never' && reviewer === 'user') return 'full-access';
  if (approval !== 'on-request') return;
  if (sandbox?.type === 'readOnly' && reviewer === 'user') return 'read-only';
  if (sandbox?.type === 'workspaceWrite') {
    if (reviewer === 'auto_review') return 'approve-for-me';
    if (reviewer === 'user') return 'ask-for-approval';
  }
}

export interface CodexLivePermissions {
  available: boolean; runtimeId?: string; threadId?: string; revision?: number;
  mode?: CodexPermissionMode; applying?: boolean; reason?: string;
  policy?: {sandbox: string; approval: string; reviewer: string; cwd: string};
}
interface Pending {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}
interface Options {
  executable: string; cwd: string; env: Record<string, string>; mode: CodexPermissionMode;
  model?: string; reasoning?: string;
  onThread: (threadId: string, transcriptPath: string) => void;
  coordination?: {endpoint:string; script:string; token:string; runtimeToken?:string};
  playwright?: {command:string; args:string[]};
  onClosed?: () => void;
}

/** One owning app-server and one authenticated TUI connection per native terminal.
 * Control RPCs use that very connection: no second resume, guessed thread, or PTY commands.
 * Retain metadata/settings only, never model/tool payloads or credentials in diagnostics.
 */
export class ManualCodexSession {
  readonly runtimeId = randomUUID();
  readonly token = randomBytes(32).toString('hex');
  readonly server: WebSocketServer;
  private child?: ChildProcessWithoutNullStreams;
  private client?: WebSocket;
  private connected = false;
  private initialized = false;
  private closed = false;
  private closing?: Promise<void>;
  private generation = 0;
  private threadId?: string;
  private ambiguous = false;
  private settings?: Json;
  private revision = 0;
  private active = false;
  private hasCompletedTurn = false;
  private activityAt = new Date().toISOString();
  private providerRetry = false;
  private startupFailure?: string;
  private approvals = new Set<string>();
  private requests = new Map<string, {method: string; user: boolean}>();
  private helperThreads = new Set<string>();
  private pending = new Map<string, Pending>();
  private verification?: {threadId: string; mode: CodexPermissionMode; resolve: () => void; reject: (error: Error) => void};
  private applying = false;
  private expiry: ReturnType<typeof setTimeout>;
  private bindingPending = false;
  private onClosed?: (reason: string) => void;

  constructor(private options: Options) {
    this.server = new WebSocketServer({host:'127.0.0.1', port:0, maxPayload:MAX_RPC_BYTES, perMessageDeflate:false,
      verifyClient: ({req}, done) => {
        const value = req.headers.authorization;
        const expected = Buffer.from(`Bearer ${this.token}`);
        const actual = Buffer.from(typeof value === 'string' ? value : '');
        done(!this.closed && !this.connected && !req.headers.origin && actual.length === expected.length && timingSafeEqual(actual, expected), 401);
      }});
    this.expiry = setTimeout(() => { void this.close('Codex did not connect before the two-minute startup deadline.'); }, 120_000);
    this.expiry.unref();
    this.server.on('connection', client => this.attach(client));
    this.server.on('error', () => { void this.close('The local Codex control listener failed.'); });
  }

  async start(onClosed: (reason: string) => void): Promise<{url: string; token: string}> {
    this.onClosed = onClosed;
    await new Promise<void>((resolve, reject) => {
      if (this.server.address()) return resolve();
      this.server.once('listening', resolve); this.server.once('error', reject);
    });
    try {
      // Session flags override defaults only for this process. Existing user/project
      // hooks, account and managed requirements continue to be loaded by Codex.
      const mode = this.options.mode;
      const sandbox = mode === 'full-access' ? 'danger-full-access' : mode === 'read-only' ? 'read-only' : 'workspace-write';
      const coordination = this.options.coordination;
      const coordinationEnv: Record<string,string> = coordination ? {
        ATRIS_CONTROL_PLANE_URL: coordination.endpoint,
        ATRIS_CONTROL_PLANE_TOKEN: coordination.token,
        ATRIS_MANUAL_COORDINATION: '1',
        ...(coordination.runtimeToken ? {ATRIS_RUNTIME_TOKEN:coordination.runtimeToken} : {}),
      } : {};
      this.child = spawn(this.options.executable, ['app-server', '--stdio',
        ...(coordination ? [
          '-c', `mcp_servers.atris_workspace.command=${JSON.stringify(process.execPath)}`,
          '-c', `mcp_servers.atris_workspace.args=${JSON.stringify([coordination.script])}`,
          '-c', `mcp_servers.atris_workspace.env_vars=${JSON.stringify(Object.keys(coordinationEnv))}`,
          '-c', 'mcp_servers.atris_workspace.startup_timeout_sec=10',
        ] : []),
        ...(this.options.playwright ? [
          '-c', `mcp_servers.atris_playwright.command=${JSON.stringify(this.options.playwright.command)}`,
          '-c', `mcp_servers.atris_playwright.args=${JSON.stringify(this.options.playwright.args)}`,
          '-c', 'mcp_servers.atris_playwright.startup_timeout_sec=30',
        ] : []),
        ...(this.options.model ? ['-c', `model=${JSON.stringify(this.options.model)}`] : []),
        ...(this.options.reasoning ? ['-c', `model_reasoning_effort=${JSON.stringify(this.options.reasoning)}`] : []),
        '-c', `projects.${JSON.stringify(this.options.cwd)}.trust_level="trusted"`,
        '-c', `sandbox_mode=${JSON.stringify(sandbox)}`,
        '-c', `approval_policy=${JSON.stringify(mode === 'full-access' ? 'never' : 'on-request')}`,
        '-c', `approvals_reviewer=${JSON.stringify(mode === 'approve-for-me' ? 'auto_review' : 'user')}`],
      {cwd:this.options.cwd, env:{...codexChildEnvironment(this.options.env), ...coordinationEnv}, windowsHide:true, stdio:'pipe'});
      let chunks: Buffer[] = [], buffered = 0;
      this.child.stdout.on('data', (data: Buffer) => {
        let start = 0, end: number;
        while ((end = data.indexOf(10, start)) >= 0) {
          chunks.push(data.subarray(start, end)); buffered += end - start;
          if (buffered > MAX_RPC_BYTES) { void this.close('Codex exceeded the protocol frame size limit.'); return; }
          const line = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
          chunks = []; buffered = 0; start = end + 1;
          try { this.receive(JSON.parse(line.toString('utf8')), line); }
          catch { void this.close('Codex returned an invalid protocol frame.'); return; }
        }
        if (start < data.length) {chunks.push(data.subarray(start)); buffered += data.length - start;}
        if (buffered > MAX_RPC_BYTES) void this.close('Codex exceeded the protocol buffer size limit.');
      });
      // Drain without persisting potentially private provider diagnostics.
      this.child.stderr.resume();
      this.child.once('error', () => { void this.close('Could not start the Codex app-server.'); });
      this.child.once('exit', code => { void this.close(`Codex app-server exited (code ${code}).`); });
      await new Promise<void>((resolve, reject) => { this.child!.once('spawn', resolve); this.child!.once('error', reject); });
      return {url:`ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`, token:this.token};
    } catch (error) { await this.close(); throw error; }
  }

  private attach(client: WebSocket): void {
    if (this.closed || this.connected) { client.close(); return; }
    this.connected = true; this.client = client; clearTimeout(this.expiry);
    client.on('error', () => { void this.close('The Codex terminal control socket failed.'); });
    client.on('close', code => { void this.close(this.startupFailure || `Codex terminal disconnected (code ${code}).`); });
    client.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        const method = message.method;
        if (!method && message.id !== undefined) this.approvals.delete(JSON.stringify(message.id));
        const target = message.params?.threadId;
        if (this.threadId && target && target !== this.threadId && !this.helperThreads.has(target)) this.ambiguous = true;
        const user = ((method === 'thread/resume' || method === 'thread/fork') && !this.helperThreads.has(target)) ||
          (method === 'thread/start' && !message.params?.ephemeral && message.params?.threadSource === 'user');
        if (this.applying && (user || target === this.threadId) && ['thread/start','thread/resume','thread/fork','turn/start','turn/steer','thread/settings/update'].includes(method)) {
          this.sendClient({id:message.id, error:{code:-32000, message:'Permissions are being updated. Retry this action after the update.'}}); return;
        }
        if (method === 'initialize') {
          message.params.capabilities = {...message.params.capabilities, experimentalApi:true};
        }
        if (message.id !== undefined && method) {
          this.requests.set(JSON.stringify(message.id), {method, user});
          if (this.requests.size > 512) throw new Error('Too many pending requests');
          if (user) {
            // Remote TUI may downgrade its local bootstrap config to read-only.
            // The selected launch mode is explicit; ask Codex to enforce and report it.
            const mode = this.options.mode;
            message.params.permissions = profileIds[mode];
            delete message.params.sandbox;
            message.params.approvalPolicy = mode === 'full-access' ? 'never' : 'on-request';
            message.params.approvalsReviewer = mode === 'approve-for-me' ? 'auto_review' : 'user';
            message.params.cwd = this.options.cwd;
            message.params.runtimeWorkspaceRoots = [this.options.cwd];
          }
        }
        this.write(message);
      } catch { void this.close('The Codex terminal sent an invalid protocol request.'); }
    });
  }

  private write(message: Json): void {
    if (this.closed || !this.child || this.child.stdin.destroyed) throw unavailable('Codex control connection is closed.');
    if (this.child.stdin.writableLength > MAX_RPC_BYTES) {void this.close(); throw unavailable('Codex control connection is overloaded.');}
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private sendClient(message: Json, frame?: Buffer): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      if (this.client.bufferedAmount > MAX_RPC_BYTES) { void this.close('The Codex terminal stopped consuming output.'); return; }
      if (frame) this.client.send(frame, {binary:false});
      else this.client.send(JSON.stringify(message));
    }
  }
  private receive(message: Json, frame?: Buffer): void {
    const own = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
    if (own) {
      this.pending.delete(message.id); clearTimeout(own.timer);
      if (message.error) own.reject(unavailable(`Codex rejected the request: ${String(message.error.message).slice(0, 500)}`));
      else own.resolve(message.result);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const key = JSON.stringify(message.id), request = this.requests.get(key);
      this.requests.delete(key);
      if (request?.user && message.error) {
        const text = String(message.error.message || '');
        const kind = /no rollout found/i.test(text) ? 'the saved conversation was not found' :
          /modelProviderMismatch|provider.*mismatch/i.test(text) ? 'the saved provider does not match' :
          /permissions|sandbox/i.test(text) ? 'the permission configuration was rejected' : `RPC ${message.error.code}`;
        this.startupFailure = `Codex could not open the conversation: ${kind}. Check Code for details.`;
      }
      if (request?.method === 'initialize' && !message.error) this.initialized = true;
      if (request?.user && message.result?.thread?.id) {
        const id = message.result.thread.id;
        if (this.threadId && this.threadId !== id) this.ambiguous = true;
        this.threadId = id; this.generation++; this.revision++;
        const r = message.result;
        this.settings = {approvalPolicy:r.approvalPolicy, approvalsReviewer:r.approvalsReviewer, sandboxPolicy:r.sandbox, cwd:r.cwd};
        if (typeof r.thread.path === 'string') this.options.onThread(id, r.thread.path);
      } else if (request?.method === 'thread/start' && message.result?.thread?.id) {
        this.helperThreads.add(message.result.thread.id);
      }
    }
    const params = message.params;
    if (params?.threadId === this.threadId) {
      if (message.method === 'thread/settings/updated') {
        this.settings = params.threadSettings; this.revision++;
        const verification = this.verification;
        if (verification && verification.threadId === this.threadId) {
          this.verification = undefined;
          if (effectiveCodexMode(this.settings) === verification.mode) verification.resolve();
          else verification.reject(unavailable('Codex reported a different effective policy. The preference was not changed.'));
        }
      }
      if (message.method === 'turn/started') { this.active = true; this.providerRetry = false; this.activityAt = new Date().toISOString(); this.bindHistory(); }
      if (message.method === 'turn/completed') { this.active = false; this.hasCompletedTurn = true; this.providerRetry = false; this.activityAt = new Date().toISOString(); this.bindHistory(); }
      if (message.method === 'error' && params.willRetry) this.providerRetry = true;
      if (message.method === 'thread/status/changed') this.active = params.status?.type === 'active';
      if (message.method === 'thread/closed') { this.settings = undefined; this.generation++; }
      if (message.id !== undefined && message.method?.includes('requestApproval')) this.approvals.add(JSON.stringify(message.id));
      if (message.method === 'serverRequest/resolved') this.approvals.delete(JSON.stringify(params.requestId));
    }
    this.sendClient(message, frame);
  }
  private bindHistory(): void {
    if (!this.threadId || this.bindingPending || this.closed) return;
    const id = this.threadId;
    this.bindingPending = true;
    void this.rpc('thread/read', {threadId:id, includeTurns:false}).then(result => {
      if (result.thread?.id === id && typeof result.thread.path === 'string') this.options.onThread(id, result.thread.path);
    }).catch(() => {}).finally(() => {this.bindingPending = false;});
  }
  private rpc(method: string, params: Json): Promise<any> {
    const id = `atris-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(unavailable('Codex did not confirm the request before the timeout. Effective permissions are unknown.'));}, 8000);
      this.pending.set(id, {resolve, reject, timer});
      try {this.write({id, method, params});} catch (error) {clearTimeout(timer); this.pending.delete(id); reject(error);}
    });
  }
  status(): CodexLivePermissions {
    const reason = this.closed || !this.connected ? 'This terminal has no live Codex control connection. Reopen it once to enable live permissions.' :
      !this.initialized || !this.threadId || !this.settings ? 'Effective permissions are not verified. Finish setup or update permissions in Code.' :
      this.ambiguous ? 'Multiple conversations were opened in Code. Reopen this agent before changing permissions here.' :
      this.providerRetry && this.active ? 'Codex is retrying a provider request. Wait for the turn to finish.' :
      this.active || this.approvals.size ? 'Finish the active turn or pending approval before changing permissions.' : undefined;
    const transitioning = [...this.requests.values()].some(request => request.user || ['turn/start','turn/steer','thread/shellCommand'].includes(request.method));
    return {available:!reason && !transitioning, runtimeId:this.runtimeId, threadId:this.threadId, revision:this.revision,
      mode:effectiveCodexMode(this.settings), applying:this.applying, reason:reason || (transitioning ? 'Wait for the current Codex operation to settle.' : undefined),
      policy:this.settings ? {sandbox:this.settings.sandboxPolicy?.type, approval:this.settings.approvalPolicy, reviewer:this.settings.approvalsReviewer, cwd:this.settings.cwd} : undefined};
  }
  activity(): {state: string; at: string} {
    return {state:this.approvals.size ? 'attention' : this.active ? 'working' : this.hasCompletedTurn ? 'completed' : this.initialized ? 'ready' : 'unknown', at:this.activityAt};
  }
  async apply(input: {mode: unknown; runtimeId?: unknown; threadId?: unknown; revision?: unknown; fullAccessConfirmed?: unknown}): Promise<CodexLivePermissions> {
    if (!isCodexPermissionMode(input.mode)) throw unavailable('Invalid Codex permission mode.', 400);
    if (input.mode === 'full-access' && input.fullAccessConfirmed !== true) throw unavailable('Confirm Full Access before applying this mode.', 400);
    const status = this.status();
    if (!status.available) throw unavailable(status.reason!);
    if (this.applying) throw unavailable('A permission change is already in progress.');
    if (input.runtimeId !== this.runtimeId || input.threadId !== this.threadId || input.revision !== this.revision) throw unavailable('The Codex session or settings changed. Refresh permissions and try again.');
    const mode = input.mode, threadId = this.threadId!, generation = this.generation, previousRevision = this.revision;
    this.applying = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const confirmed = new Promise<void>((resolve, reject) => {
      this.verification = {threadId, mode, resolve, reject};
      timer = setTimeout(() => { this.verification = undefined; reject(unavailable('Codex did not confirm the effective policy. Refresh permissions before retrying.')); }, 8000);
    });
    try {
      await Promise.all([this.rpc('thread/settings/update', {threadId, permissions:profileIds[mode],
        approvalPolicy:mode === 'full-access' ? 'never' : 'on-request', approvalsReviewer:mode === 'approve-for-me' ? 'auto_review' : 'user'}), confirmed]);
      if (this.closed || generation !== this.generation) throw unavailable('The Codex session changed during the update.');
      if (effectiveCodexMode(this.settings) !== mode) throw unavailable('The effective Codex policy changed before confirmation completed.');
      return {...this.status(), applying:false};
    } catch (error) {
      // A lost reply can mean the server changed state. Never restore an old UI claim.
      if (this.revision === previousRevision) {this.settings = undefined; this.revision++;}
      throw error;
    } finally {clearTimeout(timer); this.verification = undefined; this.applying = false;}
  }
  isClosed(): boolean { return this.closed; }
  close(reason = 'The Codex runtime closed.'): Promise<void> {
    if (!this.closing) this.closing = this.stop(reason);
    return this.closing;
  }
  private async stop(reason: string): Promise<void> {
    this.closed = true; clearTimeout(this.expiry); this.generation++; this.settings = undefined;
    const error = unavailable('Codex disconnected. Effective permissions are unknown.');
    this.verification?.reject(error); this.verification = undefined;
    for (const p of this.pending.values()) {clearTimeout(p.timer); p.reject(error);} this.pending.clear();
    this.client?.terminate(); this.server.close();
    const child = this.child;
    if (child && child.exitCode === null && child.pid) {
      if (process.platform === 'win32') await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true, timeout:5000}, () => resolve()));
      child.kill();
      if (child.exitCode === null) await new Promise<void>(resolve => {
        const timer = setTimeout(done, 1000);
        function done() {clearTimeout(timer); child!.off('exit', done); resolve();}
        child.once('exit', done);
      });
    }
    this.options.onClosed?.();
    this.onClosed?.(reason);
  }
}

export class ManualCodexSessions {
  private sessions = new Map<string, ManualCodexSession>();
  private failures = new Map<string, string>();
  get(id: string): ManualCodexSession | undefined { return this.sessions.get(id); }
  failure(id: string): string | undefined { return this.failures.get(id); }
  async create(id: string, options: Options) {
    const previous = this.sessions.get(id);
    if (previous?.isClosed()) await previous.close();
    if (this.sessions.has(id)) throw unavailable('A Codex terminal is already open or starting for this agent.');
    this.failures.delete(id);
    const session = new ManualCodexSession(options); this.sessions.set(id, session);
    const endpoint = await session.start(reason => {if (this.sessions.get(id) === session) {this.sessions.delete(id); this.failures.set(id, reason); if(this.failures.size > 128)this.failures.delete(this.failures.keys().next().value!);}});
    return {...endpoint, runtimeId:session.runtimeId};
  }
  async closeAll(): Promise<void> { await Promise.all([...this.sessions.values()].map(session => session.close())); }
}
