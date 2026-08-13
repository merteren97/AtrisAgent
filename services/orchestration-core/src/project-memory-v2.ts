import { eq } from 'drizzle-orm';
import {
  missions,
  projectWorkspaceLinks,
  workspaces,
  type AtrisDatabase,
  type ProjectSelect,
} from '@atris-agent-code/database';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import {
  ProjectMemoryService,
  type ProjectMemoryOverview,
  type RawSqliteConnection,
} from './project-memory';

function resolveRawSqlite(db: AtrisDatabase, explicit?: RawSqliteConnection): RawSqliteConnection {
  if (explicit) return explicit;
  const candidate = (db as any).$client
    || (db as any).session?.client
    || (db as any)._?.session?.client;
  if (!candidate || typeof candidate.exec !== 'function' || typeof candidate.prepare !== 'function') {
    throw new Error('Project memory requires the local better-sqlite3 client exposed by the Atris database runtime.');
  }
  return candidate as RawSqliteConnection;
}

function redactMemoryValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/Authorization:\s*(?:Bearer|Basic)\s+[^\s"'\r\n]+/gi, 'Authorization: [REDACTED]')
      .replace(/\b(?:sk-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_.-]{12,}\b/g, '[REDACTED_SECRET]')
      .replace(/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi, '$1=[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redactMemoryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactMemoryValue(item)]),
    );
  }
  return value;
}

/**
 * Lifecycle-aware memory service used by the application runtime.
 *
 * Existing installations can already contain workspaces created before Phase 3.
 * The first mission event lazily attaches such a workspace to a stable project
 * identity, while overview reads reconcile links whose workspace row has since
 * been removed. This keeps the rollout migration-free for users.
 */
export class ProjectMemoryServiceV2 extends ProjectMemoryService {
  private readonly attachmentPromises = new Map<string, Promise<ProjectSelect | null>>();

  constructor(
    private readonly lifecycleDb: AtrisDatabase,
    sqlite?: RawSqliteConnection,
  ) {
    super(lifecycleDb, resolveRawSqlite(lifecycleDb, sqlite));
  }

  override async ingestEvent(event: AgentEvent): Promise<void> {
    const redacted = redactMemoryValue(event) as AgentEvent;
    await super.ingestEvent(redacted);
  }

  override async resolveProjectForMission(missionId: string): Promise<ProjectSelect | null> {
    const existing = await super.resolveProjectForMission(missionId);
    if (existing) return existing;

    const mission = (await this.lifecycleDb.select().from(missions).where(eq(missions.id, missionId)))[0];
    if (!mission) return null;
    const workspace = (await this.lifecycleDb.select().from(workspaces).where(eq(workspaces.id, mission.workspaceId)))[0];
    if (!workspace) return null;

    const inFlight = this.attachmentPromises.get(workspace.id);
    if (inFlight) return inFlight;

    const attachment = (async () => {
      const resolvedDuringWait = await super.resolveProjectForMission(missionId);
      if (resolvedDuringWait) return resolvedDuringWait;
      return (await this.attachWorkspace(workspace)).project;
    })();
    this.attachmentPromises.set(workspace.id, attachment);
    try {
      return await attachment;
    } finally {
      if (this.attachmentPromises.get(workspace.id) === attachment) {
        this.attachmentPromises.delete(workspace.id);
      }
    }
  }

  override async getOverview(projectId: string): Promise<ProjectMemoryOverview> {
    await this.reconcileProjectAttachments(projectId);
    return super.getOverview(projectId);
  }

  private async reconcileProjectAttachments(projectId: string): Promise<void> {
    const links = await this.lifecycleDb.select().from(projectWorkspaceLinks)
      .where(eq(projectWorkspaceLinks.projectId, projectId));
    for (const link of links.filter((item) => item.active)) {
      const workspace = (await this.lifecycleDb.select().from(workspaces).where(eq(workspaces.id, link.workspaceId)))[0];
      if (!workspace) await this.detachWorkspace(link.workspaceId);
    }
  }
}
