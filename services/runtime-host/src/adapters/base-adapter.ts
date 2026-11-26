import fs from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent, QuestionAsked } from '@atris-agent-code/event-schema';
import type {
  RuntimeAdapter,
  CapabilitySnapshot,
  StartSessionRequest,
  AgentInput,
  ApprovalDecision,
  UsageSnapshot,
  ModelDescriptor,
  AccountProfile,
  AccountProfileStatus,
  AgentSession,
  RuntimeType,
  AgentRole,
  InstallationStatus,
  AuthMethodDescriptor,
  AuthInitiationResult,
  AuthPollResult,
  CodexPermissionMode,
  ProviderAttachment,
  RuntimeAdapterCapabilities,
} from '@atris-agent-code/domain';
import { terminateProcessTree } from '../runtime-utils';

export interface SpawnAgentOptions {
  sessionId?: string;
  attemptId?: string;
  runId?: string;
  taskId: string;
  missionId: string;
  prompt: string;
  role?: AgentRole | string;
  accessMode?: 'read-only' | 'workspace-write';
  /** Opt-in planning preferences, applied when spawning the next turn. */
  planningControls?: { codexPermissionMode?: CodexPermissionMode };
  model?: string;
  reasoningLevel?: string;
  isolated?: boolean;
  worktreePath?: string;
  cwd?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enableCoordinationMcp?: boolean;
  mcpServerScript?: string;
  mcpConfigPath?: string;
  profileId?: string;
  /** Optional named profile metadata; account profileId remains provider routing identity. */
  agentProfileId?: string;
  profileName?: string;
  specialty?: string;
  profileInstructions?: string;
  profileCapabilities?: string[];
  allowedRoutePolicy?: Record<string, unknown>;
  providerSessionId?: string;
  preserveProviderSession?: boolean;
  attachments?: ProviderAttachment[];
}

export interface StagedWorkspaceAttachment {
  attachment: ProviderAttachment;
  relativePath: string;
  stagedPath: string;
}

/** Returns attachments whose resolved `providerPath` points to an existing regular file. */
export function validateLocalAttachments(attachments?: ProviderAttachment[]): ProviderAttachment[] {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  const valid: ProviderAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.providerPath !== 'string') continue;
    const rawPath = attachment.providerPath.trim();
    if (!rawPath || rawPath.includes('\0')) continue;
    const resolved = path.resolve(rawPath);
    try {
      if (fs.statSync(resolved).isFile()) {
        valid.push({ ...attachment, providerPath: resolved });
      }
    } catch {
      // Skip missing or inaccessible attachment files.
    }
  }
  return valid;
}

function sanitizeAttachmentFilename(rawName: string | undefined, fallbackId: string): string {
  const normalized = String(rawName || '').replace(/[\0\r\n]/g, '').trim();
  const base = path.basename(normalized.replace(/\\/g, '/'));
  const cleaned = base.replace(/^\.+/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    const safeId = String(fallbackId || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
    return safeId;
  }
  return cleaned;
}

export interface StagedWorkspaceAttachments {
  staged: StagedWorkspaceAttachment[];
  cleanup: () => void;
}

/**
 * Safely copies validated attachments into `<workspacePath>/.atris-attachments/`
 * with strict path-traversal guards so CLI runtimes without native file parts
 * can inspect them inside their assigned workspace, and returns an idempotent
 * `cleanup()` handle so staged files never pollute Git repos/worktrees.
 */
export function stageWorkspaceAttachments(
  workspacePath: string,
  attachments?: ProviderAttachment[],
): StagedWorkspaceAttachments {
  const valid = validateLocalAttachments(attachments);
  if (!valid.length) return { staged: [], cleanup: () => undefined };
  const workspaceRoot = path.resolve(workspacePath);
  const stageDir = path.resolve(workspaceRoot, '.atris-attachments');
  const stageRel = path.relative(workspaceRoot, stageDir);
  if (!stageRel || stageRel.startsWith('..') || path.isAbsolute(stageRel)) {
    throw new Error('Invalid attachment staging directory.');
  }
  fs.mkdirSync(stageDir, { recursive: true });
  const usedNames = new Set<string>();
  const staged: StagedWorkspaceAttachment[] = [];
  for (let index = 0; index < valid.length; index += 1) {
    const attachment = valid[index];
    let fileName = sanitizeAttachmentFilename(attachment.name, attachment.id || `file-${index + 1}`);
    if (usedNames.has(fileName.toLowerCase())) {
      fileName = `${index + 1}-${fileName}`;
    }
    usedNames.add(fileName.toLowerCase());
    const targetPath = path.resolve(stageDir, fileName);
    const relativeToStage = path.relative(stageDir, targetPath);
    if (!relativeToStage || relativeToStage.startsWith('..') || path.isAbsolute(relativeToStage) || relativeToStage !== fileName) {
      throw new Error(`Refusing unsafe attachment path for ${attachment.name}`);
    }
    fs.copyFileSync(attachment.providerPath, targetPath);
    staged.push({
      attachment,
      relativePath: `.atris-attachments/${fileName}`,
      stagedPath: targetPath,
    });
  }
  let cleaned = false;
  return {
    staged,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      for (const item of staged) {
        try {
          fs.rmSync(item.stagedPath, { force: true, maxRetries: 3, retryDelay: 30 });
        } catch {
          // Best-effort cleanup on Windows file locks.
        }
      }
      try {
        if (fs.existsSync(stageDir) && fs.readdirSync(stageDir).length === 0) {
          fs.rmdirSync(stageDir);
        }
      } catch {
        // Leave non-empty or concurrently used directory intact.
      }
    },
  };
}

