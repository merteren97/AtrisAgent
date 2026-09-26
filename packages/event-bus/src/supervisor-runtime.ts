export type SupervisorPlanningRole = 'researcher' | 'builder' | 'reviewer' | 'qa';
export type SupervisorPlanningRuntime = 'codex' | 'claude_code' | 'antigravity' | 'opencode';
export type SupervisorPlanningReasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SupervisorPlanningRoutePolicy {
  allowedCatalogIds?: string[];
  allowedModelCatalogIds?: string[];
  allowedAccountProfileIds?: string[];
  allowedRuntimeTypes?: SupervisorPlanningRuntime[];
}

export interface SupervisorTurnRuntimeRequest {
  missionId: string;
  turnId: string;
  workspacePath: string;
  prompt: string;
  modelCatalogId?: string;
  accountProfileId?: string;
  reasoningLevel?: string;
  fallbackCatalogIds?: string[];
  selectionMode?: 'auto' | 'prefer' | 'fixed';
  /** Optional named profile identity; core role remains orchestrator. */
  agentProfileId?: string;
  /** Compatibility alias for callers that use profileId for named profiles. */
  profileId?: string;
  agentProfile?: Record<string, unknown>;
  profile?: Record<string, unknown>;
}

export interface SupervisorPlanningModel {
  catalogId: string;
  accountProfileId: string;
  runtimeId: SupervisorPlanningRuntime;
  runtimeModelId: string;
  displayName: string;
  routeLabel?: string;
  supportedRoles: SupervisorPlanningRole[];
  supportedReasoning: SupervisorPlanningReasoning[];
  defaultReasoning?: SupervisorPlanningReasoning;
}

export interface SupervisorPlanningSpecialist {
  id: string;
  name: string;
  role: SupervisorPlanningRole;
  specialty?: string;
  description?: string;
  capabilities: string[];
  allowedRoutePolicy?: SupervisorPlanningRoutePolicy;
}

export interface SupervisorPlanningResources {
  models: SupervisorPlanningModel[];
  specialists: SupervisorPlanningSpecialist[];
  /** Effective role profiles after workspace/template precedence and explicit user selection. */
  defaultSpecialists?: Partial<Record<SupervisorPlanningRole, SupervisorPlanningSpecialist>>;
  requestedProfileIds?: SupervisorRequestedProfiles;
}

export type SupervisorRequestedProfiles = Partial<Record<SupervisorPlanningRole, string>>;

export type SupervisorTurnRunner = (request: SupervisorTurnRuntimeRequest) => Promise<string>;
export type SupervisorPlanningResourcesProvider = (missionId: string, requestedProfiles?: SupervisorRequestedProfiles) => Promise<SupervisorPlanningResources>;

let supervisorTurnRunner: SupervisorTurnRunner | null = null;
let supervisorPlanningResourcesProvider: SupervisorPlanningResourcesProvider | null = null;

/**
 * Registers the runtime-side one-shot supervisor executor for this local process.
 *
 * The bridge intentionally lives next to LocalEventBus because both orchestration
 * and runtime-host already depend on this package. It avoids a package cycle while
 * keeping the Orchestrator independent from provider-specific CLI adapters.
 */
export function registerSupervisorTurnRunner(runner: SupervisorTurnRunner | null): void {
  supervisorTurnRunner = runner;
}

/**
 * Removes a runner only when the caller still owns the active registration.
 * This matters in tests/restarts where a newer RuntimeHost may already have
 * replaced an older host's bridge before the older instance finishes shutdown.
 */
export function unregisterSupervisorTurnRunner(runner: SupervisorTurnRunner): void {
  if (supervisorTurnRunner === runner) supervisorTurnRunner = null;
}

export function getSupervisorTurnRunner(): SupervisorTurnRunner | null {
  return supervisorTurnRunner;
}

export async function runSupervisorTurn(request: SupervisorTurnRuntimeRequest): Promise<string> {
  const runner = getSupervisorTurnRunner();
  if (!runner) throw new Error('No supervisor runtime bridge is registered.');
  return runner(request);
}

export function registerSupervisorPlanningResourcesProvider(provider: SupervisorPlanningResourcesProvider | null): void {
  supervisorPlanningResourcesProvider = provider;
}

export function unregisterSupervisorPlanningResourcesProvider(provider: SupervisorPlanningResourcesProvider): void {
  if (supervisorPlanningResourcesProvider === provider) supervisorPlanningResourcesProvider = null;
}

export async function getSupervisorPlanningResources(missionId: string, requestedProfiles?: SupervisorRequestedProfiles): Promise<SupervisorPlanningResources> {
  if (!supervisorPlanningResourcesProvider) return { models: [], specialists: [] };
  return supervisorPlanningResourcesProvider(missionId, requestedProfiles);
}
