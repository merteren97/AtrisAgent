import type {
  AgentProfile,
  AgentProfilePatch,
  AgentProfileRoutePolicy,
  AgentProfileResolution,
  AgentRole,
} from './agent';
import { resolveAgentProfile } from './agent';
import type { CanonicalReasoning } from './model-profile';
import type { RouteSelectionMode } from './execution-policy';

export type AgentProfileDefaults = Partial<Record<AgentRole, AgentProfile | AgentProfilePatch | string>>;

/** Workspace-scoped overrides intentionally have the same shape as template defaults. */
export interface WorkspaceAgentProfileOverrides {
  profileDefaults?: AgentProfileDefaults;
  agentProfiles?: AgentProfile[];
  profiles?: AgentProfile[];
  defaultProfileIds?: Partial<Record<AgentRole, string>>;
}

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  roles: TeamRole[];
  /** Named profile catalog shared by missions using this template. */
  agentProfiles?: AgentProfile[];
  /** Per-core-role defaults; old templates omit this field safely. */
  profileDefaults?: AgentProfileDefaults;
  /** Compatibility alias for profileDefaults used by early profile clients. */
  profiles?: AgentProfile[];
  defaultProfileIds?: Partial<Record<AgentRole, string>>;
  /** Optional v2 scheduler policy. Legacy templates remain valid without it. */
  workerPools?: WorkerPoolPolicy[];
  /** Global concurrent worker ceiling for this template. The Orchestrator is not counted as a worker. */
  maxParallelAgents?: number;
  isDefault: boolean;
  createdAt: string;
}

export interface TeamRole {
  role: AgentRole;
  /** @deprecated Kept for compatibility with older stored templates. Use modelCatalogId for live routes. */
  modelProfileId: string;
  accountProfileId: string;
  /** Stable live catalog route selected for this role. */
  modelCatalogId?: string;
  /** Ordered alternatives used when the preferred model is not runnable. */
  fallbackCatalogIds?: string[];
  /** auto = scheduler, prefer = soft preference, fixed = preferred/fallbacks only. */
  routeSelectionMode?: RouteSelectionMode;
  preferredReasoning?: CanonicalReasoning;
  defaultCapabilities: string[];
  accessLevel: 'read' | 'write' | 'tests_and_build' | 'orchestration';
  /** Optional named specialist selected for this fixed security role. */
  profileId?: string;
  profile?: AgentProfile | AgentProfilePatch;
  instructions?: string;
  capabilities?: string[];
  routePolicy?: AgentProfileRoutePolicy;
  allowedRoutePolicy?: AgentProfileRoutePolicy;
}

function profileFromCollection(
  role: AgentRole,
  collection?: {
    roles?: TeamRole[];
    profileDefaults?: AgentProfileDefaults;
    agentProfiles?: AgentProfile[];
    profiles?: AgentProfile[];
    defaultProfileIds?: Partial<Record<AgentRole, string>>;
  } | AgentProfile | AgentProfilePatch | null,
  requestedProfileId?: string,
): AgentProfile | AgentProfilePatch | undefined {
  if (!collection) return undefined;
  if ('role' in collection && !('roles' in collection)) {
    const direct = collection as AgentProfile | AgentProfilePatch;
    if (!requestedProfileId) return direct;
    const directId = typeof direct.id === 'string'
      ? direct.id
      : typeof (direct as AgentProfilePatch & { profileId?: unknown }).profileId === 'string'
        ? (direct as AgentProfilePatch & { profileId: string }).profileId
        : undefined;
    if (directId !== requestedProfileId) return undefined;
    if (direct.role !== undefined && direct.role !== role) {
      throw new Error(`Agent profile '${requestedProfileId}' is assigned to fixed role '${direct.role}', not '${role}'.`);
    }
    return direct;
  }

  const source = collection as {
    roles?: TeamRole[];
    profileDefaults?: AgentProfileDefaults;
    agentProfiles?: AgentProfile[];
    profiles?: AgentProfile[];
    defaultProfileIds?: Partial<Record<AgentRole, string>>;
  };
  const profiles = [...(source.agentProfiles || []), ...(source.profiles || [])];
  const roleEntry = source.roles?.find((entry) => entry.role === role);
  const selectedId = requestedProfileId
    || roleEntry?.profileId
    || source.defaultProfileIds?.[role]
    || (typeof source.profileDefaults?.[role] === 'string' ? source.profileDefaults[role] as string : undefined);
  const selected = selectedId ? profiles.find((profile) => profile.id === selectedId && profile.role === role) : undefined;
  const requestedWrongRole = requestedProfileId
    ? profiles.find((profile) => profile.id === requestedProfileId && profile.role !== role)
    : undefined;
  if (requestedWrongRole) {
    throw new Error(`Agent profile '${requestedProfileId}' is assigned to fixed role '${requestedWrongRole.role}', not '${role}'.`);
  }
  const configuredDefault = source.profileDefaults?.[role];
  const defaultCandidate = typeof configuredDefault === 'string'
    ? profiles.find((profile) => profile.id === configuredDefault && profile.role === role)
    : configuredDefault;
  const inline = roleEntry?.profile || (roleEntry ? {
    role,
    id: roleEntry.profileId,
    name: roleEntry.profileId,
    instructions: roleEntry.instructions,
    capabilities: roleEntry.capabilities || roleEntry.defaultCapabilities,
    routePolicy: roleEntry.routePolicy,
    allowedRoutePolicy: roleEntry.allowedRoutePolicy,
  } : undefined);
  if (requestedProfileId) {
    if (selected) return selected;
    if (roleEntry?.profileId === requestedProfileId) return inline;
    if (typeof configuredDefault !== 'string' && configuredDefault && configuredDefault.id === requestedProfileId) {
      return configuredDefault;
    }
    // A workspace/template patch without an id may refine the already
    // selected requested profile. The final requested-id check still rejects
    // a patch that attempts to replace that identity.
    if (typeof configuredDefault !== 'string' && configuredDefault && !configuredDefault.id) {
      return configuredDefault;
    }
    return undefined;
  }
  return selected || defaultCandidate || inline || profiles.find((profile) => profile.role === role);
}