export function appendStagedAttachmentsToPrompt(prompt: string, staged: StagedWorkspaceAttachment[]): string {
  if (!staged.length) return prompt;
  const lines = staged.map(
    ({ attachment, relativePath }) =>
      `- ${relativePath} (${attachment.name || path.basename(relativePath)}, ${attachment.mimeType || 'application/octet-stream'}, ${attachment.byteSize} bytes)`,
  );
  return `${prompt}\n\n[Attachments staged in workspace]\n${lines.join('\n')}`;
}

export interface SessionContinuityCapabilities {
  reuseWhileAlive: boolean;
  resumeAfterRestart: boolean;
}

export function isReadOnlyAgentRole(role?: string): boolean {
  return ['orchestrator', 'reviewer', 'researcher', 'qa'].includes(String(role || '').toLowerCase());
}

export abstract class BaseRuntimeAdapter implements RuntimeAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly runtimeType: RuntimeType;

  protected eventBus?: LocalEventBus;
  protected activeProcesses: Map<string, ChildProcess> = new Map();
  protected activeSessions: Map<string, AgentSession> = new Map();
  protected stdoutBuffers: Map<string, string> = new Map();
  protected stderrBuffers: Map<string, string> = new Map();
  private cancelledSessions = new Set<string>();
  private reportedUsage = new Map<string, UsageSnapshot>();
  private reportedUsageByMessage = new Map<string, Map<string, UsageSnapshot>>();

  constructor(eventBus?: LocalEventBus) {
    this.eventBus = eventBus;
  }

  setEventBus(eventBus: LocalEventBus): void {
    this.eventBus = eventBus;
  }

  /** Allows adapters to receive non-secret profile routing metadata before auth/model/session operations. */
  configureProfile(_profile: AccountProfile): void {
    // Optional adapter hook.
  }

  protected emitEvent(event: AgentEvent): void {
    if (this.eventBus) {
      this.eventBus.emit(event);
    }
  }

  protected registerProcess(sessionId: string, child: ChildProcess): void {
    this.activeProcesses.set(sessionId, child);
  }

  protected unregisterProcess(sessionId: string): void {
    this.activeProcesses.delete(sessionId);
  }

  protected markSessionCancelled(sessionId: string): void {
    this.cancelledSessions.add(sessionId);
  }

  protected isSessionCancelled(sessionId: string): boolean {
    return this.cancelledSessions.has(sessionId);
  }

  protected clearSessionCancellation(sessionId: string): void {
    this.cancelledSessions.delete(sessionId);
  }

  isSessionAlive(sessionId: string): boolean {
    const child = this.activeProcesses.get(sessionId);
    return child ? child.exitCode === null && !child.killed : this.activeSessions.has(sessionId);
  }

  /** Returns null when this runtime has no safe out-of-band session probe. */
  async probeSessionResponsiveness(_sessionId: string): Promise<boolean | null> {
    return null;
  }

  getSessionContinuityCapabilities(): SessionContinuityCapabilities {
    return { reuseWhileAlive: false, resumeAfterRestart: false };
  }

  /** Explicit runtime capability matrix used for orchestration & policy degradation. */
  getAdapterCapabilities(): RuntimeAdapterCapabilities {
    const continuity = this.getSessionContinuityCapabilities();
    return {
      liveSteer: false,
      interactiveApproval: false,
      sessionResume: continuity.resumeAfterRestart,
      reuseWhileAlive: continuity.reuseWhileAlive,
      nativeAttachments: false,
    };
  }

  getPendingQuestion(_sessionId: string, _requestId: string): QuestionAsked | undefined {
    return undefined;
  }

  isAwaitingUser(_sessionId: string): boolean {
    return false;
  }

  async respondToQuestion(_sessionId: string, _requestId: string, _answers: string[][]): Promise<void> {
    throw new Error(`${this.name} does not support native interactive questions in this execution mode.`);
  }

  async rejectQuestion(_sessionId: string, _requestId: string): Promise<void> {
    throw new Error(`${this.name} does not support native question cancellation in this execution mode.`);
  }

  async probeProviderSession(_providerSessionId: string, _options?: { profileId?: string; cwd?: string }): Promise<boolean> {
    return false;
  }

  async releaseProviderSession(_providerSessionId: string): Promise<void> {
    // Optional provider-session cleanup hook.
  }

  // 1. Installation Discovery
  abstract discoverInstallation(profileId?: string): Promise<InstallationStatus>;

  // 2. Capability Probe
  abstract probeCapabilities(profileId?: string): Promise<CapabilitySnapshot>;
  async getCapabilities(): Promise<CapabilitySnapshot> {
    return this.probeCapabilities();
  }

  // 3. Auth Methods & Management
  abstract getAuthMethods(): Promise<AuthMethodDescriptor[]>;
  abstract beginAuthentication(method?: string, options?: Record<string, unknown>): Promise<AuthInitiationResult>;
  abstract pollAuthentication(authId: string): Promise<AuthPollResult>;
  abstract verifyAuthentication(profileId?: string): Promise<AccountProfileStatus>;
  abstract logout(profileId?: string): Promise<void>;

  // 4. Model & Account Discovery
  abstract discoverModels(profileId?: string): Promise<ModelDescriptor[]>;
  abstract discoverAccounts(): Promise<AccountProfile[]>;

  // 5. Usage Discovery
  abstract discoverUsage(sessionId?: string): Promise<UsageSnapshot | null>;
  async getUsage(sessionId: string): Promise<UsageSnapshot | null> {
    const reported = this.reportedUsage.get(sessionId);
    if (reported) {
      this.reportedUsage.delete(sessionId);
      this.reportedUsageByMessage.delete(sessionId);
      return reported;
    }
    this.reportedUsageByMessage.delete(sessionId);
    return this.discoverUsage(sessionId);
  }

  protected recordProviderUsage(
    sessionId: string,
    payload: unknown,
    options?: { accumulate?: boolean; messageId?: string },
  ): void {
    const usage = providerUsageFromPayload(payload);
    if (!usage) return;
    if (!options?.accumulate) {
      this.reportedUsage.set(sessionId, usage);
      return;
    }
    let byMessage = this.reportedUsageByMessage.get(sessionId);
    if (!byMessage) {
      byMessage = new Map<string, UsageSnapshot>();
      this.reportedUsageByMessage.set(sessionId, byMessage);
    }
    const key = options.messageId ? `msg:${options.messageId}` : `anon:${byMessage.size + 1}`;
    byMessage.set(key, usage);
    this.reportedUsage.set(sessionId, sumUsageSnapshots(byMessage.values()));
  }

  // 6. Session Lifecycle
  abstract startSession(request: StartSessionRequest): Promise<AgentSession>;

  async resumeSession(sessionId: string): Promise<AgentSession> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found in adapter ${this.name}`);
    }
    return session;
  }

  // 7. Input / Communication
  abstract sendInput(sessionId: string, input: AgentInput): Promise<void>;
  async sendMessage(sessionId: string, input: AgentInput): Promise<void> {
    return this.sendInput(sessionId, input);
  }

  // 8. Event Streaming
  abstract streamEvents(sessionId: string): AsyncIterable<AgentEvent>;

  // 9. Interactive Approvals
  abstract respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  async approveToolCall(requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.respondToApproval(requestId, decision);
  }

  // 10. Cancellation & Shutdown
  async cancel(sessionId: string): Promise<void> {
    this.markSessionCancelled(sessionId);
    const process = this.activeProcesses.get(sessionId);
    if (process) {
      await terminateProcessTree(process);
      this.activeProcesses.delete(sessionId);
    }
    this.activeSessions.delete(sessionId);
    this.reportedUsage.delete(sessionId);
    this.reportedUsageByMessage.delete(sessionId);
  }

  async cancelRun(runId: string): Promise<void> {
    return this.cancel(runId);
  }

  async shutdown(): Promise<void> {
    for (const [sessionId, child] of this.activeProcesses.entries()) {
      this.markSessionCancelled(sessionId);
      await terminateProcessTree(child, true);
    }
    this.activeProcesses.clear();
    this.activeSessions.clear();
    this.reportedUsage.clear();
    this.reportedUsageByMessage.clear();
  }

  async openDeveloperConsole(_sessionId: string): Promise<void> {
    // Developer console hook for desktop UI
  }

  // CLI Process Helper for child-process-based adapters
  abstract spawnAgent(options: SpawnAgentOptions): Promise<AgentSession>;
}

function sumUsageSnapshots(snapshots: Iterable<UsageSnapshot>): UsageSnapshot {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let hasCached = false;
  let reasoningTokens = 0;
  let hasReasoning = false;
  let totalCost = 0;
  let hasCost = false;
  let currency = '';
  let timestamp = new Date().toISOString();

  for (const snap of snapshots) {
    inputTokens += snap.inputTokens;
    outputTokens += snap.outputTokens;
    if (snap.cachedTokens !== undefined) {
      cachedTokens += snap.cachedTokens;
      hasCached = true;
    }
    if (snap.reasoningTokens !== undefined) {
      reasoningTokens += snap.reasoningTokens;
      hasReasoning = true;
    }
    if (snap.totalCost !== null) {
      totalCost += snap.totalCost;
      hasCost = true;
    }
    if (snap.currency) currency = snap.currency;
    if (snap.timestamp) timestamp = snap.timestamp;
  }

  return {
    inputTokens,
    outputTokens,
    ...(hasCached ? { cachedTokens } : {}),
    ...(hasReasoning ? { reasoningTokens } : {}),
    totalCost: hasCost ? totalCost : null,
    currency,
    timestamp,
  };
}

function providerUsageFromPayload(payload: unknown): UsageSnapshot | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, any>;
  const candidates = [root.usage, root.tokens, root.token_usage, root.tokenUsage, root.metrics, root.result?.usage, root.message?.usage]
    .filter((value): value is Record<string, any> => Boolean(value && typeof value === 'object'));
  for (const usage of candidates) {
    const input = finiteNumber(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens, usage.input);
    const output = finiteNumber(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens, usage.output);
    if (input === undefined && output === undefined) continue;

    const cacheRead = finiteNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens, usage.cache?.read);
    const cacheWrite = finiteNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens, usage.cache?.write);
    const directCached = finiteNumber(usage.cached_input_tokens, usage.cachedTokens);
    const cached = (cacheRead !== undefined || cacheWrite !== undefined)
      ? Math.max(0, (cacheRead || 0) + (cacheWrite || 0))
      : directCached !== undefined
        ? Math.max(0, directCached)
        : undefined;

    const reasoning = finiteNumber(usage.reasoning_output_tokens, usage.reasoningTokens, usage.reasoning_tokens, usage.reasoning);
    const cost = finiteNumber(root.total_cost_usd, root.totalCostUsd, usage.total_cost, usage.totalCost, usage.cost, root.cost);
    const currency = stringValue(usage.currency, root.currency) || (root.total_cost_usd != null || root.totalCostUsd != null ? 'USD' : '');
    return {
      inputTokens: Math.max(0, input || 0),
      outputTokens: Math.max(0, output || 0),
      ...(cached !== undefined ? { cachedTokens: cached } : {}),
      ...(reasoning !== undefined ? { reasoningTokens: Math.max(0, reasoning) } : {}),
      totalCost: cost === undefined ? null : Math.max(0, cost),
      currency,
      timestamp: new Date().toISOString(),
    };
  }
  return null;
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}
