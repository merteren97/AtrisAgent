import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  memoryEdges,
  memoryEvidence,
  memoryNodes,
  missions,
  projectMemorySpaces,
  projects,
  projectWorkspaceLinks,
  tasks,
  type AtrisDatabase,
  type MemoryEdgeSelect,
  type MemoryNodeSelect,
  type ProjectMemorySpaceSelect,
  type ProjectSelect,
  type WorkspaceSelect,
} from '@atris-agent-code/database';
import type { LocalEventBus, Unsubscribe } from '@atris-agent-code/event-bus';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import type {
  MemoryCandidate,
  MemoryEdgeType,
  MemoryNode,
  MemoryNodeStatus,
  MemoryNodeType,
  MemoryProvenance,
  MemoryQuery,
  MemoryRetrievalHit,
  MemorySourceType,
} from '@atris-agent-code/domain';
import { rankMemoryNodes } from './memory-retrieval';

export interface RawSqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface RawSqliteConnection {
  exec(sql: string): unknown;
  prepare(sql: string): RawSqliteStatement;
}

export interface ProjectMemoryOverview {
  project: ProjectSelect;
  space: ProjectMemorySpaceSelect | null;
  activeWorkspaceIds: string[];
  evidenceCount: number;
}

export interface ProjectMemorySnapshot extends ProjectMemoryOverview {
  nodes: MemoryNodeSelect[];
  edges: MemoryEdgeSelect[];
}

export interface ManualMemoryInput {
  type?: MemoryNodeType;
  title: string;
  summary: string;
  body?: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  pinned?: boolean;
}

const SALIENT_EVENT_TYPES = new Set<AgentEvent['type']>([
  'user_message',
  'plan_generated',
  'plan_revised',
  'task_created',
  'task_completed',
  'task_failed',
  'file_changed',
  'approval_responded',
  'check_completed',
  'review_completed',
  'verification_finding',
  'verification_completed',
  'changes_applied',
  'mission_completed',
  'mission_failed',
]);

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeWorkspacePath(workspacePath: string): string {
  const normalized = path.normalize(path.resolve(workspacePath));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\\/g, '/').replace(/\.git$/i, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLocaleLowerCase('en-US').replace(/\/$/, '');
  } catch {
    return trimmed
      .replace(/^git@([^:]+):/i, 'ssh://$1/')
      .replace(/^ssh:\/\/git@/i, 'ssh://')
      .toLocaleLowerCase('en-US');
  }
}

