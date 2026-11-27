import { randomBytes, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  v2FormAnswer,
  v2ModelRef,
  v2Questions,
  type V2Field,
} from '../../runtime-host/src/adapters/opencode-v2';
import {
  getFreePort,
  spawnHidden,
  terminateProcessTree,
} from '../../runtime-host/src/runtime-utils';
import type {
  ManualAgentActivitySummary,
  ManualMessage,
  ManualQuestion,
} from './manual-conversations';

const MARKER = '// AtrisAgent managed manual session bridge v1';
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 2000;
const MAX_DEDUPE_IDS = 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

const httpError = (message: string, status = 409): Error & { status: number } =>
  Object.assign(new Error(message), { status });

export interface OpenCodeV2InboxItem {
  id: string;
  text: string;
  delivery: 'queue' | 'steer';
  createdAt?: number;
}

export interface OpenCodeV2SessionOptions {
  agentId: string;
  dataDir: string;
  executable: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  reasoning?: string;
  coordination?: { endpoint: string; script: string; token: string; runtimeToken?: string };
  startupTimeoutMs?: number;
  onClosed?: () => void;
}

interface PendingPermission {
  id: string;
  action: string;
  message?: string;
}

interface PendingForm {
  id: string;
  title: string;
  fields: V2Field[];
  question: ManualQuestion;
  deliveryError?: string;
}

/**
 * Strip gateway-internal variables from child env while preserving user
 * provider credentials, XDG directories, and explicit overrides.
 */
export function openCodeChildEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      ([key]) => !key.toUpperCase().startsWith('ATRIS_') && key.toUpperCase() !== 'PORT',
    ),
  );
}

/**
 * Merge inherited OPENCODE_CONFIG_CONTENT with atris_workspace MCP server
 * inside api-gateway so inherited secrets never cross the UI boundary.
 */
export function buildOpenCodeV2ConfigContent(
  inheritedRaw: string | undefined,
  coordination?: { script: string },
): string | undefined {
  let base: Record<string, any> = {};
  if (typeof inheritedRaw === 'string' && inheritedRaw.trim()) {
    try {
      const parsed = JSON.parse(inheritedRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed;
      }
    } catch {
      if (!coordination) return inheritedRaw;
    }
  }
  if (!coordination) {
    return typeof inheritedRaw === 'string' && inheritedRaw.trim() ? inheritedRaw : undefined;
  }
  const existingMcp = base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp) ? base.mcp : {};
  const existingServers = existingMcp.servers && typeof existingMcp.servers === 'object' && !Array.isArray(existingMcp.servers)
    ? existingMcp.servers
    : {};
  return JSON.stringify({
    ...base,
    mcp: {
      ...existingMcp,
      servers: {
        ...existingServers,
        atris_workspace: {
          type: 'local',
          command: [process.execPath, coordination.script],
          disabled: false,
          codemode: false,
        },
      },
    },
  });
}

function assertNotSymlink(target: string): void {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`Managed OpenCode path must not be a symbolic link: ${target}`);
  }
}

