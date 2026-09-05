import type { CanonicalReasoning } from './model-profile';
import type { RouteSelectionMode } from './execution-policy';
import type { RuntimeType } from './account-profile';

/**
 * These are security roles, rather than user-facing names.  A profile may
 * describe a named specialist (for example, Frontend Designer) but it must
 * always resolve to one of these fixed roles before it reaches a runtime.
 */
export const AGENT_ROLES = ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value.toLowerCase() as AgentRole);
}

export type AgentProfileSource = 'explicit' | 'workspace' | 'team_template' | 'default';

/**
 * Optional route preferences and allowlists attached to a named profile.
 * Preferences can narrow a role's route, while allowlists are always
 * enforced as constraints by RuntimeHost.
 */
export interface AgentProfileRoutePolicy {
  selectionMode?: RouteSelectionMode;
  modelCatalogId?: string;
  accountProfileId?: string;
  reasoningLevel?: CanonicalReasoning;
  fallbackCatalogIds?: string[];
  /** Stable catalog IDs this profile is allowed to use. */
  allowedCatalogIds?: string[];
  /** Compatibility/readability alias for allowedCatalogIds. */
  allowedModelCatalogIds?: string[];
  /** Account profiles this profile is allowed to use. */
  allowedAccountProfileIds?: string[];
  /** Runtime adapters this profile is allowed to use. */
  allowedRuntimeTypes?: RuntimeType[];
}

export interface AgentProfile {
  id: string;
  name: string;
  role: AgentRole;
  instructions: string;
  capabilities: string[];
  specialty?: string;
  description?: string;
  routePolicy?: AgentProfileRoutePolicy;
  /** Explicit name for a policy that limits, rather than merely prefers, routes. */
  allowedRoutePolicy?: AgentProfileRoutePolicy;
}

export type AgentProfilePatch = Partial<Omit<AgentProfile, 'role'>> & {
  id?: string;
  role?: AgentRole;
};

/**
 * Durable catalog representation of an AgentProfile.
 *
 * Catalog records are global and intentionally do not carry a workspace or
 * team-template owner. Bindings provide scope while this record remains
 * available when a workspace or template is removed.
 */
export interface AgentProfileRecord extends AgentProfile {
  isDefault: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PersistedAgentProfile = AgentProfileRecord;

export type AgentProfileCreateInput = Omit<AgentProfile, 'id' | 'instructions' | 'capabilities'> & {
  id?: string;
  instructions?: string;
  capabilities?: string[];
  isDefault?: boolean;
  archivedAt?: string | null;
};

export type AgentProfileUpdateInput = Partial<Omit<AgentProfile, 'id' | 'role'>> & {
  /** Profile IDs and security roles are immutable after creation. */
  id?: string;
  role?: AgentRole;
  isDefault?: boolean;
  archivedAt?: string | null;
};

/** Fields a scoped binding may refine; identity and security role are fixed. */
export type AgentProfileBindingOverride = Partial<Pick<AgentProfile,
  'name' | 'instructions' | 'capabilities' | 'specialty' | 'description' | 'routePolicy' | 'allowedRoutePolicy'>>;

export type AgentProfileScopeType = 'global' | 'workspace' | 'team_template';
export type AgentProfileBindingScope = AgentProfileScopeType;

export interface AgentProfileBindingRecord {
  id: string;
  scopeType: AgentProfileScopeType;
  scopeId: string;
  role: AgentRole;
  profileId: string;
  isDefault: boolean;
  override?: AgentProfileBindingOverride;
  createdAt: string;
  updatedAt: string;
}

export type AgentProfileBinding = AgentProfileBindingRecord;

export interface AgentProfileResolutionRequest {
  role: AgentRole;
  missionId?: string;
  workspaceId?: string;
  teamTemplateId?: string | null;
  /** Explicit named profile identity; all aliases are accepted for callers. */
  profileId?: string | null;
  agentProfileId?: string | null;
  requestedProfileId?: string | null;
}

export type ResolveAgentProfileInput = AgentProfileResolutionRequest;

export interface AgentProfileResolution {
  profile: AgentProfile;
  source: AgentProfileSource;
}

export interface AgentProfileResolutionOptions {
  explicit?: AgentProfile | AgentProfilePatch | null;
  workspace?: AgentProfile | AgentProfilePatch | null;
  teamTemplate?: AgentProfile | AgentProfilePatch | null;
  default?: AgentProfile | AgentProfilePatch | null;
  /** A requested named profile must survive every precedence layer unchanged. */
  requestedProfileId?: string;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim())));
}

