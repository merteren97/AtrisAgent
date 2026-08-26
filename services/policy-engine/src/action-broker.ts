import type { AgentRole, CapabilitySnapshot } from '@atris-agent-code/domain';
import {
  PolicyEngine,
  resolveAutomationAction,
  type AutomationAction,
  type AutomationDecision,
  type TrustProfile,
} from './policy';

export type ActionBoundary = 'planning' | 'isolated' | 'workspace' | 'control_plane';

export interface ActionBrokerRequest {
  action: AutomationAction;
  profile: TrustProfile;
  overrides?: Partial<Record<AutomationAction, AutomationDecision>>;
  /** Task capabilities are filtered to the runtime guarantees understood here. */
  requiredCapabilities?: string[];
  role?: AgentRole | string;
  toolName?: string;
  boundary?: ActionBoundary;
  path?: string;
  command?: string;
  workspacePath?: string;
  runtimeCapabilities?: Partial<CapabilitySnapshot> & Record<string, boolean | undefined>;
}

export interface ActionBrokerDecision {
  action: AutomationAction;
  decision: AutomationDecision;
  allowed: boolean;
  requiresApproval: boolean;
  requiredCapabilities: string[];
  reason?: string;
}

const ACTION_TO_TOOL: Record<AutomationAction, string> = {
  plan: 'planning',
  fileWrite: 'write_file',
  deleteFiles: 'delete_file',
  commandExecution: 'run_command',
  packageInstall: 'package_install',
  gitCommit: 'git_commit',
  databaseMigration: 'database_migration',
  workspaceApply: 'workspace_apply',
  gitPush: 'git_push',
  pullRequest: 'pull_request',
};

// These are the adapter guarantees needed before a worker is allowed to cross
// the corresponding boundary. Provider names never participate in this check.
const ACTION_CAPABILITIES: Record<AutomationAction, string[]> = {
  plan: [],
  fileWrite: ['worktreeAwareness'],
  deleteFiles: ['worktreeAwareness'],
  commandExecution: ['structuredEventStreaming'],
  packageInstall: [],
  gitCommit: [],
  databaseMigration: [],
  workspaceApply: [],
  gitPush: [],
  pullRequest: [],
};

const RUNTIME_CAPABILITY_NAMES = [
  'structuredEventStreaming',
  'sessionResume',
  'modelSelection',
  'reasoningControl',
  'toolCallEvents',
  'interactiveApproval',
  'usageInfo',
  'cancellation',
  'worktreeAwareness',
  'headlessAuth',
  'nativeSubAgent',
] as const;

const RUNTIME_CAPABILITY_ALIASES: Record<string, (typeof RUNTIME_CAPABILITY_NAMES)[number]> = {
  structuredeventstreaming: 'structuredEventStreaming',
  structured_events: 'structuredEventStreaming',
  sessionresume: 'sessionResume',
  modelselection: 'modelSelection',
  reasoningcontrol: 'reasoningControl',
  toolcallevents: 'toolCallEvents',
  interactiveapproval: 'interactiveApproval',
  usageinfo: 'usageInfo',
  cancellation: 'cancellation',
  worktreeawareness: 'worktreeAwareness',
  worktree: 'worktreeAwareness',
  workspace_write: 'worktreeAwareness',
  workspacewrite: 'worktreeAwareness',
  headlessauth: 'headlessAuth',
  nativesubagent: 'nativeSubAgent',
};

export function normalizeRuntimeCapability(value: string): string | undefined {
  const normalized = value.trim().replace(/[\s.:-]+/g, '_').toLowerCase();
  return RUNTIME_CAPABILITY_ALIASES[normalized]
    || RUNTIME_CAPABILITY_NAMES.find((name) => name.toLowerCase() === normalized);
}

export function missingRuntimeCapabilities(
  required: string[] = [],
  available?: Partial<CapabilitySnapshot> & Record<string, boolean | undefined>,
): string[] {
  return [...new Set(required
    .map(normalizeRuntimeCapability)
    .filter((capability): capability is string => Boolean(capability)))]
    .filter((capability) => available?.[capability] !== true);
}

