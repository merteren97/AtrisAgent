import type { Express, Request, Response } from 'express';
import type { AtrisDatabase } from '@atris-agent-code/database';
import {
  registerProjectMemoryPromptProvider,
  unregisterProjectMemoryPromptProvider,
  type LocalEventBus,
  type ProjectMemoryPromptProvider,
} from '@atris-agent-code/event-bus';
import {
  ProjectMemoryService,
  type RawSqliteConnection,
} from '@atris-agent-code/orchestration-core';
import type { MemoryNodeStatus, MemoryNodeType } from '@atris-agent-code/domain';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';

export interface ProjectMemoryRuntime {
  service: ProjectMemoryService;
  installRoutes(app: Express): void;
  dispose(): void;
}

function compact(value: unknown, max = 12_000): string {
  return String(value || '').trim().slice(0, max);
}

function extractSupervisorQuery(prompt: string): string {
  const marker = 'Current user message:\n';
  const index = prompt.lastIndexOf(marker);
  if (index >= 0) return compact(prompt.slice(index + marker.length), 4_000);
  const synthesisMarker = 'Latest worker result:\n';
  const synthesisIndex = prompt.lastIndexOf(synthesisMarker);
  if (synthesisIndex >= 0) return compact(prompt.slice(synthesisIndex + synthesisMarker.length), 4_000);
  return compact(prompt.slice(-4_000), 4_000);
}

function formatMemoryContext(hits: Awaited<ReturnType<ProjectMemoryService['search']>>): string {
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
}

