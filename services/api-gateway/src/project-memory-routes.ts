import type { Express, Request, Response } from 'express';
import type { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import type { ProjectMemoryServiceV2 } from '@atris-agent-code/orchestration-core';
import type { MemoryNodeStatus, MemoryNodeType } from '@atris-agent-code/domain';
import { resolveSafeMemoryExportPath, writeNewMemoryExport } from './memory-export-policy';

const NODE_TYPES = new Set<MemoryNodeType>([
  'project', 'component', 'file', 'symbol', 'research_finding', 'decision', 'change', 'issue', 'bug',
  'lesson', 'mistake', 'pattern', 'session', 'turn', 'task', 'agent_run', 'test', 'verification',
  'artifact', 'external_source', 'requirement', 'user_constraint',
]);
const NODE_STATUSES = new Set<MemoryNodeStatus>(['active', 'stale', 'superseded', 'disputed', 'archived']);
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] || '' : value;
}

function stringArray(value: unknown, max = 24): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, max);
}

function bounded01(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
}

function safeText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().slice(0, max);
}

export interface ProjectMemoryRoutesOptions {
  memory: ProjectMemoryServiceV2;
  workspaceManager: WorkspaceManager;
}

/** Routes are registered after the existing /api auth + Premium middleware. */
export function installProjectMemoryRoutes(app: Express, options: ProjectMemoryRoutesOptions): void {
  const { memory, workspaceManager } = options;

  app.get('/api/memory/projects', async (_req: Request, res: Response) => {
    try { res.json(await memory.listProjects()); }
    catch (error: any) { res.status(500).json({ error: error?.message || 'Failed to list project memory spaces.' }); }
  });

  app.get('/api/memory/workspaces/:workspaceId', async (req: Request, res: Response) => {
    try {
      const workspaceId = routeParam(req.params.workspaceId);
      const workspace = await workspaceManager.getWorkspace(workspaceId);
      if (!workspace) return void res.status(404).json({ error: 'Workspace not found.' });
      const missions = await workspaceManager.listMissions(workspace.id);
      const project = missions.length > 0
        ? await memory.resolveProjectForMission(missions[0].id)
        : (await memory.attachWorkspace(workspace)).project;
      if (!project) return void res.status(404).json({ error: 'Project memory could not be resolved.' });
      res.json(await memory.getSnapshot(project.id));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to load workspace memory.' });
    }
  });

  app.get('/api/memory/projects/:projectId', async (req: Request, res: Response) => {
    try { res.json(await memory.getSnapshot(routeParam(req.params.projectId))); }
    catch (error: any) { res.status(404).json({ error: error?.message || 'Project memory not found.' }); }
  });

  app.get('/api/memory/projects/:projectId/search', async (req: Request, res: Response) => {
    try {
      const text = String(req.query.q || '').trim();
      if (!text) return void res.json([]);
      const nodeTypes = String(req.query.types || '').split(',').map((item) => item.trim() as MemoryNodeType).filter((item) => NODE_TYPES.has(item));
      const statuses = String(req.query.statuses || '').split(',').map((item) => item.trim() as MemoryNodeStatus).filter((item) => NODE_STATUSES.has(item));
      const requestedLimit = Number(req.query.limit || 40);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 40;
      res.json(await memory.search({
        projectId: routeParam(req.params.projectId),
        text,
        nodeTypes: nodeTypes.length ? nodeTypes : undefined,
        statuses: statuses.length ? statuses : undefined,
        limit,
        includeArchived: String(req.query.includeArchived || '') === 'true',
      }));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Project memory search failed.' });
    }
  });

  app.post('/api/memory/projects/:projectId/nodes', async (req: Request, res: Response) => {
    try {
      const title = safeText(req.body?.title, 240);
      const summary = safeText(req.body?.summary, 4_000);
      if (!title || !summary) return void res.status(400).json({ error: 'title and summary are required.' });
      const requestedType = String(req.body?.type || 'decision') as MemoryNodeType;
      const type = NODE_TYPES.has(requestedType) && requestedType !== 'project' ? requestedType : 'decision';
      res.status(201).json(await memory.createManualMemory(routeParam(req.params.projectId), {
        type,
        title,
        summary,
        body: safeText(req.body?.body, 24_000),
        tags: stringArray(req.body?.tags),
        importance: bounded01(req.body?.importance),
        confidence: bounded01(req.body?.confidence),
        pinned: Boolean(req.body?.pinned),
      }));
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Failed to create memory note.' });
    }
  });

  app.patch('/api/memory/nodes/:nodeId', async (req: Request, res: Response) => {
    try {
      const updates: Record<string, unknown> = {};
      if ('title' in (req.body || {})) updates.title = safeText(req.body.title, 240) || 'Untitled memory';
      if ('summary' in (req.body || {})) updates.summary = safeText(req.body.summary, 4_000) || '';
      if ('body' in (req.body || {})) updates.body = safeText(req.body.body, 24_000) || null;
      if ('status' in (req.body || {})) {
        const status = String(req.body.status) as MemoryNodeStatus;
        if (!NODE_STATUSES.has(status)) return void res.status(400).json({ error: 'Invalid memory node status.' });
        updates.status = status;
      }
      if ('confidence' in (req.body || {})) updates.confidence = bounded01(req.body.confidence) ?? 0.7;
      if ('importance' in (req.body || {})) updates.importance = bounded01(req.body.importance) ?? 0.5;
      if ('pinned' in (req.body || {})) updates.pinned = Boolean(req.body.pinned);
      if ('tags' in (req.body || {})) updates.tags = stringArray(req.body.tags);
      if ('lastVerifiedAt' in (req.body || {})) updates.lastVerifiedAt = safeText(req.body.lastVerifiedAt, 80) || null;
      res.json(await memory.updateMemoryNode(routeParam(req.params.nodeId), updates as any));
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Failed to update memory node.' });
    }
  });

  app.delete('/api/memory/nodes/:nodeId', async (req: Request, res: Response) => {
    try {
      await memory.deleteMemoryNode(routeParam(req.params.nodeId));
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Failed to delete memory node.' });
    }
  });

  app.post('/api/memory/projects/:projectId/archive', async (req: Request, res: Response) => {
    try { res.json(await memory.archiveProject(routeParam(req.params.projectId))); }
    catch (error: any) { res.status(400).json({ error: error?.message || 'Failed to archive project memory.' }); }
  });

  app.post('/api/memory/projects/:projectId/restore', async (req: Request, res: Response) => {
    try { res.json(await memory.restoreProject(routeParam(req.params.projectId))); }
    catch (error: any) { res.status(400).json({ error: error?.message || 'Failed to restore project memory.' }); }
  });

  app.delete('/api/memory/projects/:projectId', async (req: Request, res: Response) => {
    try {
      await memory.deleteProjectMemory(routeParam(req.params.projectId));
      res.json({ success: true });
    } catch (error: any) {
      res.status(409).json({ error: error?.message || 'Failed to delete project memory.' });
    }
  });

  app.post('/api/memory/projects/:projectId/export', async (req: Request, res: Response) => {
    try {
      const targetPath = resolveSafeMemoryExportPath(req.body?.targetPath);
      const snapshot = await memory.getSnapshot(routeParam(req.params.projectId));
      const payload = JSON.stringify({ format: 'atris-project-memory', version: 1, exportedAt: new Date().toISOString(), snapshot }, null, 2);
      const bytes = Buffer.byteLength(payload, 'utf8');
      if (bytes > MAX_EXPORT_BYTES) return void res.status(413).json({ error: 'Project memory backup is too large for the current export limit.' });
      writeNewMemoryExport(targetPath, payload);
      res.json({ success: true, path: targetPath, bytes });
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        return void res.status(409).json({ error: 'Memory backup already exists. Choose a new filename; AtrisAgent never overwrites existing files.' });
      }
      const message = error?.message || 'Failed to export project memory.';
      const clientError = /valid absolute export path|filenames must end|filename is too long|backup directory does not exist|backup already exists/i.test(message);
      res.status(clientError ? 400 : 500).json({ error: message });
    }
  });
}
