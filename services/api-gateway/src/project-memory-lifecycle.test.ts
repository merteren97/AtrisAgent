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

  await memory.detachWorkspace(workspace.id);
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
