import type { AgentRole } from './agent';
import type { CanonicalReasoning } from './model-profile';

/**
 * auto  -> let the scheduler choose the best compatible live route.
 * prefer -> prefer the configured route, then ordered fallbacks, then scheduler.
 * fixed  -> use only the configured route or its ordered fallbacks; fail loudly otherwise.
 */
export type RouteSelectionMode = 'auto' | 'prefer' | 'fixed';

export type RoutingPreferenceSource =
  | 'explicit'
  | 'mission'
  | 'workspace'
  | 'team_template'
  | 'scheduler';

export interface RoleExecutionPolicy {
  role: AgentRole;
  selectionMode: RouteSelectionMode;
  modelCatalogId?: string;
  accountProfileId?: string;
  reasoningLevel?: CanonicalReasoning;
  fallbackCatalogIds: string[];
}

export interface ExecutionPolicy {
  roles: Partial<Record<AgentRole, Omit<RoleExecutionPolicy, 'role'>>>;
}

export interface EffectiveRoutingPreference {
  modelCatalogId?: string;
  accountProfileId?: string;
  reasoningLevel?: CanonicalReasoning;
  fallbackCatalogIds: string[];
  selectionMode: RouteSelectionMode;
  source: RoutingPreferenceSource;
}

export function normalizeRoleExecutionPolicy(
  role: AgentRole,
  policy?: Partial<RoleExecutionPolicy> | null,
): RoleExecutionPolicy {
  const fallbackCatalogIds = Array.from(new Set((policy?.fallbackCatalogIds || []).filter(Boolean)));
  const modelCatalogId = policy?.modelCatalogId || undefined;
  return {
    role,
    selectionMode: policy?.selectionMode || (modelCatalogId ? 'prefer' : 'auto'),
    modelCatalogId,
    accountProfileId: policy?.accountProfileId || undefined,
    reasoningLevel: policy?.reasoningLevel,
    fallbackCatalogIds: fallbackCatalogIds.filter((catalogId) => catalogId !== modelCatalogId),
  };
}
