import type {
  AgentRole,
  OrchestratorDelegation,
  WorkerPoolPolicy,
} from '@atris-agent-code/domain';
import { DEFAULT_WORKER_POOL_POLICY } from '@atris-agent-code/domain';

export interface WorkerPoolTemplatePolicy {
  maxParallelAgents: number;
  pools: WorkerPoolPolicy[];
}

export interface RunningWorkerSnapshot {
  role: AgentRole;
  delegationId?: string;
}

export interface WorkerAllocationBatch {
  dispatchable: OrchestratorDelegation[];
  deferred: Array<{
    delegation: OrchestratorDelegation;
    reason: 'dependency' | 'global_capacity' | 'role_capacity' | 'unsupported_role';
  }>;
}

export const DEFAULT_CORE_WORKER_POOL: WorkerPoolTemplatePolicy = DEFAULT_WORKER_POOL_POLICY;

function countByRole(workers: RunningWorkerSnapshot[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const worker of workers) counts.set(worker.role, (counts.get(worker.role) || 0) + 1);
  return counts;
}

/**
 * Selects the next independent delegations that may run concurrently.
 *
 * This is intentionally deterministic and provider-agnostic. Runtime routing,
 * account quota, and model availability are applied after this structural pool
 * decision. Dependencies always win over parallelism, while independent work is
 * allowed to fill the configured global/role capacity.
 */
export function allocateWorkerBatch(params: {
  delegations: OrchestratorDelegation[];
  completedDelegationIds?: string[];
  runningWorkers?: RunningWorkerSnapshot[];
  policy?: WorkerPoolTemplatePolicy;
}): WorkerAllocationBatch {
  const policy = params.policy || DEFAULT_CORE_WORKER_POOL;
  const completed = new Set(params.completedDelegationIds || []);
  const running = params.runningWorkers || [];
  const runningByRole = countByRole(running);
  const pools = new Map(policy.pools.map((pool) => [pool.role, pool]));
  const dispatchable: OrchestratorDelegation[] = [];
  const deferred: WorkerAllocationBatch['deferred'] = [];
  let availableGlobal = Math.max(0, policy.maxParallelAgents - running.length);

  for (const delegation of params.delegations) {
    const dependencies = delegation.dependsOnDelegationIds || [];
    if (!dependencies.every((id) => completed.has(id))) {
      deferred.push({ delegation, reason: 'dependency' });
      continue;
    }

    const pool = pools.get(delegation.role);
    if (!pool) {
      deferred.push({ delegation, reason: 'unsupported_role' });
      continue;
    }

    if (availableGlobal <= 0) {
      deferred.push({ delegation, reason: 'global_capacity' });
      continue;
    }

    const alreadyRunningForRole = runningByRole.get(delegation.role) || 0;
    const alreadyAllocatedForRole = dispatchable.filter((item) => item.role === delegation.role).length;
    const effectiveParallelLimit = Math.min(pool.maxInstances, pool.maxParallel ?? pool.maxInstances);
    if (alreadyRunningForRole + alreadyAllocatedForRole >= effectiveParallelLimit) {
      deferred.push({ delegation, reason: 'role_capacity' });
      continue;
    }

    dispatchable.push(delegation);
    availableGlobal -= 1;
  }

  return { dispatchable, deferred };
}
