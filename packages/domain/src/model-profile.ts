import type { Provider, RuntimeType } from './account-profile';
import type { AgentRole } from './agent';

export type CanonicalReasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReasoningLevel = CanonicalReasoning;
export type SpeedClass = 'fast' | 'standard' | 'slow';
export type ModelRoutingTier = 'fast' | 'balanced' | 'deep';
export type ModelStrengthTag =
  | 'code_edit'
  | 'shell_test'
  | 'deep_reasoning'
  | 'long_context'
  | 'multimodal'
  | 'fast_iteration';

export interface ModelDescriptor {
  /** Stable route identifier: runtime + account profile + provider model id. */
  catalogId: string;
  runtimeId: RuntimeType;
  accountProfileId: string;
  providerId: Provider;
  runtimeModelId: string;
  displayName: string;
  description?: string;
  supportedRoles: AgentRole[];
  supportedReasoning: CanonicalReasoning[];
  defaultReasoning?: CanonicalReasoning;
  inputModalities: string[];
  outputModalities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  availability: 'available' | 'unavailable' | 'rate_limited' | 'deprecated' | 'unknown';
  source: 'builtin' | 'discovered' | 'custom' | 'documented' | 'cached';
  routeLabel?: string;
  isDefault?: boolean;
  hidden?: boolean;
  replacementModelId?: string;
  entitlement?: string;
  discoveredAt?: string;
  catalogRevision?: string;
  warning?: string;
  tier?: ModelRoutingTier;
  strengths?: ModelStrengthTag[];
}

export interface TierRouteDefault {
  modelCatalogId?: string;
  reasoningLevel?: CanonicalReasoning;
  fallbackCatalogIds?: string[];
}

export interface OrchestratorRoutingDefaults {
  worker?: TierRouteDefault;
  review?: TierRouteDefault;
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: Provider;
  runtimeType: RuntimeType;
  accountProfileId: string;
  suitableRoles: AgentRole[];
  available: boolean;
  supportsReasoning: boolean;
  reasoningLevels: CanonicalReasoning[];
  contextClass: 'small' | 'medium' | 'large' | 'extra_large';
  speedClass: SpeedClass;
  isSubscription: boolean;
}
