import type { AgentRole } from './agent';
import type { TaskPriority } from './task';
import type { CanonicalReasoning } from './model-profile';
import type { RouteSelectionMode, RoutingPreferenceSource } from './execution-policy';

export interface WorkerRequest {
  role: AgentRole;
  capabilities: string[];
  task: string;
  priority: TaskPriority;
  requiresWorktree: boolean;
  /** Optional account-scoped model route selected by the user or execution policy. */
  preferredCatalogId?: string;
  preferredAccountProfileId?: string;
  preferredReasoning?: CanonicalReasoning;
  fallbackCatalogIds?: string[];
  routeSelectionMode?: RouteSelectionMode;
  routingSource?: RoutingPreferenceSource;
}
