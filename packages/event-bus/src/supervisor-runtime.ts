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
}

export type SupervisorTurnRunner = (request: SupervisorTurnRuntimeRequest) => Promise<string>;

let supervisorTurnRunner: SupervisorTurnRunner | null = null;

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
