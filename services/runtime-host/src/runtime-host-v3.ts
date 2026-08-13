import {
  augmentSupervisorPromptWithProjectMemory,
  type SupervisorTurnRuntimeRequest,
} from '@atris-agent-code/event-bus';
import { RuntimeHostV2 } from './runtime-host-v2';

/**
 * Phase 3 runtime wrapper. Provider/model routing remains owned by RuntimeHostV2;
 * this layer only enriches persistent Orchestrator decision/synthesis prompts
 * with project-scoped long-term memory before the provider CLI is invoked.
 */
export class RuntimeHostV3 extends RuntimeHostV2 {
  override async runSupervisorTurn(request: SupervisorTurnRuntimeRequest): Promise<string> {
    const prompt = await augmentSupervisorPromptWithProjectMemory({
      missionId: request.missionId,
      prompt: request.prompt,
    });
    return super.runSupervisorTurn({ ...request, prompt });
  }
}
