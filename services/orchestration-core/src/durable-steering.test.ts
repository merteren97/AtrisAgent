import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from '@atris-agent-code/database';
import { migrateDatabase, type AtrisDatabase } from '@atris-agent-code/database';
import { LocalEventBus, registerSupervisorTurnRunner } from '@atris-agent-code/event-bus';
import { WorkspaceManager } from '@atris-agent-code/workspace-manager';
import { OrchestratorV2 } from './orchestrator-v2';

async function main() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  migrateDatabase(sqlite as any);
  const db = drizzle(sqlite, { schema }) as unknown as AtrisDatabase;
  const eventBus = new LocalEventBus();
  const manager = new WorkspaceManager(db, eventBus);

  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES ('ws-1', 'WS', '/tmp/ws-1', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO missions (id, workspace_id, title, status, plan_id, created_at, updated_at) VALUES ('m-1', 'ws-1', 'Test', 'running', 'plan-1', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO conversation_turns (id, mission_id, content, delivery, status, created_at) VALUES ('turn-1', 'm-1', 'Initial', 'queue', 'running', ?)`).run(now);
  sqlite.prepare(`INSERT INTO tasks (id, mission_id, plan_id, title, status, assigned_role, required_capabilities, depends_on, created_at, updated_at)
    VALUES ('task-1', 'm-1', 'plan-1', 'Research', 'running', 'researcher', '[]', '[]', ?, ?)`).run(now, now);

  const orch1 = new OrchestratorV2({ workspacePath: '/tmp/ws-1' }, eventBus, db, manager);
  (orch1 as any).setMissionLifecycle('m-1', { turnId: 'turn-1', runId: 'run-1' });
  const steerResult = await orch1.steerActiveTurn({
    missionId: 'm-1',
    targetTurnId: 'turn-1',
    content: 'Focus on security boundaries first',
  });
  assert.equal(steerResult.boundary, 'synthesis');
  orch1.dispose();

  const persistedBeforeRestart = sqlite.prepare('SELECT * FROM turn_directives WHERE id = ?')
    .all(steerResult.directiveId) as Array<Record<string, any>>;
  assert.equal(persistedBeforeRestart.length, 1);
  assert.equal(persistedBeforeRestart[0]!.status, 'pending');
  assert.equal(persistedBeforeRestart[0]!.content, 'Focus on security boundaries first');

  // Simulate process restart with a fresh Orchestrator instance sharing the same SQLite DB.
  let capturedPrompt = '';
  registerSupervisorTurnRunner(async (req) => {
    capturedPrompt = req.prompt;
    return 'Synthesized response honoring security steer.';
  });

  const orch2 = new OrchestratorV2({ workspacePath: '/tmp/ws-1' }, eventBus, db, manager);
  const summary = await (orch2 as any).synthesizePlanResult('m-1', 'plan-1', 'Research done');
  assert.equal(summary, 'Synthesized response honoring security steer.');
  assert.ok(capturedPrompt.includes('Focus on security boundaries first'), 'restarted OrchestratorV2 must include persisted turn_directives in synthesis prompt');

  const persistedAfterRestart = sqlite.prepare('SELECT * FROM turn_directives WHERE id = ?')
    .all(steerResult.directiveId) as Array<Record<string, any>>;
  assert.equal(persistedAfterRestart[0]!.status, 'applied');
  assert.ok(persistedAfterRestart[0]!.applied_at);

  orch2.dispose();
  registerSupervisorTurnRunner(null);
  sqlite.close();
  console.log('[PASS] durable turn_directives survive OrchestratorV2 restart and are marked applied on synthesis');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
