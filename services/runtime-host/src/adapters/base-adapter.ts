import type { ChildProcess } from 'child_process';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
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
} from '@atris-agent-code/domain';
import { terminateProcessTree } from '../runtime-utils';

export interface SpawnAgentOptions {
  sessionId?: string;
  taskId: string;
  missionId: string;
  prompt: string;
  role?: AgentRole | string;
  accessMode?: 'read-only' | 'workspace-write';
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
      return reported;
    }
    return this.discoverUsage(sessionId);
  }

  protected recordProviderUsage(sessionId: string, payload: unknown): void {
    const usage = providerUsageFromPayload(payload);
    if (usage) this.reportedUsage.set(sessionId, usage);
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
    if (process && !process.killed) {
      await terminateProcessTree(process);
      this.activeProcesses.delete(sessionId);
    }
    this.activeSessions.delete(sessionId);
  }

  async cancelRun(runId: string): Promise<void> {
    return this.cancel(runId);
  }

  async shutdown(): Promise<void> {
    for (const [sessionId, child] of this.activeProcesses.entries()) {
      this.markSessionCancelled(sessionId);
      if (!child.killed) {
        await terminateProcessTree(child, true);
      }
    }
    this.activeProcesses.clear();
    this.activeSessions.clear();
  }

  async openDeveloperConsole(_sessionId: string): Promise<void> {
    // Developer console hook for desktop UI
  }

  // CLI Process Helper for child-process-based adapters
  abstract spawnAgent(options: SpawnAgentOptions): Promise<AgentSession>;
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
    const cost = finiteNumber(root.total_cost_usd, root.totalCostUsd, usage.total_cost, usage.totalCost, usage.cost, root.cost);
    const currency = stringValue(usage.currency, root.currency) || (root.total_cost_usd != null || root.totalCostUsd != null ? 'USD' : '');
    return {
      inputTokens: Math.max(0, input || 0),
      outputTokens: Math.max(0, output || 0),
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