/**
 * Resolve a named profile while keeping role precedence and security explicit.
 * Workspace overrides are applied after the template defaults; an explicit
 * task/profile selection is applied last.
 */
export function resolveTemplateAgentProfile(
  role: AgentRole,
  template?: TeamTemplate | AgentProfile | AgentProfilePatch | null,
  workspaceOverride?: WorkspaceAgentProfileOverrides | AgentProfile | AgentProfilePatch | null,
  explicit?: AgentProfile | AgentProfilePatch | null,
  requestedProfileId?: string,
): AgentProfileResolution {
  const templateCandidate = profileFromCollection(role, template, requestedProfileId);
  const workspaceCandidate = profileFromCollection(role, workspaceOverride, requestedProfileId);
  if (requestedProfileId) {
    const explicitId = explicit && (explicit.id === requestedProfileId || (explicit as AgentProfilePatch & { profileId?: string }).profileId === requestedProfileId);
    if (!templateCandidate && !workspaceCandidate && !explicitId) {
      throw new Error(`Agent profile '${requestedProfileId}' was not found for fixed role '${role}'.`);
    }
  }
  return resolveAgentProfile(role, {
    teamTemplate: templateCandidate,
    workspace: workspaceCandidate,
    explicit,
    requestedProfileId,
  });
}

export interface WorkerPoolPolicy {
  role: Exclude<AgentRole, 'orchestrator'>;
  /** Zero keeps the worker type fully demand-driven. */
  minInstances: number;
  /** Maximum live instances of this role within one conversation turn. */
  maxInstances: number;
  /** Optional tighter limit for simultaneously running workers of this role. */
  maxParallel?: number;
  /** Keep independent work parallel when true; dependencies still serialize execution. */
  preferParallel?: boolean;
  /** Optional capabilities that justify spawning an additional specialist of the same role. */
  splitCapabilities?: string[];
}

export interface EffectiveWorkerPoolPolicy {
  maxParallelAgents: number;
  pools: WorkerPoolPolicy[];
}

export const DEFAULT_WORKER_POOL_POLICY: EffectiveWorkerPoolPolicy = {
  maxParallelAgents: 4,
  pools: [
    { role: 'researcher', minInstances: 0, maxInstances: 3, maxParallel: 3, preferParallel: true, splitCapabilities: ['research', 'documentation', 'web-research', 'codebase-analysis'] },
    { role: 'builder', minInstances: 0, maxInstances: 2, maxParallel: 2, preferParallel: true, splitCapabilities: ['workspace-write', 'implementation', 'refactor'] },
    { role: 'reviewer', minInstances: 0, maxInstances: 2, maxParallel: 2, preferParallel: true, splitCapabilities: ['code-review', 'security-review', 'architecture-review'] },
    { role: 'qa', minInstances: 0, maxInstances: 2, maxParallel: 2, preferParallel: true, splitCapabilities: ['testing', 'build', 'lint', 'validation'] },
  ],
};

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed))) : fallback;
}

/** Resolves persisted and legacy template values into one safe scheduler policy. */
export function resolveWorkerPoolPolicy(template?: { maxParallelAgents?: number | null; workerPools?: WorkerPoolPolicy[] | null } | null): EffectiveWorkerPoolPolicy {
  const maxParallelAgents = boundedInteger(template?.maxParallelAgents, DEFAULT_WORKER_POOL_POLICY.maxParallelAgents, 1, 32);
  const overrides = new Map((Array.isArray(template?.workerPools) ? template.workerPools : [])
    .filter((pool): pool is WorkerPoolPolicy => Boolean(pool && DEFAULT_WORKER_POOL_POLICY.pools.some((item) => item.role === pool.role)))
    .map((pool) => [pool.role, pool]));
  return {
    maxParallelAgents,
    pools: DEFAULT_WORKER_POOL_POLICY.pools.map((fallback) => {
      const pool = overrides.get(fallback.role);
      if (!pool) return { ...fallback, splitCapabilities: [...(fallback.splitCapabilities || [])] };
      const maxInstances = boundedInteger(pool.maxInstances, fallback.maxInstances, 1, maxParallelAgents);
      return {
        role: fallback.role,
        minInstances: boundedInteger(pool.minInstances, fallback.minInstances, 0, maxInstances),
        maxInstances,
        maxParallel: boundedInteger(pool.maxParallel, Math.min(fallback.maxParallel ?? fallback.maxInstances, maxInstances), 1, maxInstances),
        preferParallel: typeof pool.preferParallel === 'boolean' ? pool.preferParallel : fallback.preferParallel,
        splitCapabilities: Array.isArray(pool.splitCapabilities)
          ? Array.from(new Set(pool.splitCapabilities.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim())))
          : [...(fallback.splitCapabilities || [])],
      };
    }),
  };
}