function repositoryFingerprint(workspacePath: string): string {
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  try {
    const remote = execFileSync('git', ['-C', workspacePath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    const normalizedRemote = normalizeRemote(remote);
    if (normalizedRemote) return sha256(`git-origin:${normalizedRemote}`);
  } catch {
    // Non-git or local-only projects fall back to normalized path identity.
  }
  return sha256(`local-path:${normalizedPath}`);
}

function eventTaskId(event: AgentEvent): string | null {
  return 'taskId' in event && typeof event.taskId === 'string' ? event.taskId : null;
}

function eventAgentId(event: AgentEvent): string | null {
  return 'agentInstanceId' in event && typeof event.agentInstanceId === 'string' ? event.agentInstanceId : null;
}

function eventContent(event: AgentEvent): string {
  switch (event.type) {
    case 'user_message': return event.content;
    case 'plan_generated': return event.summary;
    case 'plan_revised': return event.reason;
    case 'task_created': return event.title;
    case 'task_completed': return event.result || '';
    case 'task_failed': return event.error;
    case 'file_changed': return `${event.changeType} ${event.path} (+${event.additions}/-${event.deletions})`;
    case 'approval_responded': return `${event.approved ? 'Approved' : 'Rejected'} by ${event.decidedBy}`;
    case 'check_completed': return `${event.checkName}: ${event.passed ? 'passed' : 'failed'} — ${event.summary}`;
    case 'review_completed': return `${event.approved ? 'Approved' : 'Changes requested'} — ${event.findings}`;
    case 'verification_finding': return `${event.title}: ${event.description}`;
    case 'verification_completed': return `${event.passed ? 'Passed' : 'Failed'} — ${event.summary}`;
    case 'changes_applied': return `Applied ${event.filesChanged} file changes at checkpoint ${event.checkpointId}`;
    case 'mission_completed': return event.summary;
    case 'mission_failed': return event.reason;
    default: return '';
  }
}

function memorySourceForEvent(event: AgentEvent, taskRole?: string | null): MemorySourceType {
  if (event.type === 'user_message') return 'user_message';
  if (event.type === 'file_changed' || event.type === 'changes_applied') return 'git_diff';
  if (event.type === 'check_completed' || event.type === 'verification_completed' || event.type === 'verification_finding') return 'test_output';
  if (event.type === 'review_completed') return 'review';
  if (event.type === 'task_completed' && taskRole === 'researcher') return 'research';
  return 'agent_output';
}

function createdByForEvent(event: AgentEvent): MemoryProvenance['createdBy'] {
  if (event.type === 'user_message') return 'user';
  if (event.type === 'plan_generated' || event.type === 'plan_revised' || event.type === 'mission_completed') return 'orchestrator';
  if ('agentInstanceId' in event || event.type.startsWith('task_') || event.type === 'file_changed') return 'worker';
  return 'memory_curator';
}

function classifyUserMessage(content: string): { type: MemoryNodeType; importance: number } {
  const normalized = content.toLocaleLowerCase('tr-TR').trim();
  if (normalized.length < 42 && /^(devam|devam edelim|tamam|olur|uygula|yapalım|geçelim|continue|go ahead)[.!\s]*$/i.test(normalized)) {
    return { type: 'turn', importance: 0.3 };
  }
  if (/(sadece|istemiyorum|olmalı|olmamalı|gerek|zorunlu|must|must not|only|do not|don't|never)/i.test(normalized)) {
    return { type: 'user_constraint', importance: 0.95 };
  }
  return { type: 'requirement', importance: 0.82 };
}

function stableNodeId(prefix: string, identity: string): string {
  return `${prefix}-${sha256(identity).slice(0, 24)}`;
}

/**
 * SQLite-backed durable project memory with an immutable evidence ledger, graph
 * topology and optional FTS5 index. Drizzle owns relational persistence while the
 * raw sqlite handle is used only for schema bootstrap and FTS5 operations.
 */
export class ProjectMemoryService {
  private ftsAvailable = false;
  private curatorUnsubscribe?: Unsubscribe;

  constructor(
    private readonly db: AtrisDatabase,
    private readonly sqlite: RawSqliteConnection,
  ) {
    this.ensureSchema();
    this.rebuildFtsIndex();
  }

  startCurator(eventBus: LocalEventBus): void {
    this.curatorUnsubscribe?.();
    this.curatorUnsubscribe = eventBus.on('*', async (event) => {
      if (!SALIENT_EVENT_TYPES.has(event.type)) return;
      await this.ingestEvent(event);
    });
  }

  stopCurator(): void {
    this.curatorUnsubscribe?.();
    this.curatorUnsubscribe = undefined;
  }

  private ensureSchema(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        normalized_path TEXT,
        repository_fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        detached_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_repository_fingerprint ON projects(repository_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_projects_normalized_path ON projects(normalized_path);
      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

      CREATE TABLE IF NOT EXISTS project_workspace_links (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        attached_at TEXT NOT NULL,
        detached_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_workspace_links_workspace ON project_workspace_links(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_project_workspace_links_project ON project_workspace_links(project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_workspace_links_unique ON project_workspace_links(project_id, workspace_id);

      CREATE TABLE IF NOT EXISTS project_memory_spaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        node_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_memory_spaces_project ON project_memory_spaces(project_id);

      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL NOT NULL DEFAULT 0.7,
        importance REAL NOT NULL DEFAULT 0.5,
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        provenance TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verified_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_project ON memory_nodes(project_id);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_project_type ON memory_nodes(project_id, type);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_project_status ON memory_nodes(project_id, status);

      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_edges_project ON memory_edges(project_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(project_id, from_node_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(project_id, to_node_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_unique ON memory_edges(project_id, from_node_id, to_node_id, type);

      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT,
        mission_id TEXT,
        task_id TEXT,
        agent_instance_id TEXT,
        event_type TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        curated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_evidence_project_created ON memory_evidence(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_evidence_mission ON memory_evidence(mission_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_evidence_project_source ON memory_evidence(project_id, source_id);
    `);

    try {
      this.sqlite.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
          node_id UNINDEXED,
          project_id UNINDEXED,
          title,
          summary,
          body,
          tags,
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      this.ftsAvailable = true;
    } catch (error) {
      this.ftsAvailable = false;
      console.warn('[ProjectMemory] FTS5 unavailable; lexical retrieval will use the in-process ranker.', error);
    }
  }

  private rebuildFtsIndex(): void {
    if (!this.ftsAvailable) return;
    try {
      this.sqlite.exec(`
        DELETE FROM memory_nodes_fts;
        INSERT INTO memory_nodes_fts(node_id, project_id, title, summary, body, tags)
        SELECT id, project_id, title, summary, COALESCE(body, ''), COALESCE(tags, '[]') FROM memory_nodes;
      `);
    } catch (error) {
      this.ftsAvailable = false;
      console.warn('[ProjectMemory] Failed to rebuild FTS5 index; continuing without it.', error);
    }
  }

  async attachWorkspace(workspace: WorkspaceSelect): Promise<ProjectMemoryOverview> {
    const normalizedPath = normalizeWorkspacePath(workspace.path);
    const fingerprint = repositoryFingerprint(workspace.path);
    const now = new Date().toISOString();
    const byFingerprint = await this.db.select().from(projects).where(eq(projects.repositoryFingerprint, fingerprint));
    const byPath = byFingerprint[0]
      ? []
      : await this.db.select().from(projects).where(eq(projects.normalizedPath, normalizedPath));
    let project = byFingerprint[0] || byPath[0] || null;

    if (!project) {
      const projectId = crypto.randomUUID();
      await this.db.insert(projects).values({
        id: projectId,
        displayName: workspace.name,
        normalizedPath,
        repositoryFingerprint: fingerprint,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        detachedAt: null,
      });
      await this.db.insert(projectMemorySpaces).values({
        id: crypto.randomUUID(),
        projectId,
        status: 'active',
        nodeCount: 0,
        edgeCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      project = (await this.db.select().from(projects).where(eq(projects.id, projectId)))[0];
      await this.ensureProjectRoot(project);
    } else {
      const nextStatus = project.status === 'detached' ? 'active' : project.status;
      await this.db.update(projects).set({
        displayName: workspace.name,
        normalizedPath,
        repositoryFingerprint: fingerprint,
        status: nextStatus,
        detachedAt: nextStatus === 'active' ? null : project.detachedAt,
        updatedAt: now,
      }).where(eq(projects.id, project.id));
      if (nextStatus === 'active') {
        await this.db.update(projectMemorySpaces).set({ status: 'active', updatedAt: now })
          .where(eq(projectMemorySpaces.projectId, project.id));
      }
      project = (await this.db.select().from(projects).where(eq(projects.id, project.id)))[0];
      await this.ensureProjectRoot(project);
    }

    const links = await this.db.select().from(projectWorkspaceLinks).where(and(
      eq(projectWorkspaceLinks.projectId, project.id),
      eq(projectWorkspaceLinks.workspaceId, workspace.id),
    ));
    if (links[0]) {
      await this.db.update(projectWorkspaceLinks).set({
        workspacePath: normalizedPath,
        active: true,
        attachedAt: now,
        detachedAt: null,
      }).where(eq(projectWorkspaceLinks.id, links[0].id));
    } else {
      await this.db.insert(projectWorkspaceLinks).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        workspaceId: workspace.id,
        workspacePath: normalizedPath,
        active: true,
        attachedAt: now,
        detachedAt: null,
      });
    }
    return this.getOverview(project.id);
  }

  async detachWorkspace(workspaceId: string): Promise<void> {
    const links = await this.db.select().from(projectWorkspaceLinks).where(eq(projectWorkspaceLinks.workspaceId, workspaceId));
    const now = new Date().toISOString();
    for (const link of links.filter((item) => item.active)) {
      await this.db.update(projectWorkspaceLinks).set({ active: false, detachedAt: now })
        .where(eq(projectWorkspaceLinks.id, link.id));
      const remaining = (await this.db.select().from(projectWorkspaceLinks).where(eq(projectWorkspaceLinks.projectId, link.projectId)))
        .some((item) => item.active && item.workspaceId !== workspaceId);
      if (!remaining) {
        const project = (await this.db.select().from(projects).where(eq(projects.id, link.projectId)))[0];
        if (project && project.status !== 'archived') {
          await this.db.update(projects).set({ status: 'detached', detachedAt: now, updatedAt: now })
            .where(eq(projects.id, link.projectId));
        }
      }
    }
  }

  async archiveProject(projectId: string): Promise<ProjectMemoryOverview> {
    const now = new Date().toISOString();
    await this.db.update(projects).set({ status: 'archived', updatedAt: now }).where(eq(projects.id, projectId));
    await this.db.update(projectMemorySpaces).set({ status: 'archived', updatedAt: now })
      .where(eq(projectMemorySpaces.projectId, projectId));
    return this.getOverview(projectId);
  }

  async restoreProject(projectId: string): Promise<ProjectMemoryOverview> {
    const links = await this.db.select().from(projectWorkspaceLinks).where(eq(projectWorkspaceLinks.projectId, projectId));
    const active = links.some((link) => link.active);
    const now = new Date().toISOString();
    await this.db.update(projects).set({
      status: active ? 'active' : 'detached',
      detachedAt: active ? null : now,
      updatedAt: now,
    }).where(eq(projects.id, projectId));
    await this.db.update(projectMemorySpaces).set({ status: 'active', updatedAt: now })
      .where(eq(projectMemorySpaces.projectId, projectId));
    return this.getOverview(projectId);
  }

  async resolveProjectForWorkspace(workspaceId: string): Promise<ProjectSelect | null> {
    const links = await this.db.select().from(projectWorkspaceLinks).where(eq(projectWorkspaceLinks.workspaceId, workspaceId));
    const link = links.find((item) => item.active) || links[0];
    if (!link) return null;
    return (await this.db.select().from(projects).where(eq(projects.id, link.projectId)))[0] || null;
  }

  async resolveProjectForMission(missionId: string): Promise<ProjectSelect | null> {
    const mission = (await this.db.select().from(missions).where(eq(missions.id, missionId)))[0];
    if (!mission) return null;
    return this.resolveProjectForWorkspace(mission.workspaceId);
  }

  async listProjects(): Promise<ProjectMemoryOverview[]> {
    const rows = await this.db.select().from(projects);
    const result: ProjectMemoryOverview[] = [];
    for (const project of rows) result.push(await this.getOverview(project.id));
    return result.sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt));
  }

  async getOverview(projectId: string): Promise<ProjectMemoryOverview> {
    const project = (await this.db.select().from(projects).where(eq(projects.id, projectId)))[0];
    if (!project) throw new Error(`Project memory '${projectId}' was not found.`);
    const space = (await this.db.select().from(projectMemorySpaces).where(eq(projectMemorySpaces.projectId, projectId)))[0] || null;
    const links = await this.db.select().from(projectWorkspaceLinks).where(eq(projectWorkspaceLinks.projectId, projectId));
    const evidence = await this.db.select().from(memoryEvidence).where(eq(memoryEvidence.projectId, projectId));
    return {
      project,
      space,
      activeWorkspaceIds: links.filter((link) => link.active).map((link) => link.workspaceId),
      evidenceCount: evidence.length,
    };
  }

  async getSnapshot(projectId: string): Promise<ProjectMemorySnapshot> {
    const overview = await this.getOverview(projectId);
    const nodes = await this.db.select().from(memoryNodes).where(eq(memoryNodes.projectId, projectId));
    const edges = await this.db.select().from(memoryEdges).where(eq(memoryEdges.projectId, projectId));
    return { ...overview, nodes, edges };
  }

  async createManualMemory(projectId: string, input: ManualMemoryInput): Promise<MemoryNodeSelect> {
    const project = (await this.db.select().from(projects).where(eq(projects.id, projectId)))[0];
    if (!project) throw new Error(`Project memory '${projectId}' was not found.`);
    const provenance: MemoryProvenance = {
      sourceType: 'manual',
      createdBy: 'user',
    };
    return this.upsertNode({
      id: crypto.randomUUID(),
      projectId,
      type: input.type || 'lesson',
      title: input.title,
      summary: input.summary,
      body: input.body,
      confidence: clamp01(input.confidence ?? 1, 1),
      importance: clamp01(input.importance ?? 0.8, 0.8),
      pinned: input.pinned ?? false,
      tags: uniqueStrings(input.tags || ['manual']),
      provenance: [provenance],
    });
  }

  async updateMemoryNode(nodeId: string, updates: Partial<Pick<MemoryNode,
    'title' | 'summary' | 'body' | 'status' | 'confidence' | 'importance' | 'pinned' | 'tags' | 'lastVerifiedAt'
  >>): Promise<MemoryNodeSelect> {
    const current = (await this.db.select().from(memoryNodes).where(eq(memoryNodes.id, nodeId)))[0];
    if (!current) throw new Error(`Memory node '${nodeId}' was not found.`);
    const now = new Date().toISOString();
    await this.db.update(memoryNodes).set({
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.summary !== undefined ? { summary: updates.summary } : {}),
      ...(updates.body !== undefined ? { body: updates.body } : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
      ...(updates.confidence !== undefined ? { confidence: clamp01(updates.confidence, current.confidence) } : {}),
      ...(updates.importance !== undefined ? { importance: clamp01(updates.importance, current.importance) } : {}),
      ...(updates.pinned !== undefined ? { pinned: updates.pinned } : {}),
      ...(updates.tags !== undefined ? { tags: uniqueStrings(updates.tags) } : {}),
      ...(updates.lastVerifiedAt !== undefined ? { lastVerifiedAt: updates.lastVerifiedAt } : {}),
      updatedAt: now,
    }).where(eq(memoryNodes.id, nodeId));
    const updated = (await this.db.select().from(memoryNodes).where(eq(memoryNodes.id, nodeId)))[0];
    this.syncFtsNode(updated);
    return updated;
  }

  async deleteMemoryNode(nodeId: string): Promise<void> {
    const current = (await this.db.select().from(memoryNodes).where(eq(memoryNodes.id, nodeId)))[0];
    if (!current) return;
    if (nodeId === this.projectRootNodeId(current.projectId)) {
      throw new Error('The project root memory node cannot be deleted.');
    }
    await this.db.delete(memoryNodes).where(eq(memoryNodes.id, nodeId));
    if (this.ftsAvailable) this.sqlite.prepare('DELETE FROM memory_nodes_fts WHERE node_id = ?').run(nodeId);
    await this.refreshCounts(current.projectId);
  }

  async search(query: MemoryQuery): Promise<MemoryRetrievalHit[]> {
    const project = (await this.db.select().from(projects).where(eq(projects.id, query.projectId)))[0];
    if (!project || (project.status === 'archived' && !query.includeArchived)) return [];

    const allNodes = await this.db.select().from(memoryNodes).where(eq(memoryNodes.projectId, query.projectId));
    const allEdges = await this.db.select().from(memoryEdges).where(eq(memoryEdges.projectId, query.projectId));
    if (allNodes.length === 0) return [];

    const ftsScores = this.searchFts(query.projectId, query.text, Math.max(24, (query.limit || 12) * 3));
    const anchorIds = uniqueStrings([
      ...(query.anchorNodeIds || []),
      ...[...ftsScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id),
    ]);
    const graphDistances = this.computeGraphDistances(anchorIds, allEdges, 2);
    const candidateIds = new Set<string>([
      ...ftsScores.keys(),
      ...graphDistances.keys(),
      ...allNodes.filter((node) => node.pinned).map((node) => node.id),
    ]);
    const candidates = candidateIds.size > 0
      ? allNodes.filter((node) => candidateIds.has(node.id))
      : allNodes.slice(-250);

    const ranked = rankMemoryNodes({
      nodes: candidates as MemoryNode[],
      query,
      graphDistances,
    }).map((hit) => {
      const ftsBoost = ftsScores.get(hit.node.id) || 0;
      return { ...hit, score: clamp01(hit.score * 0.82 + ftsBoost * 0.18, hit.score) };
    });
    return ranked
      .sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt))
      .slice(0, Math.max(1, query.limit || 12));
  }

  async ingestEvent(event: AgentEvent): Promise<void> {
    if (!SALIENT_EVENT_TYPES.has(event.type)) return;
    const project = await this.resolveProjectForMission(event.missionId);
    if (!project || project.status === 'archived') return;

    const existing = await this.db.select().from(memoryEvidence).where(and(
      eq(memoryEvidence.projectId, project.id),
      eq(memoryEvidence.sourceId, event.id),
    ));
    if (existing[0]) return;

    const taskId = eventTaskId(event);
    const task = taskId ? (await this.db.select().from(tasks).where(eq(tasks.id, taskId)))[0] : undefined;
    const content = eventContent(event).slice(0, 24_000);
    const sourceType = memorySourceForEvent(event, task?.assignedRole);
    const now = new Date().toISOString();
    await this.db.insert(memoryEvidence).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      sourceType,
      sourceId: event.id,
      missionId: event.missionId,
      taskId,
      agentInstanceId: eventAgentId(event),
      eventType: event.type,
      content,
      contentHash: sha256(`${event.type}\n${content}\n${JSON.stringify(event)}`),
      payload: event as unknown as Record<string, unknown>,
      createdAt: event.timestamp,
      curatedAt: null,
    });

    await this.curateEvent(project, event, task || null, sourceType, content);
    await this.db.update(memoryEvidence).set({ curatedAt: now }).where(and(
      eq(memoryEvidence.projectId, project.id),
      eq(memoryEvidence.sourceId, event.id),
    ));
  }

  private async curateEvent(
    project: ProjectSelect,
    event: AgentEvent,
    task: typeof tasks.$inferSelect | null,
    sourceType: MemorySourceType,
    content: string,
  ): Promise<void> {
    const baseProvenance: MemoryProvenance = {
      sourceType,
      sourceId: event.id,
      missionId: event.missionId,
      taskId: eventTaskId(event),
      agentInstanceId: eventAgentId(event),
      createdBy: createdByForEvent(event),
    };
    const rootId = this.projectRootNodeId(project.id);

    if (event.type === 'task_created') {
      const node = await this.upsertNode({
        id: this.taskNodeId(event.taskId),
        projectId: project.id,
        type: 'task',
        title: event.title,
        summary: event.spawnReason || event.title,
        confidence: 0.95,
        importance: 0.5,
        tags: uniqueStrings(['task', event.assignedRole || '', event.specialty || '']),
        provenance: [baseProvenance],
      });
      await this.ensureEdge(project.id, node.id, rootId, 'belongs_to', 1, 'memory_curator');
      return;
    }

    if (event.type === 'user_message') {
      const classification = classifyUserMessage(event.content);
      const node = await this.upsertNode({
        id: stableNodeId('user', event.id),
        projectId: project.id,
        type: classification.type,
        title: classification.type === 'user_constraint' ? 'User constraint' : classification.type === 'turn' ? 'Conversation turn' : 'User requirement',
        summary: event.content.slice(0, 1_200),
        body: event.content,
        confidence: 1,
        importance: classification.importance,
        tags: ['user', classification.type],
        provenance: [baseProvenance],
      });
      await this.ensureEdge(project.id, node.id, rootId, 'belongs_to', 1, 'memory_curator');
      return;
    }

    if (event.type === 'file_changed') {
      const fileId = stableNodeId('file', `${project.id}:${event.path}`);
      const fileNode = await this.upsertNode({
        id: fileId,
        projectId: project.id,
        type: 'file',
        title: event.path,
        summary: `Project file tracked by memory; latest observed change: ${event.changeType}.`,
        confidence: 0.98,
        importance: 0.55,
        tags: ['file', event.changeType],
        provenance: [{ ...baseProvenance, path: event.path }],
      });
      const changeNode = await this.upsertNode({
        id: stableNodeId('change', event.id),
        projectId: project.id,
        type: 'change',
        title: `${event.changeType}: ${event.path}`,
        summary: content,
        confidence: 0.98,
        importance: 0.65,
        tags: ['change', event.changeType],
        provenance: [{ ...baseProvenance, path: event.path }],
      });
      await this.ensureEdge(project.id, fileNode.id, rootId, 'belongs_to', 1, 'memory_curator');
      await this.ensureEdge(project.id, changeNode.id, fileNode.id, 'affects', 1, 'memory_curator');
      return;
    }

    let type: MemoryNodeType = 'session';
    let title = event.type.replaceAll('_', ' ');
    let importance = 0.6;
    let confidence = 0.9;
    let status: MemoryNodeStatus = 'active';

    switch (event.type) {
      case 'plan_generated':
      case 'plan_revised':
      case 'approval_responded':
        type = 'decision';
        title = event.type === 'approval_responded' ? 'Execution approval decision' : 'Orchestrator plan decision';
        importance = 0.65;
        break;
      case 'task_completed':
        type = task?.assignedRole === 'researcher'
          ? 'research_finding'
          : task?.assignedRole === 'builder'
            ? 'change'
            : task?.assignedRole === 'reviewer' || task?.assignedRole === 'qa'
              ? 'verification'
              : 'task';
        title = task?.title || 'Task result';
        importance = type === 'research_finding' ? 0.72 : type === 'change' ? 0.8 : 0.62;
        break;
      case 'task_failed':
        type = 'bug';
        title = task?.title ? `Task failed: ${task.title}` : 'Task failure';
        importance = 0.82;
        confidence = 1;
        break;
      case 'check_completed':
        type = 'test';
        title = `${event.passed ? 'Passed' : 'Failed'}: ${event.checkName}`;
        importance = event.passed ? 0.55 : 0.78;
        confidence = 1;
        break;
      case 'review_completed':
      case 'verification_completed':
        type = 'verification';
        title = event.type === 'review_completed' ? 'Code review result' : 'Verification result';
        importance = 0.72;
        confidence = 1;
        break;
      case 'verification_finding':
        type = 'issue';
        title = event.title;
        importance = event.severity === 'critical' ? 1 : event.severity === 'major' ? 0.85 : 0.65;
        confidence = 0.96;
        break;
      case 'changes_applied':
        type = 'change';
        title = 'Changes applied to project';
        importance = 0.82;
        confidence = 1;
        break;
      case 'mission_completed':
        type = 'session';
        title = 'Conversation outcome';
        importance = 0.68;
        break;
      case 'mission_failed':
        type = 'issue';
        title = 'Conversation execution failed';
        importance = 0.9;
        confidence = 1;
        break;
      default:
        break;
    }

    if (!content.trim()) status = 'stale';
    const node = await this.upsertNode({
      id: stableNodeId(event.type, event.id),
      projectId: project.id,
      type,
      title,
      summary: content.slice(0, 1_500) || title,
      body: content || undefined,
      status,
      confidence,
      importance,
      tags: uniqueStrings([event.type, task?.assignedRole || '']),
      provenance: [baseProvenance],
      lastVerifiedAt: type === 'verification' || type === 'test' ? event.timestamp : undefined,
    });
    await this.ensureEdge(project.id, node.id, rootId, 'belongs_to', 1, 'memory_curator');

    if (task?.id) {
      const taskNode = await this.upsertNode({
        id: this.taskNodeId(task.id),
        projectId: project.id,
        type: 'task',
        title: task.title,
        summary: task.description || task.title,
        confidence: 0.98,
        importance: 0.5,
        tags: uniqueStrings(['task', task.assignedRole || '']),
        provenance: [baseProvenance],
      });
      await this.ensureEdge(project.id, taskNode.id, rootId, 'belongs_to', 1, 'memory_curator');
      const edgeType: MemoryEdgeType = type === 'verification' || type === 'test' ? 'verified_by' : 'produced_by';
      if (edgeType === 'verified_by') {
        await this.ensureEdge(project.id, taskNode.id, node.id, edgeType, 0.95, 'memory_curator');
      } else {
        await this.ensureEdge(project.id, node.id, taskNode.id, edgeType, 0.95, 'memory_curator');
      }
    }
  }

  private projectRootNodeId(projectId: string): string {
    return `project-${projectId}`;
  }

  private taskNodeId(taskId: string): string {
    return `task-${taskId}`;
  }

  private async ensureProjectRoot(project: ProjectSelect): Promise<void> {
    await this.upsertNode({
      id: this.projectRootNodeId(project.id),
      projectId: project.id,
      type: 'project',
      title: project.displayName,
      summary: `Persistent AtrisAgent project memory for ${project.displayName}.`,
      confidence: 1,
      importance: 1,
      pinned: true,
      tags: ['project', 'root'],
      provenance: [{ sourceType: 'manual', createdBy: 'system' }],
    });
  }

  private async upsertNode(input: MemoryCandidate & {
    id: string;
    status?: MemoryNodeStatus;
    pinned?: boolean;
    lastVerifiedAt?: string;
  }): Promise<MemoryNodeSelect> {
    const now = new Date().toISOString();
    const existing = (await this.db.select().from(memoryNodes).where(eq(memoryNodes.id, input.id)))[0];
    if (existing) {
      const mergedTags = uniqueStrings([...(existing.tags || []), ...(input.tags || [])]);
      const provenance = [...(existing.provenance || [])];
      for (const item of input.provenance) {
        const identity = JSON.stringify(item);
        if (!provenance.some((existingItem) => JSON.stringify(existingItem) === identity)) provenance.push(item);
      }
      await this.db.update(memoryNodes).set({
        type: input.type,
        title: input.title,
        summary: input.summary,
        body: input.body ?? existing.body,
        status: input.status ?? existing.status,
        confidence: Math.max(existing.confidence, clamp01(input.confidence, existing.confidence)),
        importance: Math.max(existing.importance, clamp01(input.importance, existing.importance)),
        pinned: input.pinned ?? existing.pinned,
        tags: mergedTags,
        provenance,
        updatedAt: now,
        lastVerifiedAt: input.lastVerifiedAt ?? existing.lastVerifiedAt,
      }).where(eq(memoryNodes.id, input.id));
      const updated = (await this.db.select().from(memoryNodes).where(eq(memoryNodes.id, input.id)))[0];
      this.syncFtsNode(updated);
      return updated;
    }

    await this.db.insert(memoryNodes).values({
      id: input.id,
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      summary: input.summary,
      body: input.body || null,
      status: input.status || 'active',
      confidence: clamp01(input.confidence, 0.7),
      importance: clamp01(input.importance, 0.5),
      pinned: input.pinned ?? false,
      tags: uniqueStrings(input.tags || []),
      provenance: input.provenance,
      createdAt: now,
      updatedAt: now,
      lastVerifiedAt: input.lastVerifiedAt || null,
    });
    const created = (await this.db.select().from(memoryNodes).where(eq(memoryNodes.id, input.id)))[0];
    this.syncFtsNode(created);
    await this.refreshCounts(input.projectId);
    return created;
  }

  private async ensureEdge(
    projectId: string,
    fromNodeId: string,
    toNodeId: string,
    type: MemoryEdgeType,
    confidence: number,
    createdBy: MemoryProvenance['createdBy'],
  ): Promise<void> {
    if (fromNodeId === toNodeId) return;
    const existing = await this.db.select().from(memoryEdges).where(and(
      eq(memoryEdges.projectId, projectId),
      eq(memoryEdges.fromNodeId, fromNodeId),
      eq(memoryEdges.toNodeId, toNodeId),
      eq(memoryEdges.type, type),
    ));
    if (existing[0]) return;
    await this.db.insert(memoryEdges).values({
      id: crypto.randomUUID(),
      projectId,
      fromNodeId,
      toNodeId,
      type,
      confidence: clamp01(confidence, 0.7),
      createdAt: new Date().toISOString(),
      createdBy,
    });
    await this.refreshCounts(projectId);
  }

  private async refreshCounts(projectId: string): Promise<void> {
    const nodes = await this.db.select().from(memoryNodes).where(eq(memoryNodes.projectId, projectId));
    const edges = await this.db.select().from(memoryEdges).where(eq(memoryEdges.projectId, projectId));
    await this.db.update(projectMemorySpaces).set({
      nodeCount: nodes.length,
      edgeCount: edges.length,
      updatedAt: new Date().toISOString(),
    }).where(eq(projectMemorySpaces.projectId, projectId));
  }

  private syncFtsNode(node: MemoryNodeSelect): void {
    if (!this.ftsAvailable) return;
    try {
      this.sqlite.prepare('DELETE FROM memory_nodes_fts WHERE node_id = ?').run(node.id);
      this.sqlite.prepare(`
        INSERT INTO memory_nodes_fts(node_id, project_id, title, summary, body, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(node.id, node.projectId, node.title, node.summary, node.body || '', JSON.stringify(node.tags || []));
    } catch (error) {
      this.ftsAvailable = false;
      console.warn('[ProjectMemory] FTS5 sync failed; disabling FTS for this process.', error);
    }
  }

  private searchFts(projectId: string, text: string, limit: number): Map<string, number> {
    const scores = new Map<string, number>();
    if (!this.ftsAvailable) return scores;
    const terms = uniqueStrings(
      (text.toLocaleLowerCase('tr-TR').match(/[\p{L}\p{N}_./-]{2,}/gu) || []).slice(0, 16),
    );
    if (terms.length === 0) return scores;
    const matchQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    try {
      const rows = this.sqlite.prepare(`
        SELECT node_id AS nodeId, bm25(memory_nodes_fts) AS rank
        FROM memory_nodes_fts
        WHERE memory_nodes_fts MATCH ? AND project_id = ?
        ORDER BY rank
        LIMIT ?
      `).all(matchQuery, projectId, limit) as Array<{ nodeId: string; rank: number }>;
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const positionScore = 1 - (index / Math.max(1, rows.length));
        const bm25Score = 1 / (1 + Math.abs(Number(row.rank) || 0));
        scores.set(row.nodeId, clamp01(positionScore * 0.65 + bm25Score * 0.35, positionScore));
      }
    } catch (error) {
      console.warn('[ProjectMemory] FTS5 query failed; falling back to lexical ranking.', error);
    }
    return scores;
  }

  private computeGraphDistances(anchorIds: string[], edges: MemoryEdgeSelect[], maxDistance: number): Map<string, number> {
    const distance = new Map<string, number>();
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!adjacency.has(edge.fromNodeId)) adjacency.set(edge.fromNodeId, new Set());
      if (!adjacency.has(edge.toNodeId)) adjacency.set(edge.toNodeId, new Set());
      adjacency.get(edge.fromNodeId)!.add(edge.toNodeId);
      adjacency.get(edge.toNodeId)!.add(edge.fromNodeId);
    }
    const queue: Array<{ id: string; depth: number }> = [];
    for (const id of anchorIds) {
      if (distance.has(id)) continue;
      distance.set(id, 0);
      queue.push({ id, depth: 0 });
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDistance) continue;
      for (const neighbor of adjacency.get(current.id) || []) {
        const nextDepth = current.depth + 1;
        if ((distance.get(neighbor) ?? Number.POSITIVE_INFINITY) <= nextDepth) continue;
        distance.set(neighbor, nextDepth);
        queue.push({ id: neighbor, depth: nextDepth });
      }
    }
    return distance;
  }
}
