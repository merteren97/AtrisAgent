import { eq } from 'drizzle-orm';
import {
  missions,
  projectWorkspaceLinks,
  workspaces,
  type AtrisDatabase,
  type ProjectSelect,
} from '@atris-agent-code/database';
import {
  ProjectMemoryService,
  type ProjectMemoryOverview,
  type RawSqliteConnection,
} from './project-memory';

/**
 * Lifecycle-aware memory service used by the application runtime.
 *
 * Existing installations can already contain workspaces created before Phase 3.
 * The first mission event lazily attaches such a workspace to a stable project
 * identity, while overview reads reconcile links whose workspace row has since
 * been removed. This keeps the rollout migration-free for users.
 */
export class ProjectMemoryServiceV2 extends ProjectMemoryService {
  constructor(
    private readonly lifecycleDb: AtrisDatabase,
    sqlite: RawSqliteConnection,
  ) {
    super(lifecycleDb, sqlite);
  }

  override async resolveProjectForMission(missionId: string): Promise<ProjectSelect | null> {
    const existing = await super.resolveProjectForMission(missionId);
    if (existing) return existing;

    const mission = (await this.lifecycleDb.select().from(missions).where(eq(missions.id, missionId)))[0];
    if (!mission) return null;
    const workspace = (await this.lifecycleDb.select().from(workspaces).where(eq(workspaces.id, mission.workspaceId)))[0];
    if (!workspace) return null;
    return (await this.attachWorkspace(workspace)).project;
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
