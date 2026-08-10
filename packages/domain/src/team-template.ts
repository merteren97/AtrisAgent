import type { AgentRole } from './agent';
import type { CanonicalReasoning } from './model-profile';
import type { RouteSelectionMode } from './execution-policy';

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  roles: TeamRole[];
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
