import type { AtrisDatabase } from '@atris-agent-code/database';
import {
  registerProjectMemoryPromptProvider,
  type LocalEventBus,
  type ProjectMemoryPromptProvider,
} from '@atris-agent-code/event-bus';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import { OrchestratorV2 } from './orchestrator-v2';
import type { OrchestratorConfig } from './orchestrator';
import { ProjectMemoryServiceV2 } from './project-memory-v2';

function compact(value: unknown, max = 4_000): string {
  return String(value || '').trim().slice(0, max);
}

function extractRecallQuery(prompt: string): string {
  const marker = 'Current user message:\n';
  const index = prompt.lastIndexOf(marker);
  if (index >= 0) return compact(prompt.slice(index + marker.length));
  const synthesisMarker = 'Latest worker result:\n';
  const synthesisIndex = prompt.lastIndexOf(synthesisMarker);
  if (synthesisIndex >= 0) return compact(prompt.slice(synthesisIndex + synthesisMarker.length));
  return compact(prompt.slice(-4_000));
}

/**
 * Phase 3 Orchestrator activation layer.
 *
 * It keeps Phase 2 conversation/delegation semantics untouched and adds a
 * durable project Memory Curator + retrieval provider. RuntimeHostV3 consumes
 * that provider immediately before each supervisor decision/synthesis call.
 */
export class OrchestratorV3 extends OrchestratorV2 {
  private readonly projectMemory?: ProjectMemoryServiceV2;
  private readonly memoryPromptProvider?: ProjectMemoryPromptProvider;

  constructor(
    config: OrchestratorConfig,
    eventBus?: LocalEventBus,
    db?: AtrisDatabase,
    workspaceManager?: WorkspaceManager,
  ) {
    super(config, eventBus, db, workspaceManager);
    const effectiveDb = db ?? config.db;
    const effectiveEventBus = eventBus ?? config.eventBus;
    if (!effectiveDb) return;

    try {
      this.projectMemory = new ProjectMemoryServiceV2(effectiveDb);
      if (effectiveEventBus) this.projectMemory.startCurator(effectiveEventBus);
      this.memoryPromptProvider = async ({ missionId, prompt }) => {
        const project = await this.projectMemory!.resolveProjectForMission(missionId);
        if (!project || project.status === 'archived') return undefined;
        const query = extractRecallQuery(prompt);
        if (!query) return undefined;
        const hits = await this.projectMemory!.search({
          projectId: project.id,
          text: query,
          limit: 8,
        });
        if (!hits.length) return undefined;
        return hits.map((hit, index) => {
          const node = hit.node;
          const provenance = node.provenance?.[node.provenance.length - 1];
          const source = [
            provenance?.sourceType,
            provenance?.path,
            provenance?.missionId ? `mission:${provenance.missionId}` : '',
          ].filter(Boolean).join(' | ');
          return [
            `<memory_item index="${index + 1}" id="${node.id}" type="${node.type}" status="${node.status}" score="${hit.score.toFixed(3)}" confidence="${node.confidence.toFixed(2)}" importance="${node.importance.toFixed(2)}">`,
            `Title: ${node.title}`,
            `Summary: ${compact(node.summary, 1_800)}`,
            source ? `Source: ${source}` : '',
            '</memory_item>',
          ].filter(Boolean).join('\n');
        }).join('\n\n');
      };
      registerProjectMemoryPromptProvider(this.memoryPromptProvider);
    } catch (error) {
      console.warn('[OrchestratorV3] Project memory initialization failed; continuing with Phase 2 conversation memory only.', error);
    }
  }

  getProjectMemoryService(): ProjectMemoryServiceV2 | undefined {
    return this.projectMemory;
  }
}
