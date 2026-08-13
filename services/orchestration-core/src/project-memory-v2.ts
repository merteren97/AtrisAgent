import { eq } from 'drizzle-orm';
import {
  missionEvents,
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
 * Existing installations can already contain workspaces and conversations from
 * before Phase 3. The first access lazily attaches the workspace and backfills its
 * normalized mission-event history into the immutable evidence ledger. New live
 * events then continue through the same curator path.
 */
export class ProjectMemoryServiceV2 extends ProjectMemoryService {
  private readonly attachmentPromises = new Map<string, Promise<ProjectSelect | null>>();
  private readonly backfillPromises = new Map<string, Promise<void>>();
  private readonly backfilledWorkspaceIds = new Set<string>();

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
    const mission = (await this.lifecycleDb.select().from(missions).where(eq(missions.id, missionId)))[0];
    if (!mission) return null;

    const existing = await super.resolveProjectForMission(missionId);
    if (existing) {
      // Recursive resolve calls made while replaying backfill evidence must not
      // await the same promise they are currently executing.
      if (!this.backfillPromises.has(mission.workspaceId)) {
        await this.ensureWorkspaceBackfill(mission.workspaceId);
      }
      return existing;
    }

    const workspace = (await this.lifecycleDb.select().from(workspaces).where(eq(workspaces.id, mission.workspaceId)))[0];
    if (!workspace) return null;

    const inFlight = this.attachmentPromises.get(workspace.id);
    if (inFlight) return inFlight;

    const attachment = (async () => {
      const resolvedDuringWait = await super.resolveProjectForMission(missionId);
      const project = resolvedDuringWait || (await this.attachWorkspace(workspace)).project;
      await this.ensureWorkspaceBackfill(workspace.id);
      return project;
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

  private async ensureWorkspaceBackfill(workspaceId: string): Promise<void> {
    if (this.backfilledWorkspaceIds.has(workspaceId)) return;
    const inFlight = this.backfillPromises.get(workspaceId);
    if (inFlight) return inFlight;

    const backfill = this.backfillWorkspaceHistory(workspaceId);
    this.backfillPromises.set(workspaceId, backfill);
    try {
      await backfill;
      this.backfilledWorkspaceIds.add(workspaceId);
    } finally {
      if (this.backfillPromises.get(workspaceId) === backfill) {
        this.backfillPromises.delete(workspaceId);
      }
    }
  }

  private async backfillWorkspaceHistory(workspaceId: string): Promise<void> {
    const workspaceMissions = await this.lifecycleDb.select().from(missions).where(eq(missions.workspaceId, workspaceId));
    for (const mission of workspaceMissions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const initialMessage = String(mission.description || mission.title || '').trim();
      if (initialMessage) {
        await this.ingestEvent({
          id: `memory-initial-user-${mission.id}`,
          type: 'user_message',
          missionId: mission.id,
          content: initialMessage,
          planId: mission.planId || null,
          previousPlanId: null,
          timestamp: mission.createdAt,
        });
      }

      const historicalEvents = await this.lifecycleDb.select().from(missionEvents)
        .where(eq(missionEvents.missionId, mission.id));
      historicalEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const row of historicalEvents) {
        const payload = row.payload as Partial<AgentEvent> | null;
        if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') continue;
        const reconstructed = {
          ...payload,
          id: typeof payload.id === 'string' ? payload.id : row.id,
          missionId: mission.id,
          timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : row.createdAt,
        } as AgentEvent;
        await this.ingestEvent(reconstructed);
      }
    }
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