function isDecisionAllowed(decision: AutomationDecision, action: AutomationAction, boundary: ActionBoundary): boolean {
  if (decision === 'deny') return false;
  if (decision === 'auto') return true;
  if (action === 'plan' && decision === 'review') return true;
  if (boundary === 'isolated' && decision === 'review') return true;
  return false;
}

function decisionRequiresApproval(decision: AutomationDecision, action: AutomationAction, boundary: ActionBoundary): boolean {
  if (decision === 'ask') return true;
  return decision === 'review' && action !== 'plan' && boundary !== 'isolated';
}

/**
 * Single policy interception point for tool actions and runtime capabilities.
 * The broker is deliberately side-effect free; callers decide whether an
 * approval request should be persisted or an action should be executed.
 */
export class ActionBroker {
  private readonly policyEngine: PolicyEngine;

  constructor(policyEngine = new PolicyEngine('balanced')) {
    this.policyEngine = policyEngine;
  }

  authorize(request: ActionBrokerRequest): ActionBrokerDecision {
    const boundary = request.boundary || 'control_plane';
    const decision = resolveAutomationAction(request.profile, request.action, request.overrides);
    const requiredCapabilities = [...new Set([
      ...ACTION_CAPABILITIES[request.action],
      ...((request.requiredCapabilities || [])
        .map(normalizeRuntimeCapability)
        .filter((capability): capability is string => Boolean(capability))),
    ])];

    if (request.role && !this.policyEngine.canExecuteTool(request.role, request.toolName || ACTION_TO_TOOL[request.action])) {
      return {
        action: request.action,
        decision,
        allowed: false,
        requiresApproval: false,
        requiredCapabilities,
        reason: `Role '${request.role}' is not permitted to use ${request.action}.`,
      };
    }

    if (request.path && !this.policyEngine.isPathAllowed(request.path, request.workspacePath)) {
      return {
        action: request.action,
        decision,
        allowed: false,
        requiresApproval: false,
        requiredCapabilities,
        reason: `Path policy rejected ${request.action}.`,
      };
    }

    if (request.command) {
      const commandCheck = this.policyEngine.validateCommand(request.command);
      if (!commandCheck.allowed) {
        return {
          action: request.action,
          decision,
          allowed: false,
          requiresApproval: false,
          requiredCapabilities,
          reason: commandCheck.reason,
        };
      }
    }

    const missingCapability = missingRuntimeCapabilities(requiredCapabilities, request.runtimeCapabilities)[0];
    if (missingCapability) {
      return {
        action: request.action,
        decision,
        allowed: false,
        requiresApproval: false,
        requiredCapabilities,
        reason: `Runtime does not advertise required capability '${missingCapability}' for ${request.action}.`,
      };
    }

    const requiresApproval = decisionRequiresApproval(decision, request.action, boundary);
    const allowed = isDecisionAllowed(decision, request.action, boundary)
      || (requiresApproval && request.runtimeCapabilities?.interactiveApproval === true);
    return {
      action: request.action,
      decision,
      allowed,
      requiresApproval,
      requiredCapabilities,
      reason: allowed ? undefined : `Policy decision '${decision}' blocks ${request.action} at the ${boundary} boundary.`,
    };
  }

  assertAllowed(request: ActionBrokerRequest): ActionBrokerDecision {
    const result = this.authorize(request);
    if (!result.allowed) {
      const error = new Error(result.reason || `Action '${request.action}' was rejected by policy.`);
      (error as Error & { code?: string; decision?: AutomationDecision }).code = result.requiresApproval ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED';
      (error as Error & { code?: string; decision?: AutomationDecision }).decision = result.decision;
      throw error;
    }
    return result;
  }
}

export function requiredRuntimeCapabilities(action: AutomationAction): string[] {
  return [...ACTION_CAPABILITIES[action]];
}
