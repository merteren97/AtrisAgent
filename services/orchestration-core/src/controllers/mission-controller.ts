import type { AgentRole } from '@atris-agent-code/domain';
import type { TaskSelect, MissionSelect } from '@atris-agent-code/database';
import type { Orchestrator } from '../orchestrator';

export class MissionController {
  constructor(private orchestrator: Orchestrator) {}

  /**
   * Start a mission by creating a structured plan, saving tasks, and dispatching the first task.
   */
  async startMission(missionId: string, request: string): Promise<{
    missionId: string;
    planId: string;
    tasks: TaskSelect[];
  }> {
    return await this.orchestrator.startMission(missionId, request);
  }

  /**
   * Assign a task to an agent role and emit task_created event for RuntimeHost.
   */
  async assignTask(taskId: string, agentRole?: AgentRole): Promise<TaskSelect> {
    return await this.orchestrator.assignTask(taskId, agentRole);
  }

  /**
   * Manually retry a failed or stuck task.
   */
  async retryTask(taskId: string): Promise<TaskSelect> {
    return await this.orchestrator.retryTask(taskId);
  }

  /**
   * Get mission details along with its tasks.
   */
  async getMissionState(missionId: string): Promise<{
    mission: MissionSelect | null;
    tasks: TaskSelect[];
  }> {
    return await this.orchestrator.getMissionState(missionId);
  }
}
