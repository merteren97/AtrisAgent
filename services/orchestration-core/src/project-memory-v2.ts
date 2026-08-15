import { eq } from 'drizzle-orm';
import {
  missionEvents,
  missions,
  projects,
  projectWorkspaceLinks,
  workspaces,
  type AtrisDatabase,
  type ProjectSelect,
} from '@atris-agent-code/database';
import type { AgentEvent } from '@atris-agent-code/event-schema';
import {
  redactSensitiveValue,
  type LocalEventBus,
  type Unsubscribe,
} from '@atris-agent-code/event-bus';
import {
  ProjectMemoryService,
  type ProjectMemoryOverview,
  type RawSqliteConnection,
} from './project-memory';

const LIVE_CURATOR_QUEUE_LIMIT = 512;
const LIVE_CURATOR_EVENT_TYPES = new Set<AgentEvent['type']>([
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
  private readonly lifecycleSqlite: RawSqliteConnection;
  private liveCuratorUnsubscribe?: Unsubscribe;
  private readonly liveCuratorQueue: AgentEvent[] = [];
  private liveCuratorDraining = false;
  private liveCuratorDropped = 0;

  constructor(
    private readonly lifecycleDb: AtrisDatabase,
    sqlite?: RawSqliteConnection,
  ) {
    const rawSqlite = resolveRawSqlite(lifecycleDb, sqlite);
    super(lifecycleDb, rawSqlite);
    this.lifecycleSqlite = rawSqlite;
  }

  override startCurator(eventBus: LocalEventBus): void {
    this.liveCuratorUnsubscribe?.();
    this.liveCuratorQueue.length = 0;
    this.liveCuratorDropped = 0;
    this.liveCuratorUnsubscribe = eventBus.on('*', (event) => {
      if (!LIVE_CURATOR_EVENT_TYPES.has(event.type)) return;
      if (this.liveCuratorQueue.length >= LIVE_CURATOR_QUEUE_LIMIT) {
        this.liveCuratorDropped += 1;
        if (this.liveCuratorDropped === 1 || this.liveCuratorDropped % 100 === 0) {
          console.warn(
            `[ProjectMemoryV2] Live curator queue is full; deferred ${this.liveCuratorDropped} event(s) to persisted-history recovery.`,
          );
        }
        return;
      }
      this.liveCuratorQueue.push(event);
      void this.drainLiveCuratorQueue();
    });
  }

  override stopCurator(): void {
    this.liveCuratorUnsubscribe?.();
    this.liveCuratorUnsubscribe = undefined;
    this.liveCuratorQueue.length = 0;
  }

  private async drainLiveCuratorQueue(): Promise<void> {
    if (this.liveCuratorDraining) return;
    this.liveCuratorDraining = true;
    try {
      while (this.liveCuratorQueue.length > 0) {
        const event = this.liveCuratorQueue.shift()!;
        try {
          await this.ingestEvent(event);
        } catch (error) {
          console.warn('[ProjectMemoryV2] Live curator failed to ingest an event; persisted history can recover it later.', error);
        }
      }
    } finally {
      this.liveCuratorDraining = false;
      if (this.liveCuratorQueue.length > 0) void this.drainLiveCuratorQueue();
    }
  }

  override async ingestEvent(event: AgentEvent): Promise<void> {
    const redacted = redactSensitiveValue(event) as AgentEvent;
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

  /**
   * Permanently removes a detached/archived project memory space. Active project
   * attachments are protected so a user cannot accidentally erase memory that is
   * still powering an open workspace.
   */
  async deleteProjectMemory(projectId: string): Promise<void> {
    const overview = await this.getOverview(projectId);
    if (overview.activeWorkspaceIds.length > 0) {
      throw new Error('Project memory is still attached to an active workspace. Remove the workspace first or keep the memory as a detached backup.');
    }

    try {
      this.lifecycleSqlite.prepare('DELETE FROM memory_nodes_fts WHERE project_id = ?').run(projectId);
    } catch {
      // FTS is optional and may not exist on this SQLite build.
    }
    await this.lifecycleDb.delete(projects).where(eq(projects.id, projectId));
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