function writeJsonAtomic(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.tmp`;
  assertNotSymlink(filename);
  assertNotSymlink(temp);
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, filename);
}

function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^ses_[a-zA-Z0-9_-]+$/.test(value);
}

function extractFilePaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['filePath', 'file_path', 'path', 'target_file', 'filename', 'file']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() && value.length <= 2048) {
      out.push(value.trim());
    }
  }
  return [...new Set(out)];
}

function normalizeInboxItem(raw: any): OpenCodeV2InboxItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.inboxID === 'string' ? raw.inboxID : undefined;
  const text = typeof raw.text === 'string' ? raw.text : typeof raw.content === 'string' ? raw.content : '';
  if (!id) return undefined;
  const delivery = raw.delivery === 'steer' ? 'steer' : 'queue';
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined;
  return { id, text, delivery, ...(createdAt !== undefined ? { createdAt } : {}) };
}

export class ManualOpenCodeV2Session {
  readonly runtimeId = randomUUID();
  readonly password = randomBytes(32).toString('base64url');
  private readonly authHeader = `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`;

  private child?: ChildProcess;
  private url = '';
  private sessionId?: string;
  private closed = false;
  private closing?: Promise<void>;
  private sseController?: AbortController;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private historyFlushTimer?: ReturnType<typeof setTimeout>;

  private autoApproveEnabled = false;
  private working = false;
  private hasCompletedTurn = false;
  private activityAt = new Date().toISOString();
  private routePending = false;
  private routeError?: string;

  private messageMap = new Map<string, ManualMessage>();
  private streamingTextByMsg = new Map<string, string>();
  private ephemeralStreamKeys = new Set<string>();
  private turnSeq = 0;
  private currentTurnStreamKey?: string;
  private pendingPermissions = new Map<string, PendingPermission>();
  private autoApprovedIds = new Set<string>();
  private pendingForms = new Map<string, PendingForm>();
  private inboxItems = new Map<string, OpenCodeV2InboxItem>();

  private readonly sessionDir: string;
  private readonly historyFile: string;
  private readonly fileEventsFile: string;

  constructor(private options: OpenCodeV2SessionOptions) {
    this.sessionDir = path.join(options.dataDir, 'manual-sessions', options.agentId);
    this.historyFile = path.join(this.sessionDir, 'opencode-history.json');
    this.fileEventsFile = path.join(this.sessionDir, 'opencode-file-events.jsonl');
  }

  async start(onClosed: (reason: string) => void): Promise<{ url: string; password: string; sessionId: string }> {
    fs.mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    const port = await getFreePort();
    this.url = `http://127.0.0.1:${port}`;

    const coordination = this.options.coordination;
    const coordinationEnv: Record<string, string> = coordination
      ? {
          ATRIS_CONTROL_PLANE_URL: coordination.endpoint,
          ATRIS_CONTROL_PLANE_TOKEN: coordination.token,
          ATRIS_MANUAL_COORDINATION: '1',
          ...(coordination.runtimeToken ? { ATRIS_RUNTIME_TOKEN: coordination.runtimeToken } : {}),
        }
      : {};
    const configContent = buildOpenCodeV2ConfigContent(process.env.OPENCODE_CONFIG_CONTENT, coordination);
    const childEnv: NodeJS.ProcessEnv = {
      ...openCodeChildEnvironment(this.options.env),
      ...coordinationEnv,
      ...(configContent ? { OPENCODE_CONFIG_CONTENT: configContent } : {}),
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: this.password,
    };

    const child = spawnHidden(
      this.options.executable,
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: this.options.cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.stdout?.resume();
    child.stderr?.resume();

    let exitError: Error | undefined;
    const exited = new Promise<never>((_, reject) => {
      const fail = (err: Error) => {
        exitError = err;
        reject(err);
      };
      child.once('error', (err) => fail(httpError(`OpenCode v2 server failed to start: ${err.message}`, 500)));
      child.once('exit', (code) => {
        const reason = `OpenCode v2 server exited (code ${code}).`;
        fail(httpError(reason, 500));
        if (!this.closed) void this.close(reason);
      });
    });

    try {
      await Promise.race([this.waitForHealth(this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS), exited]);
      if (exitError) throw exitError;

      let resumedSession = false;
      const saved = this.loadSavedHistory();
      if (saved.sessionId) {
        const res = await this.apiFetch(`/api/session/${encodeURIComponent(saved.sessionId)}`, { method: 'GET' }).catch(() => undefined);
        if (res?.ok) {
          const payload = await res.json().catch(() => undefined) as any;
          if (payload?.data?.id === saved.sessionId) {
            this.sessionId = saved.sessionId;
            resumedSession = true;
            for (const msg of saved.messages) this.messageMap.set(msg.id, msg);
          }
        }
      }

      if (!this.sessionId) {
        const modelRef = this.options.model ? v2ModelRef(this.options.model, this.options.reasoning) : undefined;
        const createRes = await this.apiFetch('/api/session', {
          method: 'POST',
          body: JSON.stringify({
            directory: this.options.cwd,
            ...(modelRef ? { model: modelRef } : {}),
          }),
        });
        if (!createRes.ok) {
          throw httpError(`OpenCode v2 session creation failed (${createRes.status}).`, 502);
        }
        const created = (await createRes.json()) as any;
        const newId = created?.data?.id;
        if (!isValidSessionId(newId)) {
          throw httpError('OpenCode v2 returned an invalid session identifier.', 502);
        }
        this.sessionId = newId;
      }

      this.persistHistorySync();
      if (resumedSession && this.options.model) {
        await this.switchModel(this.options.model, this.options.reasoning).catch(() => undefined);
      }
      await this.hydrateSessionState();
      this.startSseLoop(false);

      // Wire post-startup exit callback now that startup succeeded.
      void onClosed;
      this.exitCallback = onClosed;

      return { url: this.url, password: this.password, sessionId: this.sessionId };
    } catch (error) {
      await this.close('OpenCode v2 startup failed.');
      throw error;
    }
  }

  private exitCallback?: (reason: string) => void;

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      try {
        const res = await this.apiFetch('/api/info', { method: 'GET' }, 1500);
        if (res.ok) return;
      } catch {
        // Retry until deadline.
      }
      if (Date.now() >= deadline) {
        throw httpError('OpenCode v2 server did not become healthy before the startup deadline.', 504);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw httpError('OpenCode v2 session closed during startup.', 409);
  }

  private async apiFetch(pathname: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<globalThis.Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await fetch(`${this.url}${pathname}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: this.authHeader,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private loadSavedHistory(): { sessionId: string | null; messages: ManualMessage[] } {
    try {
      if (!fs.existsSync(this.historyFile)) return { sessionId: null, messages: [] };
      assertNotSymlink(this.historyFile);
      if (fs.statSync(this.historyFile).size > MAX_HISTORY_BYTES) return { sessionId: null, messages: [] };
      const record = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      if (!isValidSessionId(record?.sessionId)) return { sessionId: null, messages: [] };
      const messages = Array.isArray(record.messages)
        ? record.messages.filter(
            (m: any) =>
              m && typeof m.id === 'string' && typeof m.text === 'string' && ['user', 'assistant', 'tool'].includes(m.role),
          )
        : [];
      return { sessionId: record.sessionId, messages };
    } catch {
      return { sessionId: null, messages: [] };
    }
  }

  private persistHistorySync(): void {
    if (!this.sessionId) return;
    try {
      while (this.messageMap.size > MAX_MESSAGES) {
        const oldest = this.messageMap.keys().next().value;
        if (oldest === undefined) break;
        this.messageMap.delete(oldest);
      }
      writeJsonAtomic(this.historyFile, {
        marker: MARKER,
        sessionId: this.sessionId,
        messages: [...this.messageMap.values()].slice(-MAX_MESSAGES),
      });
    } catch {
      // History persistence failure must not break the active session.
    }
  }

  private scheduleHistoryFlush(): void {
    if (this.historyFlushTimer || this.closed) return;
    this.historyFlushTimer = setTimeout(() => {
      this.historyFlushTimer = undefined;
      this.persistHistorySync();
    }, 80);
    this.historyFlushTimer.unref?.();
  }

  private recordFileTouch(tool: string, rawPaths: string[]): void {
    if (!this.sessionId || !rawPaths.length) return;
    try {
      assertNotSymlink(this.fileEventsFile);
      const paths = [...new Set(rawPaths.filter((p) => typeof p === 'string' && p.trim() && p.length <= 2048).map((p) => p.trim()))];
      if (!paths.length) return;
      fs.appendFileSync(
        this.fileEventsFile,
        JSON.stringify({ sessionID: this.sessionId, tool: tool || 'tool', paths, at: new Date().toISOString() }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      // Best effort attribution log.
    }
  }

  private async hydrateSessionState(): Promise<void> {
    if (!this.sessionId || this.closed) return;
    const id = encodeURIComponent(this.sessionId);

    const [msgRes, inboxRes, permRes] = await Promise.all([
      this.apiFetch(`/api/session/${id}/message`, { method: 'GET' }).catch(() => undefined),
      this.apiFetch(`/api/session/${id}/inbox`, { method: 'GET' }).catch(() => undefined),
      this.apiFetch(`/api/session/${id}/permission`, { method: 'GET' }).catch(() => undefined),
    ]);

    if (msgRes?.ok) {
      const payload = (await msgRes.json().catch(() => undefined)) as any;
      if (Array.isArray(payload?.data)) {
        this.ingestMessagesSnapshot(payload.data);
      }
    }

    if (inboxRes?.ok) {
      const payload = (await inboxRes.json().catch(() => undefined)) as any;
      if (Array.isArray(payload?.data)) {
        this.inboxItems.clear();
        for (const raw of payload.data) {
          const item = normalizeInboxItem(raw);
          if (item) this.inboxItems.set(item.id, item);
        }
      }
    }

    if (permRes?.ok) {
      const payload = (await permRes.json().catch(() => undefined)) as any;
      if (Array.isArray(payload?.data)) {
        for (const raw of payload.data) {
          if (raw && typeof raw.id === 'string') {
            this.handlePermissionAsked({
              id: raw.id,
              action: typeof raw.action === 'string' ? raw.action : 'permission',
              message: typeof raw.message === 'string' ? raw.message : undefined,
            });
          }
        }
      }
    }
  }

  private ingestMessagesSnapshot(rows: any[]): number {
    let ingested = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const info = row.info && typeof row.info === 'object' ? row.info : row;
      const msgId = typeof info.id === 'string' ? info.id : typeof row.id === 'string' ? row.id : undefined;
      const role = info.role === 'user' || info.role === 'assistant'
        ? info.role
        : (row.role === 'user' || row.role === 'assistant' ? row.role : undefined);
      if (!msgId || !role) continue;
      const parts = Array.isArray(row.parts) ? row.parts : Array.isArray(info.parts) ? info.parts : undefined;
      const text = typeof row.text === 'string'
        ? row.text
        : typeof row.content === 'string'
          ? row.content
          : typeof info.text === 'string'
            ? info.text
            : typeof info.content === 'string'
              ? info.content
              : parts
                ? parts.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('')
                : '';
      if (text.trim()) {
        this.messageMap.set(`${this.sessionId}:${msgId}`, {
          id: `${this.sessionId}:${msgId}`,
          role,
          text: text.slice(0, 65536),
        });
        ingested++;
      }
    }
    this.scheduleHistoryFlush();
    return ingested;
  }

  private async refreshMessagesSnapshot(): Promise<void> {
    if (!this.sessionId || this.closed) return;
    try {
      const res = await this.apiFetch(`/api/session/${encodeURIComponent(this.sessionId)}/message`, { method: 'GET' });
      if (!res.ok) return;
      const payload = (await res.json().catch(() => undefined)) as any;
      if (Array.isArray(payload?.data) && payload.data.length > 0) {
        const ingested = this.ingestMessagesSnapshot(payload.data);
        if (ingested > 0) {
          for (const key of this.ephemeralStreamKeys) {
            this.messageMap.delete(key);
          }
          this.ephemeralStreamKeys.clear();
        }
        this.persistHistorySync();
      }
    } catch {
      // Best effort reconciliation.
    }
  }

  private startSseLoop(isReconnect = false): void {
    if (this.closed) return;
    if (isReconnect) {
      void this.hydrateSessionState();
    }
    this.sseController = new AbortController();
    void this.consumeSse(this.sseController.signal).finally(() => {
      if (!this.closed && this.child && this.child.exitCode === null) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          this.startSseLoop(true);
        }, 500);
        this.reconnectTimer.unref?.();
      }
    });
  }

  private async consumeSse(signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch(`${this.url}/api/event`, {
        method: 'GET',
        signal,
        headers: {
          Authorization: this.authHeader,
          Accept: 'text/event-stream',
        },
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.closed && !signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          buffer = '';
          break;
        }
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, boundary);
          const sepMatch = buffer.slice(boundary).match(/^\r?\n\r?\n/);
          buffer = buffer.slice(boundary + (sepMatch ? sepMatch[0].length : 2));
          this.processSseFrame(frame);
        }
      }
    } catch {
      // Reconnect handled in finally if still open.
    }
  }

  private processSseFrame(frame: string): void {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (!dataLines.length) return;
    let event: any;
    try {
      event = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    this.handleEvent(event);
  }

  private handleEvent(event: any): void {
    const type = typeof event.type === 'string' ? event.type : '';
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const formObj = data.form && typeof data.form === 'object' ? data.form : undefined;
    const eventSessionId = formObj?.sessionID || data.sessionID || data.sessionId;
    if (eventSessionId && eventSessionId !== this.sessionId) return;

    const nowIso = new Date().toISOString();

    switch (type) {
      case 'session.execution.started':
        this.working = true;
        this.activityAt = nowIso;
        this.turnSeq++;
        this.currentTurnStreamKey = `stream:${this.turnSeq}`;
        break;

      case 'session.execution.succeeded':
        this.working = false;
        this.hasCompletedTurn = true;
        this.activityAt = nowIso;
        this.currentTurnStreamKey = undefined;
        this.streamingTextByMsg.clear();
        this.persistHistorySync();
        void this.refreshMessagesSnapshot();
        break;

      case 'session.execution.failed':
      case 'session.execution.interrupted':
        this.working = false;
        this.hasCompletedTurn = true;
        this.activityAt = nowIso;
        this.currentTurnStreamKey = undefined;
        this.streamingTextByMsg.clear();
        this.persistHistorySync();
        void this.refreshMessagesSnapshot();
        break;

      case 'session.text.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (!delta || !this.sessionId) break;
        const canonicalId = typeof data.messageID === 'string' && data.messageID ? data.messageID : undefined;
        const key = canonicalId ?? (this.currentTurnStreamKey ||= `stream:${++this.turnSeq}`);
        const nextText = ((this.streamingTextByMsg.get(key) || '') + delta).slice(0, 65536);
        this.streamingTextByMsg.set(key, nextText);
        const id = `${this.sessionId}:${key}`;
        if (!canonicalId) this.ephemeralStreamKeys.add(id);
        this.messageMap.set(id, { id, role: 'assistant', text: nextText });
        this.scheduleHistoryFlush();
        break;
      }

      case 'session.message.created':
      case 'session.message.updated': {
        const msg = data.message && typeof data.message === 'object' ? data.message : data;
        this.ingestMessagesSnapshot([msg]);
        break;
      }

      case 'session.tool.called':
      case 'session.tool.success':
      case 'session.tool.failed': {
        if (!this.sessionId || typeof data.id !== 'string') break;
        const toolName = (typeof data.tool === 'string' && data.tool) || (typeof data.name === 'string' && data.name) || 'Tool';
        if (type === 'session.tool.called') {
          const touched = extractFilePaths(data.input);
          if (touched.length) this.recordFileTouch(toolName, touched);
        }
        const statusLabel = type === 'session.tool.called' ? 'running' : type === 'session.tool.success' ? 'completed' : 'error';
        const id = `${this.sessionId}:tool:${data.id}`;
        this.messageMap.set(id, {
          id,
          role: 'tool',
          toolName,
          text: `Tool ${statusLabel}. Open Code for output and approvals.`,
          failed: type === 'session.tool.failed',
        });
        this.scheduleHistoryFlush();
        break;
      }

      case 'file.edited': {
        const files = [
          ...(typeof data.file === 'string' ? [data.file] : []),
          ...(typeof data.path === 'string' ? [data.path] : []),
          ...(Array.isArray(data.files) ? data.files.filter((f: unknown): f is string => typeof f === 'string') : []),
        ];
        if (files.length) this.recordFileTouch('file.edited', files);
        break;
      }

      case 'permission.asked': {
        if (typeof data.id !== 'string') break;
        this.handlePermissionAsked({
          id: data.id,
          action: typeof data.action === 'string' ? data.action : 'permission',
          message: typeof data.message === 'string' ? data.message : undefined,
        });
        break;
      }

      case 'permission.replied': {
        if (typeof data.id === 'string') {
          this.pendingPermissions.delete(data.id);
          this.activityAt = nowIso;
        }
        break;
      }

      case 'form.created': {
        const form = formObj || data;
        if (typeof form.id !== 'string' || !Array.isArray(form.fields)) break;
        const title = typeof form.title === 'string' ? form.title : 'Question';
        const questions = v2Questions(form.fields as V2Field[], title);
        if (!questions) break;
        this.pendingForms.set(form.id, {
          id: form.id,
          title,
          fields: form.fields as V2Field[],
          question: { id: form.id, questions },
        });
        this.activityAt = nowIso;
        break;
      }

      case 'form.replied':
      case 'form.cancelled': {
        if (typeof data.id === 'string') {
          this.pendingForms.delete(data.id);
          this.activityAt = nowIso;
        }
        break;
      }

      case 'session.inbox.enqueued': {
        const item = normalizeInboxItem(data.item || data);
        if (item) this.inboxItems.set(item.id, item);
        break;
      }

      case 'session.inbox.delivery.changed': {
        const item = normalizeInboxItem(data.item || data);
        if (item) {
          this.inboxItems.set(item.id, item);
        } else if (typeof data.id === 'string' && (data.delivery === 'steer' || data.delivery === 'queue')) {
          const existing = this.inboxItems.get(data.id);
          if (existing) this.inboxItems.set(data.id, { ...existing, delivery: data.delivery });
        }
        break;
      }

      case 'session.inbox.delivered':
      case 'session.inbox.cancelled': {
        const id = typeof data.id === 'string' ? data.id : typeof data.inboxID === 'string' ? data.inboxID : undefined;
        if (id) this.inboxItems.delete(id);
        break;
      }
    }
  }

  private handlePermissionAsked(perm: PendingPermission): void {
    this.pendingPermissions.set(perm.id, perm);
    this.activityAt = new Date().toISOString();
    if (this.autoApproveEnabled) {
      void this.autoApprovePermission(perm.id);
    }
  }

  private async autoApprovePermission(requestId: string): Promise<void> {
    if (this.closed || !this.sessionId || this.autoApprovedIds.has(requestId)) return;
    this.autoApprovedIds.add(requestId);
    while (this.autoApprovedIds.size > MAX_DEDUPE_IDS) {
      const oldest = this.autoApprovedIds.values().next().value;
      if (oldest === undefined) break;
      this.autoApprovedIds.delete(oldest);
    }
    try {
      const res = await this.apiFetch(
        `/api/session/${encodeURIComponent(this.sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
        {
          method: 'POST',
          body: JSON.stringify({ decision: 'once' }),
        },
      );
      if (res.ok || res.status === 404 || res.status === 409) {
        this.pendingPermissions.delete(requestId);
      }
    } catch {
      // Ignore transient auto-approve errors.
    }
  }

  autoApprove(): { available: boolean; enabled: boolean; error?: string } {
    return {
      available: !this.closed && Boolean(this.sessionId),
      enabled: this.autoApproveEnabled,
    };
  }

  setAutoApprove(enabled: unknown): void {
    if (typeof enabled !== 'boolean') {
      throw httpError('Invalid OpenCode permission mode.', 400);
    }
    if (this.closed || !this.sessionId) {
      throw httpError('Open this OpenCode agent before changing permissions.', 409);
    }
    this.autoApproveEnabled = enabled;
    if (enabled) {
      for (const permId of this.pendingPermissions.keys()) {
        void this.autoApprovePermission(permId);
      }
    }
  }

  activity(): ManualAgentActivitySummary {
    const firstForm = this.pendingForms.values().next().value as PendingForm | undefined;
    if (firstForm) {
      const preview = firstForm.question.questions[0]?.question || firstForm.title;
      return {
        state: 'attention',
        at: this.activityAt,
        attentionKind: 'question',
        attentionPreview: preview.slice(0, 140),
      };
    }
    if (this.pendingPermissions.size > 0 && !this.autoApproveEnabled) {
      const firstPerm = this.pendingPermissions.values().next().value as PendingPermission;
      return {
        state: 'attention',
        at: this.activityAt,
        attentionKind: 'approval',
        attentionPreview: (firstPerm.message || `Permission requested: ${firstPerm.action}`).slice(0, 140),
      };
    }
    const state = this.working
      ? 'working'
      : this.hasCompletedTurn
        ? 'completed'
        : this.sessionId
          ? 'ready'
          : 'unknown';
    return { state, at: this.activityAt };
  }

  messages(): { messages: ManualMessage[]; truncated: boolean; bound: boolean } {
    const list = [...this.messageMap.values()];
    return {
      messages: list,
      truncated: list.length >= MAX_MESSAGES,
      bound: Boolean(this.sessionId),
    };
  }

  pendingQuestions(): ManualQuestion[] {
    return [...this.pendingForms.values()].map((form) => ({
      ...form.question,
      ...(form.deliveryError ? { deliveryError: form.deliveryError } : {}),
    }));
  }

  inbox(): OpenCodeV2InboxItem[] {
    return [...this.inboxItems.values()];
  }

  routeStatus(): { pending: boolean; error?: string } {
    return {
      pending: this.routePending,
      ...(this.routeError ? { error: this.routeError } : {}),
    };
  }

  async switchModel(model: string, reasoning?: string): Promise<void> {
    if (this.closed || !this.sessionId) {
      throw httpError('OpenCode v2 session is not active.', 409);
    }
    const modelRef = v2ModelRef(model, reasoning);
    this.routePending = true;
    this.routeError = undefined;
    try {
      const res = await this.apiFetch(`/api/session/${encodeURIComponent(this.sessionId)}/model`, {
        method: 'POST',
        body: JSON.stringify({ model: modelRef }),
      });
      if (!res.ok) {
        const msg = `OpenCode rejected the model switch (${res.status}).`;
        this.routeError = msg;
        throw httpError(msg, res.status >= 400 && res.status < 500 ? res.status : 502);
      }
    } finally {
      this.routePending = false;
    }
  }

  async sendPrompt(text: string, delivery?: 'queue' | 'steer'): Promise<void> {
    if (this.closed || !this.sessionId) {
      throw httpError('Open this OpenCode agent before sending prompts.', 409);
    }
    const res = await this.apiFetch(`/api/session/${encodeURIComponent(this.sessionId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text, ...(delivery ? { delivery } : {}) }),
    });
    if (!res.ok) {
      throw httpError(`OpenCode rejected the prompt (${res.status}).`, res.status >= 400 && res.status < 500 ? res.status : 502);
    }
  }

  async steerInbox(inboxId: string): Promise<void> {
    if (this.closed || !this.sessionId) {
      throw httpError('OpenCode v2 session is not active.', 409);
    }
    const res = await this.apiFetch(
      `/api/session/${encodeURIComponent(this.sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ delivery: 'steer' }),
      },
    );
    if (!res.ok) {
      throw httpError(`OpenCode could not steer inbox item (${res.status}).`, res.status === 404 ? 404 : 502);
    }
    const existing = this.inboxItems.get(inboxId);
    if (existing) this.inboxItems.set(inboxId, { ...existing, delivery: 'steer' });
  }

  async cancelInbox(inboxId: string): Promise<void> {
    if (this.closed || !this.sessionId) {
      throw httpError('OpenCode v2 session is not active.', 409);
    }
    const res = await this.apiFetch(
      `/api/session/${encodeURIComponent(this.sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) {
      throw httpError(`OpenCode could not cancel inbox item (${res.status}).`, 502);
    }
    this.inboxItems.delete(inboxId);
  }

  async replyQuestion(formId: string, answers: unknown): Promise<void> {
    if (this.closed || !this.sessionId) {
      throw httpError('OpenCode v2 session is not active.', 409);
    }
    const form = this.pendingForms.get(formId);
    if (!form) {
      throw httpError('This question is no longer pending.', 409);
    }
    if (!Array.isArray(answers)) {
      throw httpError('Select an answer for each question.', 400);
    }
    let answerPayload: Record<string, unknown>;
    try {
      answerPayload = v2FormAnswer(form.fields, answers as string[][]);
    } catch (error: any) {
      throw httpError(error?.message || 'Invalid form answers.', 400);
    }
    const res = await this.apiFetch(
      `/api/session/${encodeURIComponent(this.sessionId)}/form/${encodeURIComponent(formId)}/reply`,
      {
        method: 'POST',
        body: JSON.stringify({ answer: answerPayload }),
      },
    );
    if (!res.ok) {
      const msg = 'OpenCode did not accept the answer. Retry or answer in Code.';
      form.deliveryError = msg;
      throw httpError(msg, res.status === 404 || res.status === 409 ? 409 : 502);
    }
    this.pendingForms.delete(formId);
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(reason = 'The OpenCode v2 runtime closed.'): Promise<void> {
    if (!this.closing) {
      this.closing = this.stop(reason);
    }
    return this.closing;
  }

  private async stop(reason: string): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.historyFlushTimer) {
      clearTimeout(this.historyFlushTimer);
      this.historyFlushTimer = undefined;
    }
    this.persistHistorySync();
    this.sseController?.abort();
    const child = this.child;
    if (child) {
      await terminateProcessTree(child, true).catch(() => undefined);
    }
    this.options.onClosed?.();
    this.exitCallback?.(reason);
  }
}

export class ManualOpenCodeV2Sessions {
  private sessions = new Map<string, ManualOpenCodeV2Session>();
  private failures = new Map<string, string>();

  get(id: string): ManualOpenCodeV2Session | undefined {
    return this.sessions.get(id);
  }

  failure(id: string): string | undefined {
    return this.failures.get(id);
  }

  async create(id: string, options: OpenCodeV2SessionOptions) {
    const previous = this.sessions.get(id);
    if (previous?.isClosed()) {
      await previous.close();
      if (this.sessions.get(id) === previous) this.sessions.delete(id);
    }
    if (this.sessions.has(id)) {
      throw httpError('An OpenCode terminal is already open or starting for this agent.', 409);
    }
    this.failures.delete(id);
    const session = new ManualOpenCodeV2Session(options);
    this.sessions.set(id, session);
    try {
      const endpoint = await session.start((reason) => {
        if (this.sessions.get(id) === session) {
          this.sessions.delete(id);
          this.failures.set(id, reason);
          if (this.failures.size > 128) {
            const oldest = this.failures.keys().next().value;
            if (oldest !== undefined) this.failures.delete(oldest);
          }
        }
      });
      return { ...endpoint, runtimeId: session.runtimeId };
    } catch (error) {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
  }
}
