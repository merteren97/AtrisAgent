import type { AgentEvent } from '@atris-agent-code/event-schema';
import type { RuntimeType, AccountProfile, AccountProfileStatus } from './account-profile';
import type { AgentSession } from './agent';
import type { CanonicalReasoning, ModelDescriptor } from './model-profile';

export type { AgentEvent };

export interface CapabilitySnapshot extends Record<string, boolean> {
  structuredEventStreaming: boolean;
  sessionResume: boolean;
  modelSelection: boolean;
  reasoningControl: boolean;
  toolCallEvents: boolean;
  interactiveApproval: boolean;
  usageInfo: boolean;
  cancellation: boolean;
  worktreeAwareness: boolean;
  headlessAuth: boolean;
  nativeSubAgent: boolean;
}

export type RuntimeCapabilities = CapabilitySnapshot;

export interface StartSessionRequest {
  workspacePath: string;
  model: string;
  reasoningLevel?: CanonicalReasoning;
  systemPrompt?: string;
  tools?: string[];
  worktreePath?: string;
}

export interface AgentInput {
  type: 'text' | 'approval_decision' | 'context_file';
  content: string;
  metadata?: Record<string, unknown>;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'modified';

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalCost: number | null;
  currency: string;
  timestamp: string;
}

export interface InstallationStatus {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface AuthMethodDescriptor {
  id: string;
  name: string;
  type: 'api_key' | 'oauth' | 'browser' | 'os_keyring' | 'command';
  description?: string;
}

export interface AuthInitiationResult {
  authId: string;
  method: string;
  url?: string;
  userCode?: string;
  instructions?: string;
  status: 'pending' | 'completed' | 'failed';
}

export interface AuthPollResult {
  authId: string;
  status: AccountProfileStatus;
  message?: string;
  accountProfile?: AccountProfile;
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly name: string;
  readonly runtimeType: RuntimeType;

  discoverInstallation(profileId?: string): Promise<InstallationStatus>;
  probeCapabilities(profileId?: string): Promise<CapabilitySnapshot>;
  getAuthMethods(): Promise<AuthMethodDescriptor[]>;
  beginAuthentication(method?: string, options?: Record<string, unknown>): Promise<AuthInitiationResult>;
  pollAuthentication(authId: string): Promise<AuthPollResult>;
  verifyAuthentication(profileId?: string): Promise<AccountProfileStatus>;
  logout(profileId?: string): Promise<void>;
  discoverModels(profileId?: string): Promise<ModelDescriptor[]>;
  discoverAccounts(): Promise<AccountProfile[]>;
  discoverUsage(sessionId?: string): Promise<UsageSnapshot | null>;
  startSession(request: StartSessionRequest): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  sendInput(sessionId: string, input: AgentInput): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<AgentEvent>;
  respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;

  // Backward compatibility alias methods
  getCapabilities(): Promise<CapabilitySnapshot>;
  sendMessage(sessionId: string, input: AgentInput): Promise<void>;
  approveToolCall(requestId: string, decision: ApprovalDecision): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  getUsage(sessionId: string): Promise<UsageSnapshot | null>;
  openDeveloperConsole(sessionId: string): Promise<void>;
}

export type AgentRuntimeAdapter = RuntimeAdapter;
