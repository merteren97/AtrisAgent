import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@atris-agent-code/database';
import type { AtrisDatabase } from '@atris-agent-code/database';
import { ProjectMemoryService } from '@atris-agent-code/orchestration-core';

async function runTests() {
  let passed = 0;
  let failed = 0;
  const assert = (condition: boolean, message: string) => {
    if (condition) {
      passed += 1;
      console.log(`[PASS] ${message}`);
    } else {
      failed += 1;
      console.error(`[FAIL] ${message}`);
    }
  };

  console.log('--- Project Memory Phase 3 Tests ---');
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      git_initialized INTEGER NOT NULL DEFAULT 0,
      last_opened_at TEXT,
      last_team_template_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      team_template_id TEXT NOT NULL DEFAULT '',
      plan_id TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'balanced',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent_id TEXT,
      assigned_role TEXT,
      required_capabilities TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      worktree_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  const db = drizzle(sqlite, { schema }) as unknown as AtrisDatabase;
  // Match production construction: ProjectMemoryService discovers the underlying
  // better-sqlite3 client from the Drizzle database wrapper itself.
  const service = new ProjectMemoryService(db);
  const now = new Date().toISOString();
  const workspacePath = process.platform === 'win32' ? 'C:\\Projects\\MemoryDemo' : '/tmp/MemoryDemo';

  await db.insert(schema.workspaces).values({
    id: 'workspace-1',
    name: 'Memory Demo',
    path: workspacePath,
    gitInitialized: false,
    lastOpenedAt: now,
    lastTeamTemplateId: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.missions).values({
    id: 'mission-1',
    workspaceId: 'workspace-1',
    title: 'Remember the architecture rules',
    description: 'Remember the architecture rules',
    status: 'completed',
    teamTemplateId: 'default-core-dev-team',
    planId: null,
    executionMode: 'balanced',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await db.insert(schema.tasks).values({
    id: 'task-1',
    missionId: 'mission-1',
    planId: 'plan-1',
    title: 'Research memory architecture',
    description: 'Inspect persistent project memory architecture.',
    status: 'done',
    priority: 'medium',
    assignedAgentId: 'researcher-1',
    assignedRole: 'researcher',
    requiredCapabilities: ['research'],
    dependsOn: [],
    worktreeId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  // Lazy migration: existing workspaces gain a project identity on the first
  // mission memory event without requiring an explicit database migration step.
  await service.ingestEvent({
    id: 'event-user-1',
    type: 'user_message',
    missionId: 'mission-1',
    content: 'The project must remain local-first and never upload source code automatically.',
    timestamp: now,
  });
  const project = await service.resolveProjectForMission('mission-1');
  assert(Boolean(project), 'existing mission lazily attaches to a stable project identity');

  await service.ingestEvent({
    id: 'event-research-1',
    type: 'task_completed',
    missionId: 'mission-1',
    taskId: 'task-1',
    agentInstanceId: 'researcher-1',
    result: 'Project memory uses an immutable evidence ledger plus graph-linked curated nodes.',
    timestamp: now,
  });
  // Replaying the same terminal event must not duplicate the evidence ledger.
  await service.ingestEvent({
    id: 'event-research-1',
    type: 'task_completed',
    missionId: 'mission-1',
    taskId: 'task-1',
    agentInstanceId: 'researcher-1',
    result: 'Project memory uses an immutable evidence ledger plus graph-linked curated nodes.',
    timestamp: now,
  });

  const overview = await service.getOverview(project!.id);
  assert(overview.evidenceCount === 2, 'evidence ledger is idempotent by canonical event id');
  assert((overview.space?.nodeCount || 0) >= 4, 'Memory Curator creates project, requirement, task and research nodes');
  assert((overview.space?.edgeCount || 0) >= 3, 'Memory Curator links curated facts into the project graph');

  const recalled = await service.search({
    projectId: project!.id,
    text: 'local first automatic source upload',
    limit: 5,
  });
  assert(recalled.length > 0, 'FTS/graph retrieval returns relevant long-term project memory');
  assert(recalled.some((hit) => hit.node.type === 'user_constraint'), 'explicit user constraints are preserved as high-value memory');

  // Workspace deletion detaches local state without deleting project memory.
  await service.detachWorkspace('workspace-1');
  const detached = await service.getOverview(project!.id);
  assert(detached.project.status === 'detached', 'removing the local workspace detaches project identity instead of deleting memory');
  assert(detached.evidenceCount === 2, 'detached project keeps its evidence ledger');

  // Re-adding the same path restores the same project identity and all memory.
  await db.insert(schema.workspaces).values({
    id: 'workspace-2',
    name: 'Memory Demo Restored',
    path: workspacePath,
    gitInitialized: false,
    lastOpenedAt: now,
    lastTeamTemplateId: null,
    createdAt: now,
    updatedAt: now,
  });
  const restoredAttachment = await service.attachWorkspace((await db.select().from(schema.workspaces))[1]);
  assert(restoredAttachment.project.id === project!.id, 'same repository/path fingerprint restores the original project identity');
  assert(restoredAttachment.project.status === 'active', 'reattaching a detached project activates it again');

  await service.archiveProject(project!.id);
  const archivedSearch = await service.search({ projectId: project!.id, text: 'local first', limit: 5 });
  assert(archivedSearch.length === 0, 'archived project memory is excluded from normal supervisor recall');

  const restored = await service.restoreProject(project!.id);
  assert(restored.project.status === 'active', 'explicit restore reactivates an archived project with an active attachment');
  const afterRestore = await service.search({ projectId: project!.id, text: 'local first', limit: 5 });
  assert(afterRestore.length > 0, 'restored project memory becomes searchable again');

  const snapshot = await service.getSnapshot(project!.id);
  const root = snapshot.nodes.find((node) => node.type === 'project');
  assert(Boolean(root?.pinned), 'project root is pinned and retained as the graph anchor');

  sqlite.close();
  console.log(`--- Project Memory Phase 3 Tests Complete: ${passed} passed, ${failed} failed ---`);
  if (failed > 0) process.exitCode = 1;
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