export function createProjectMemoryRuntime(params: {
  db: AtrisDatabase;
  sqlite: RawSqliteConnection;
  eventBus: LocalEventBus;
  workspaceManager: WorkspaceManager;
}): ProjectMemoryRuntime {
  const service = new ProjectMemoryService(params.db, params.sqlite);
  service.startCurator(params.eventBus);

  const promptProvider: ProjectMemoryPromptProvider = async ({ missionId, prompt }) => {
    const project = await service.resolveProjectForMission(missionId);
    if (!project || project.status === 'archived') return undefined;
    const query = extractSupervisorQuery(prompt);
    if (!query) return undefined;
    const hits = await service.search({
      projectId: project.id,
      text: query,
      limit: 8,
    });
    return hits.length ? formatMemoryContext(hits) : undefined;
  };
  registerProjectMemoryPromptProvider(promptProvider);

  const installRoutes = (app: Express): void => {
    app.get('/api/project-memory', async (_req: Request, res: Response) => {
      try {
        res.json(await service.listProjects());
      } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Failed to list project memory spaces' });
      }
    });

    app.get('/api/project-memory/workspace/:workspaceId', async (req: Request, res: Response) => {
      try {
        let project = await service.resolveProjectForWorkspace(req.params.workspaceId);
        if (!project) {
          const workspace = await params.workspaceManager.getWorkspace(req.params.workspaceId);
          if (!workspace) return void res.status(404).json({ error: 'Workspace not found' });
          project = (await service.attachWorkspace(workspace)).project;
        }
        res.json(await service.getOverview(project.id));
      } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Failed to resolve workspace project memory' });
      }
    });

    app.get('/api/project-memory/:projectId', async (req: Request, res: Response) => {
      try {
        res.json(await service.getSnapshot(req.params.projectId));
      } catch (error: any) {
        const status = String(error?.message || '').includes('was not found') ? 404 : 500;
        res.status(status).json({ error: error?.message || 'Failed to load project memory' });
      }
    });

    app.post('/api/project-memory/:projectId/search', async (req: Request, res: Response) => {
      try {
        const text = String(req.body?.text || '').trim();
        if (!text) return void res.status(400).json({ error: 'text is required' });
        const nodeTypes = Array.isArray(req.body?.nodeTypes) ? req.body.nodeTypes.map(String) as MemoryNodeType[] : undefined;
        const statuses = Array.isArray(req.body?.statuses) ? req.body.statuses.map(String) as MemoryNodeStatus[] : undefined;
        const anchorNodeIds = Array.isArray(req.body?.anchorNodeIds) ? req.body.anchorNodeIds.map(String) : undefined;
        const rawLimit = Number(req.body?.limit || 12);
        const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 12;
        res.json(await service.search({
          projectId: req.params.projectId,
          text,
          nodeTypes,
          statuses,
          anchorNodeIds,
          includeArchived: Boolean(req.body?.includeArchived),
          limit,
        }));
      } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Project memory search failed' });
      }
    });

    app.post('/api/project-memory/:projectId/archive', async (req: Request, res: Response) => {
      try {
        res.json(await service.archiveProject(req.params.projectId));
      } catch (error: any) {
        res.status(404).json({ error: error?.message || 'Project memory not found' });
      }
    });

    app.post('/api/project-memory/:projectId/restore', async (req: Request, res: Response) => {
      try {
        res.json(await service.restoreProject(req.params.projectId));
      } catch (error: any) {
        res.status(404).json({ error: error?.message || 'Project memory not found' });
      }
    });

    app.post('/api/project-memory/:projectId/nodes', async (req: Request, res: Response) => {
      try {
        const title = String(req.body?.title || '').trim();
        const summary = String(req.body?.summary || '').trim();
        if (!title || !summary) return void res.status(400).json({ error: 'title and summary are required' });
        const node = await service.createManualMemory(req.params.projectId, {
          type: req.body?.type as MemoryNodeType | undefined,
          title,
          summary,
          body: req.body?.body ? String(req.body.body) : undefined,
          tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : undefined,
          importance: req.body?.importance === undefined ? undefined : Number(req.body.importance),
          confidence: req.body?.confidence === undefined ? undefined : Number(req.body.confidence),
          pinned: req.body?.pinned === undefined ? undefined : Boolean(req.body.pinned),
        });
        res.status(201).json(node);
      } catch (error: any) {
        res.status(500).json({ error: error?.message || 'Failed to create project memory node' });
      }
    });

    app.patch('/api/project-memory/:projectId/nodes/:nodeId', async (req: Request, res: Response) => {
      try {
        const node = await service.updateMemoryNode(req.params.nodeId, {
          ...(req.body?.title !== undefined ? { title: String(req.body.title) } : {}),
          ...(req.body?.summary !== undefined ? { summary: String(req.body.summary) } : {}),
          ...(req.body?.body !== undefined ? { body: req.body.body === null ? null : String(req.body.body) } : {}),
          ...(req.body?.status !== undefined ? { status: String(req.body.status) as MemoryNodeStatus } : {}),
          ...(req.body?.confidence !== undefined ? { confidence: Number(req.body.confidence) } : {}),
          ...(req.body?.importance !== undefined ? { importance: Number(req.body.importance) } : {}),
          ...(req.body?.pinned !== undefined ? { pinned: Boolean(req.body.pinned) } : {}),
          ...(req.body?.tags !== undefined ? { tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [] } : {}),
          ...(req.body?.lastVerifiedAt !== undefined ? { lastVerifiedAt: req.body.lastVerifiedAt ? String(req.body.lastVerifiedAt) : null } : {}),
        });
        if (node.projectId !== req.params.projectId) return void res.status(404).json({ error: 'Memory node not found in project' });
        res.json(node);
      } catch (error: any) {
        res.status(404).json({ error: error?.message || 'Memory node not found' });
      }
    });

    app.delete('/api/project-memory/:projectId/nodes/:nodeId', async (req: Request, res: Response) => {
      try {
        const snapshot = await service.getSnapshot(req.params.projectId);
        if (!snapshot.nodes.some((node) => node.id === req.params.nodeId)) {
          return void res.status(404).json({ error: 'Memory node not found in project' });
        }
        await service.deleteMemoryNode(req.params.nodeId);
        res.json({ success: true });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Failed to delete memory node' });
      }
    });
  };

  return {
    service,
    installRoutes,
    dispose() {
      service.stopCurator();
      unregisterProjectMemoryPromptProvider(promptProvider);
    },
  };
}
