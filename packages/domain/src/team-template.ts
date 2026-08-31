import type { AgentRole } from './agent';
import type { CanonicalReasoning } from './model-profile';
import type { RouteSelectionMode } from './execution-policy';

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  roles: TeamRole[];
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
