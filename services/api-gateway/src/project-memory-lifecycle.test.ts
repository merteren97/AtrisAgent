import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@atris-agent-code/database';
import type { AtrisDatabase } from '@atris-agent-code/database';
import { ProjectMemoryService } from '@atris-agent-code/orchestration-core';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[FAIL] ${message}`);
  console.log(`[PASS] ${message}`);
}

async function runTests() {
  console.log('--- Project Memory Phase 4 Lifecycle Tests ---');
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
    CREATE TABLE mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      task_id TEXT,
      agent_instance_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  schema.migrateDatabase(sqlite as any);
  const db = drizzle(sqlite, { schema }) as unknown as AtrisDatabase;
  const memory = new ProjectMemoryService(db);
  const now = new Date().toISOString();
  await db.insert(schema.workspaces).values({
    id: 'workspace-phase4',
    name: 'Phase 4 Memory Project',
    path: process.platform === 'win32' ? 'C:\\Projects\\Phase4Memory' : '/tmp/Phase4Memory',
    gitInitialized: false,
    lastOpenedAt: now,
    lastTeamTemplateId: null,
    createdAt: now,
    updatedAt: now,
  });
  const workspace = (await db.select().from(schema.workspaces))[0];
  const overview = await memory.attachWorkspace(workspace);
  await memory.createManualMemory(overview.project.id, {
    type: 'decision',
    title: 'Keep the memory inspector local-first',
    summary: 'Memory backups and graph exploration stay on the local machine.',
    pinned: true,
  });

  let activeDeleteRejected = false;
  try {
    await memory.deleteProjectMemory(overview.project.id);
  } catch {
    activeDeleteRejected = true;
  }
  assert(activeDeleteRejected, 'permanent memory deletion is rejected while an active workspace is attached');
  assert((await memory.getSnapshot(overview.project.id)).nodes.length >= 2, 'rejected deletion leaves project memory intact');

  await db.insert(schema.workspaces).values({
    ...workspace,
    id: 'workspace-phase4-shared',
    name: 'Shared Phase 4 Memory Project',
  });
  const sharedWorkspace = (await db.select().from(schema.workspaces).where((await import('drizzle-orm')).eq(schema.workspaces.id, 'workspace-phase4-shared')))[0];
  await memory.attachWorkspace(sharedWorkspace);
  await db.insert(schema.memoryNodes).values([
    {
      id: 'workspace-owned-node', projectId: overview.project.id, type: 'lesson', title: 'Owned', summary: 'Owned',
      provenance: [{ sourceType: 'agent_output', missionId: 'mission-owned', createdBy: 'worker' }],
      createdAt: now, updatedAt: now,
    },
    {
      id: 'workspace-shared-node', projectId: overview.project.id, type: 'lesson', title: 'Shared', summary: 'Shared',
      provenance: [
        { sourceType: 'agent_output', missionId: 'mission-owned', createdBy: 'worker' },
        { sourceType: 'agent_output', missionId: 'mission-shared', createdBy: 'worker' },
      ],
      createdAt: now, updatedAt: now,
    },
  ]);
  await (memory as typeof memory & { removeWorkspaceProvenance(workspaceId: string, missionIds: string[]): Promise<void> })
    .removeWorkspaceProvenance(workspace.id, ['mission-owned']);
  const provenanceSnapshot = await memory.getSnapshot(overview.project.id);
  assert(!provenanceSnapshot.nodes.some((node) => node.id === 'workspace-owned-node'), 'opt-in deletion removes nodes attributable only to the deleted workspace');
  const sharedNode = provenanceSnapshot.nodes.find((node) => node.id === 'workspace-shared-node');
  assert(sharedNode?.provenance.length === 1 && sharedNode.provenance[0].missionId === 'mission-shared', 'opt-in deletion preserves shared nodes and provenance from another workspace');
  assert(provenanceSnapshot.activeWorkspaceIds.includes(sharedWorkspace.id), 'opt-in deletion preserves another workspace attachment');
  assert(provenanceSnapshot.nodes.some((node) => node.title === 'Keep the memory inspector local-first'), 'opt-in deletion preserves manual project memory');

  await memory.attachWorkspace(workspace);
  await db.insert(schema.memoryNodes).values({
    id: 'rollback-owned-node', projectId: overview.project.id, type: 'lesson', title: 'Rollback', summary: 'Rollback',
    provenance: [{ sourceType: 'agent_output', missionId: 'mission-rollback', createdBy: 'worker' }],
    createdAt: now, updatedAt: now,
  });
  await db.insert(schema.memoryEvidence).values({
    id: 'rollback-evidence', projectId: overview.project.id, sourceType: 'agent_output', missionId: 'mission-rollback',
    eventType: 'task_completed', content: 'Rollback evidence', contentHash: 'rollback-hash', payload: {}, createdAt: now,
  });
  sqlite.prepare(`
    INSERT INTO memory_nodes_fts(node_id, project_id, title, summary, body, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('rollback-owned-node', overview.project.id, 'Rollback', 'Rollback', '', '[]');
  const countsBeforeRollback = (await memory.getOverview(overview.project.id)).space;
  const originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((sql: string) => {
    if (sql.includes('UPDATE project_memory_spaces')) {
      return { run: () => { throw new Error('injected project-count failure'); } } as any;
    }
    return originalPrepare(sql);
  }) as typeof sqlite.prepare;
  let rollbackRejected = false;
  try {
    await memory.removeWorkspaceProvenance(workspace.id, ['mission-rollback']);
  } catch (error) {
    rollbackRejected = error instanceof Error && error.message === 'injected project-count failure';
  } finally {
    sqlite.prepare = originalPrepare as typeof sqlite.prepare;
  }
  const rollbackSnapshot = await memory.getSnapshot(overview.project.id);
  const rollbackEvidence = await db.select().from(schema.memoryEvidence);
  const rollbackFts = sqlite.prepare('SELECT node_id FROM memory_nodes_fts WHERE node_id = ?').get('rollback-owned-node');
  assert(rollbackRejected, 'workspace provenance removal surfaces an injected mutation failure');
  assert(rollbackSnapshot.nodes.some((node) => node.id === 'rollback-owned-node'), 'workspace provenance removal rolls node deletion back on failure');
  assert(rollbackEvidence.some((item) => item.id === 'rollback-evidence'), 'workspace provenance removal rolls evidence deletion back on failure');
  assert(Boolean(rollbackFts), 'workspace provenance removal rolls FTS deletion back on failure');
  assert(rollbackSnapshot.activeWorkspaceIds.includes(workspace.id), 'workspace provenance removal rolls attachment deletion back on failure');
  assert(rollbackSnapshot.project.status === 'active', 'workspace provenance removal preserves project state on failure');
  assert(rollbackSnapshot.space?.nodeCount === countsBeforeRollback?.nodeCount && rollbackSnapshot.space?.edgeCount === countsBeforeRollback?.edgeCount, 'workspace provenance removal preserves project counts on failure');

  await memory.removeWorkspaceProvenance(workspace.id, ['mission-rollback']);
  const removedSnapshot = await memory.getSnapshot(overview.project.id);
  assert(removedSnapshot.space?.nodeCount === removedSnapshot.nodes.length && removedSnapshot.space?.edgeCount === removedSnapshot.edges.length, 'successful workspace provenance removal refreshes project counts atomically');

  await memory.detachWorkspace(sharedWorkspace.id);
  const detached = await memory.getOverview(overview.project.id);
  assert(detached.project.status === 'detached', 'workspace removal converts memory to a detached backup');
  assert(detached.activeWorkspaceIds.length === 0, 'detached memory has no active workspace attachment');

  await memory.deleteProjectMemory(overview.project.id);
  assert((await memory.listProjects()).length === 0, 'explicit deletion removes detached project memory permanently');

  sqlite.close();
  console.log('--- Project Memory Phase 4 Lifecycle Tests Complete ---');
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
