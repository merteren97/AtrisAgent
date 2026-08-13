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