function strictStringAllowlist(record: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  // Normalized internal policies carry optional keys as undefined. Treat that
  // representation like an omitted field while still rejecting all other
  // malformed values, including null and scalar values.
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Agent profile allowlist '${key}' must be an array of non-empty strings.`);
  }
  return Array.from(new Set(value.map((item) => item.trim())));
}

function normalizeRoutePolicy(value: unknown): AgentProfileRoutePolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent profile route policy must be an object.');
  }
  const record = value as Record<string, unknown>;
  const policy: AgentProfileRoutePolicy = {};
  const selectionMode = cleanString(record.selectionMode);
  if (selectionMode === 'auto' || selectionMode === 'prefer' || selectionMode === 'fixed') policy.selectionMode = selectionMode;
  policy.modelCatalogId = cleanString(record.modelCatalogId);
  policy.accountProfileId = cleanString(record.accountProfileId);
  const reasoningLevel = cleanString(record.reasoningLevel);
  const reasoningLevels: CanonicalReasoning[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (reasoningLevel && reasoningLevels.includes(reasoningLevel as CanonicalReasoning)) policy.reasoningLevel = reasoningLevel as CanonicalReasoning;
  policy.fallbackCatalogIds = cleanStringArray(record.fallbackCatalogIds);
  policy.allowedCatalogIds = strictStringAllowlist(record, 'allowedCatalogIds');
  policy.allowedModelCatalogIds = strictStringAllowlist(record, 'allowedModelCatalogIds');
  policy.allowedAccountProfileIds = strictStringAllowlist(record, 'allowedAccountProfileIds');
  if (Object.prototype.hasOwnProperty.call(record, 'allowedRuntimeTypes') && record.allowedRuntimeTypes !== undefined) {
    const value = record.allowedRuntimeTypes;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !['codex', 'claude_code', 'antigravity', 'opencode'].includes(item))) {
      throw new Error("Agent profile allowlist 'allowedRuntimeTypes' must contain only known runtime types.");
    }
    policy.allowedRuntimeTypes = Array.from(new Set(value)) as RuntimeType[];
  }
  return Object.values(policy).some((item) => item !== undefined) ? policy : undefined;
}

function mergeRoutePolicies(
  base?: AgentProfileRoutePolicy,
  override?: AgentProfileRoutePolicy,
): AgentProfileRoutePolicy | undefined {
  if (!base && !override) return undefined;
  const intersect = (left?: string[], right?: string[]): string[] | undefined => {
    if (!left) return right;
    if (!right) return left;
    const rightSet = new Set(right);
    return left.filter((value) => rightSet.has(value));
  };
  const mergeAliases = (policy?: AgentProfileRoutePolicy): string[] | undefined => {
    if (!policy) return undefined;
    return intersect(policy.allowedCatalogIds, policy.allowedModelCatalogIds);
  };
  const catalogAllowlist = intersect(mergeAliases(base), mergeAliases(override));
  const accountAllowlist = intersect(base?.allowedAccountProfileIds, override?.allowedAccountProfileIds);
  const runtimeAllowlist = base?.allowedRuntimeTypes && override?.allowedRuntimeTypes
    ? base.allowedRuntimeTypes.filter((value) => override.allowedRuntimeTypes?.includes(value))
    : override?.allowedRuntimeTypes ?? base?.allowedRuntimeTypes;
  return {
    ...(base || {}),
    ...(override || {}),
    fallbackCatalogIds: override?.fallbackCatalogIds ?? base?.fallbackCatalogIds,
    // Allowlist layers are constraints, so an override can only narrow the
    // inherited set. An explicit [] remains an intentional deny-all policy.
    allowedCatalogIds: catalogAllowlist,
    allowedModelCatalogIds: catalogAllowlist,
    allowedAccountProfileIds: accountAllowlist,
    allowedRuntimeTypes: runtimeAllowlist,
  };
}

function roleLabel(role: AgentRole): string {
  return role === 'qa' ? 'QA' : role.charAt(0).toUpperCase() + role.slice(1);
}

/** Safe baseline used when a legacy task has no named profile. */
export function defaultAgentProfile(role: AgentRole): AgentProfile {
  return {
    id: role,
    name: `${roleLabel(role)} Agent`,
    role,
    instructions: '',
    capabilities: [],
  };
}

/** Parse an untrusted/persisted profile without broadening its security role. */
export function parseAgentProfile(input: unknown, fallbackRole?: AgentRole): AgentProfile | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const rawRole = record.role;
  const role = rawRole === undefined ? fallbackRole : isAgentRole(rawRole) ? rawRole.toLowerCase() as AgentRole : undefined;
  if (!role) return undefined;
  const name = cleanString(record.name) || cleanString(record.displayName) || `${roleLabel(role)} Agent`;
  const id = cleanString(record.id) || cleanString(record.profileId) || role;
  const routePolicy = normalizeRoutePolicy(record.routePolicy);
  const allowedRoutePolicy = normalizeRoutePolicy(record.allowedRoutePolicy);
  return {
    id,
    name,
    role,
    instructions: cleanString(record.instructions) || '',
    capabilities: cleanStringArray(record.capabilities) || [],
    specialty: cleanString(record.specialty),
    description: cleanString(record.description),
    routePolicy,
    allowedRoutePolicy,
  };
}

export function normalizeAgentProfile(input: unknown, fallbackRole?: AgentRole): AgentProfile {
  const profile = parseAgentProfile(input, fallbackRole);
  if (!profile) throw new Error('Agent profile must declare one of the fixed core agent roles.');
  return profile;
}

/** Merge a workspace/template override while preserving the fixed role. */
export function mergeAgentProfiles(base: AgentProfile, override?: AgentProfilePatch | null): AgentProfile {
  if (!override) return { ...base, capabilities: [...base.capabilities] };
  if (override.role !== undefined && !isAgentRole(override.role)) throw new Error('Agent profile override has an invalid core role.');
  const overrideRole = override.role === undefined ? undefined : override.role.toLowerCase() as AgentRole;
  if (overrideRole !== undefined && overrideRole !== base.role) {
    throw new Error(`Agent profile role '${override.role}' cannot override fixed role '${base.role}'.`);
  }
  const normalized = normalizeAgentProfile({ ...base, ...override, role: base.role }, base.role);
  return {
    ...normalized,
    routePolicy: mergeRoutePolicies(base.routePolicy, normalized.routePolicy),
    allowedRoutePolicy: mergeRoutePolicies(base.allowedRoutePolicy, normalized.allowedRoutePolicy),
  };
}

/** Resolve explicit > workspace > team-template > legacy role defaults. */
export function resolveAgentProfile(
  role: AgentRole,
  options: AgentProfileResolutionOptions = {},
): AgentProfileResolution {
  let profile = options.default
    ? mergeAgentProfiles(defaultAgentProfile(role), options.default as AgentProfilePatch)
    : defaultAgentProfile(role);
  let source: AgentProfileSource = 'default';
  const layers: Array<[AgentProfileSource, AgentProfile | AgentProfilePatch | null | undefined]> = [
    ['team_template', options.teamTemplate],
    ['workspace', options.workspace],
    ['explicit', options.explicit],
  ];
  for (const [layerSource, candidate] of layers) {
    if (!candidate) continue;
    profile = mergeAgentProfiles(profile, candidate as AgentProfilePatch);
    source = layerSource;
  }
  const requestedProfileId = cleanString(options.requestedProfileId);
  if (requestedProfileId && profile.id !== requestedProfileId) {
    throw new Error(`Agent profile '${requestedProfileId}' could not be resolved for fixed role '${role}'.`);
  }
  return { profile, source };
}

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed';
export type AgentWorkspaceMode = 'shared' | 'isolated_worktree' | 'read_only';

/**
 * Runtime V2 keeps agent identity durable and independent from the UI surface used
 * to observe it. Parent/child lineage describes provenance only; communication
 * permissions are enforced separately by Coordination MCP and policy rules.
 */
export interface AgentInstance {
  id: string;
  missionId: string;
  role: AgentRole;
  /** Named profile identity; role remains the security boundary. */
  profileId?: string;
  /** Canonical named profile identity. profileId is retained for older stores. */
  agentProfileId?: string;
  modelProfileId: string;
  accountProfileId: string;
  runtimeAdapterId: string;
  sessionId: string | null;
  status: AgentStatus;
  createdAt: string;
  taskId?: string | null;
  parentAgentId?: string | null;
  spawnedByAgentId?: string | null;
  displayName?: string;
  specialty?: string;
  instructions?: string;
  capabilities?: string[];
  allowedRoutePolicy?: AgentProfileRoutePolicy;
  spawnReason?: string;
  statusMessage?: string;
  progress?: number;
  workspaceMode?: AgentWorkspaceMode;
  worktreeId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface AgentSession {
  id: string;
  agentInstanceId: string;
  runtimeSessionId: string;
  startedAt: string;
  endedAt: string | null;
}

export interface AgentSpawnRequest {
  missionId: string;
  role: AgentRole;
  instruction: string;
  parentAgentId?: string;
  taskId?: string;
  displayName?: string;
  specialty?: string;
  profileId?: string;
  /** Canonical named profile identity; profileId remains a compatibility alias. */
  agentProfileId?: string;
  instructions?: string;
  spawnReason: string;
  capabilities?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  /** Stable live catalog route. modelProfileId is kept as a compatibility alias. */
  modelCatalogId?: string;
  modelProfileId?: string;
  accountProfileId?: string;
  reasoningLevel?: string;
  fallbackCatalogIds?: string[];
  routeSelectionMode?: 'auto' | 'prefer' | 'fixed';
  runtimeAdapterId?: string;
  workspaceMode?: AgentWorkspaceMode;
}

export interface AgentMessage {
  id: string;
  missionId: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  createdAt: string;
  readAt?: string | null;
  kind?: 'message' | 'handoff' | 'review_request' | 'summary';
  replyToMessageId?: string | null;
}
