import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@atris-agent-code/database';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import { OrchestratorV2 } from '@atris-agent-code/orchestration-core';
import { CoordinationMCP } from './coordination';
import { resolveControlPlaneBridgeScriptPath } from './index';
import { ResourceLeaseManager } from './resource-lease-manager';

async function runTests() {
  console.log('--- Starting Coordination MCP & Resource Lease Tests ---');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const configuredBridgePath = path.join(os.tmpdir(), 'atris-runtime', 'control-plane-bridge.mjs');
  assert(
    resolveControlPlaneBridgeScriptPath({ ATRIS_CONTROL_PLANE_BRIDGE_PATH: configuredBridgePath }) === path.resolve(configuredBridgePath),
    'packaged control-plane bridge path is taken from ATRIS_CONTROL_PLANE_BRIDGE_PATH',
  );
  assert(
    resolveControlPlaneBridgeScriptPath({}, import.meta.url).endsWith(path.join('services', 'coordination-mcp', 'src', 'control-plane-bridge.mjs')),
    'control-plane bridge path falls back to the source resource when no packaged override is set',
  );
  const bridgeSource = fs.readFileSync(path.join(process.cwd(), 'src', 'control-plane-bridge.mjs'), 'utf8');
  assert(bridgeSource.includes("'X-Atris-Runtime-Token'"), 'control-plane bridge forwards the runtime token through an HTTP header');
  assert(!bridgeSource.includes('ATRIS_RUNTIME_TOKEN`'), 'control-plane bridge never appends the runtime token to a URL');
  assert(bridgeSource.includes("hostname !== '127.0.0.1'"), 'control-plane bridge rejects DNS aliases and accepts only the packaged literal loopback origin');

  // Test 1: ResourceLeaseManager Locking & Conflict Prevention
  {
    const leaseManager = new ResourceLeaseManager();
    const resA = await leaseManager.reserveLease('db_migration', 'agent-builder-1', 'main_db', 60);
    assert(typeof resA.leaseId === 'string', 'Agent A successfully reserves db_migration lease');

    let conflictCaught = false;
    try {
      await leaseManager.reserveLease('db_migration', 'agent-builder-2', 'main_db', 60);
    } catch (err: any) {
      conflictCaught = err.message.includes('locked by agent "agent-builder-1"');
    }
    assert(conflictCaught, 'Agent B blocked from locking db_migration while Agent A holds lease');

    const hbRes = await leaseManager.heartbeatLease(resA.leaseId, 120);
    assert(typeof hbRes.expiresAt === 'string', 'Agent A extends lease TTL via heartbeat');
    await leaseManager.releaseLease(resA.leaseId);

    const resB = await leaseManager.reserveLease('db_migration', 'agent-builder-2', 'main_db', 60);
    assert(typeof resB.leaseId === 'string', 'Agent B can reserve db_migration lease after Agent A releases');
  }

  // Test 1b: SQLite is the authority shared by separate manager instances.
  {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE missions (id TEXT PRIMARY KEY);
      CREATE TABLE resource_leases (
        id TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
        held_by_agent_id TEXT NOT NULL, expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
        status TEXT DEFAULT 'active', metadata TEXT
      );
      CREATE UNIQUE INDEX idx_resource_leases_active_resource
        ON resource_leases(resource_type, resource_id) WHERE status = 'active';
      CREATE TABLE agent_instances (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, role TEXT NOT NULL,
        model_profile_id TEXT DEFAULT '', account_profile_id TEXT DEFAULT '', runtime_adapter_id TEXT DEFAULT '',
        session_id TEXT, status TEXT DEFAULT 'idle', task_id TEXT, parent_agent_id TEXT,
        display_name TEXT, specialty TEXT, spawn_reason TEXT, status_message TEXT, progress INTEGER,
        workspace_mode TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, read_at TEXT, kind TEXT NOT NULL DEFAULT 'message', reply_to_message_id TEXT
      );
    `);
    sqlite.prepare('INSERT INTO missions (id) VALUES (?)').run('durable-mission');
    const db = drizzle(sqlite, { schema }) as any;
    const managerA = new ResourceLeaseManager();
    const managerB = new ResourceLeaseManager();
    const sharedLease = await managerA.reserveLease('workspace', 'agent-a', 'main', 60, undefined, db);
    assert(typeof sharedLease.leaseId === 'string', 'SQLite-backed manager persists the lease claim');

    let crossProcessConflict = false;
    try {
      await managerB.reserveLease('workspace', 'agent-b', 'main', 60, undefined, db);
    } catch (error: any) {
      crossProcessConflict = String(error?.message).includes('locked by agent "agent-a"');
    }
    assert(crossProcessConflict, 'a separate manager cannot claim an active SQLite lease');

    const resumed = await managerB.heartbeatLease(sharedLease.leaseId, 120, db);
    assert(resumed.expiresAt > new Date().toISOString(), 'heartbeat resolves the lease from SQLite after a manager restart');

    sqlite.prepare("UPDATE resource_leases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(sharedLease.leaseId);
    const replacement = await managerB.reserveLease('workspace', 'agent-b', 'main', 60, undefined, db);
    assert(replacement.leaseId !== sharedLease.leaseId, 'expired SQLite leases are reclaimed without invalidating live leases');

    const durableBus = new LocalEventBus();
    const firstCoordination = new CoordinationMCP({ db, eventBus: durableBus, workspacePath: os.tmpdir() });
    durableBus.emit({
      id: crypto.randomUUID(), type: 'agent_spawned', missionId: 'durable-mission',
      agentInstanceId: 'durable-agent', parentAgentId: null, role: 'researcher',
      displayName: 'Durable Researcher', specialty: 'Recovery', spawnReason: 'Verify restart state',
      taskId: null, model: 'research-model', workspaceMode: 'read_only', timestamp: new Date().toISOString(),
    } as any);
    await firstCoordination.sendAgentMessage({
      missionId: 'durable-mission', fromAgentId: 'durable-agent', toAgentId: 'durable-agent',
      content: 'Persist this handoff.', kind: 'handoff',
    });
    const restartedCoordination = new CoordinationMCP({ db, workspacePath: os.tmpdir() });
    assert(restartedCoordination.listAgents('durable-mission')[0]?.displayName === 'Durable Researcher', 'agent registry survives a CoordinationMCP restart');
    assert(restartedCoordination.readAgentMessages('durable-agent', true, false)[0]?.kind === 'handoff', 'agent mailbox survives a CoordinationMCP restart');
    sqlite.close();
  }

  // Test 2: CoordinationMCP current task contract + Runtime V2 agent operations
  {
    const tasks: any[] = [{
      id: 't-100',
      missionId: 'm-100',
      title: 'Implement production hardening',
      description: 'Harden the production runtime',
      status: 'ready',
      assignedAgentId: null,
      assignedRole: 'builder',
      worktreeId: '/virtual/worktree/t-100',
      priority: 'high',
      requiredCapabilities: [],
      dependsOn: [],
    }];

    const workspaceManager: any = {
      async getTask(taskId: string) { return tasks.find((task) => task.id === taskId) || null; },
      async updateTask(taskId: string, updates: Record<string, unknown>) {
        const task = tasks.find((item) => item.id === taskId);
        if (!task) throw new Error('Task not found');
        Object.assign(task, updates);
        return task;
      },
      async createTask(input: Record<string, any>) {
        const task = {
          id: input.id || `t-${tasks.length + 100}`,
          missionId: input.missionId,
          title: input.title,
          description: input.description || '',
          status: input.status || 'planned',
          assignedAgentId: input.assignedAgentId || null,
          assignedRole: input.assignedRole || null,
          worktreeId: input.worktreeId || null,
          priority: input.priority || 'medium',
          requiredCapabilities: input.requiredCapabilities || [],
          dependsOn: input.dependsOn || [],
        };
        tasks.push(task);
        return task;
      },
      async listTasks(missionId: string) { return tasks.filter((task) => task.missionId === missionId); },
      async reserveAgentCapacity() {},
      async getMission(missionId: string) {
        return missionId === 'm-100'
          ? { id: missionId, workspaceId: 'w-100', title: 'Production hardening', status: 'running', executionMode: 'balanced' }
          : null;
      },
      async getWorkspace(workspaceId: string) {
        return workspaceId === 'w-100'
          ? { id: workspaceId, path: path.join(os.tmpdir(), 'atris-registered-workspace') }
          : null;
      },
      getWorktreeManager() {
        return {
          async getChangedFiles(worktreePath: string) {
            return worktreePath === '/virtual/worktree/t-100'
              ? [
                  { path: 'src/index.ts', status: 'modified' },
                  { path: 'src/recovery.ts', status: 'added' },
                ]
              : [];
          },
        };
      },
    };

    const eventBus = new LocalEventBus();
    const terminalEvents: any[] = [];
    eventBus.on('task_completed', (event) => { terminalEvents.push(event); });
    eventBus.on('task_failed', (event) => { terminalEvents.push(event); });
    const coordination = new CoordinationMCP({ workspacePath: path.join(os.tmpdir(), 'atris-packaged-runtime-data'), workspaceManager, eventBus });

    const ctx = await coordination.getWorkspaceContext(undefined, 'm-100');
    assert(ctx.workspacePath === path.join(os.tmpdir(), 'atris-registered-workspace'), 'getWorkspaceContext resolves the persisted mission workspace instead of the packaged runtime cwd');
    const taskContext = await coordination.getWorkspaceContext(undefined, 'm-100', 't-100');
    assert(taskContext.workspacePath === '/virtual/worktree/t-100', 'agent task context resolves the mission task worktree when one is registered');

    const claimRes = await coordination.claimTask('t-100', 'builder-agent-1', 'builder');
    assert(claimRes.success === true && claimRes.taskId === 't-100', 'claimTask marks task active');
    assert(tasks[0].assignedAgentId === 'builder-agent-1' && tasks[0].status === 'running', 'claimTask persists assignee and running state');

    await coordination.reportProgress('t-100', 'Compiling TypeScript bundle', 50);

    await coordination.submitResult('t-100', 'Implementation complete');
    assert(tasks[0].status === 'running', 'submitResult leaves successful terminal-state persistence to the orchestrator');
    assert(terminalEvents[0]?.type === 'task_completed' && terminalEvents[0]?.result === 'Implementation complete', 'submitResult publishes the successful result for orchestration');

    await coordination.submitResult('t-100', 'Build failed', undefined, undefined, 'failed');
    assert(tasks[0].status === 'running', 'submitResult leaves failed terminal-state persistence to the orchestrator');
    assert(terminalEvents[1]?.type === 'task_failed' && terminalEvents[1]?.error === 'Build failed', 'submitResult publishes failed results without pre-rejecting the task');

    const changed = await coordination.getChangedFiles('t-100');
    assert(changed.worktreePath === '/virtual/worktree/t-100', 'getChangedFiles stays scoped to the task worktree');
    assert(changed.files.length === 2 && changed.files[1].path === 'src/recovery.ts', 'getChangedFiles returns WorktreeManager results');

    const spawned = await coordination.spawnAgent({
      missionId: 'm-100',
      parentAgentId: 'builder-agent-1',
      role: 'researcher',
      instruction: 'Inspect authentication boundaries and summarize relevant files.',
      displayName: 'Auth Scout',
      specialty: 'Authentication research',
      spawnReason: 'The builder needs isolated read-only evidence before changing auth code.',
      workspaceMode: 'read_only',
    });
    assert(spawned.status === 'scheduled' && Boolean(spawned.agentInstanceId), 'spawnAgent creates a scheduled durable child agent');
    assert(coordination.listAgents('m-100').some((agent) => agent.id === spawned.agentInstanceId && agent.parentAgentId === 'builder-agent-1'), 'spawnAgent preserves parent/child lineage');

    const message = await coordination.sendAgentMessage({
      missionId: 'm-100',
      fromAgentId: 'builder-agent-1',
      toAgentId: spawned.agentInstanceId,
      content: 'Focus on session refresh and middleware ownership.',
      kind: 'handoff',
    });
    assert(message.kind === 'handoff', 'sendAgentMessage preserves message kind');
    const unread = coordination.readAgentMessages(spawned.agentInstanceId, true, false);
    assert(unread.length === 1 && unread[0].content.includes('session refresh'), 'agent mailbox exposes unread provider-independent messages');
    const read = coordination.readAgentMessages(spawned.agentInstanceId, true, true);
    assert(Boolean(read[0].readAt), 'agent mailbox can mark messages read');
    assert(coordination.readAgentMessages(spawned.agentInstanceId, true, false).length === 0, 'read messages no longer appear in unread mailbox');

    const apprId = await coordination.requestApproval('m-100', 'command_execution', 'Execute database migration script');
    assert(typeof apprId === 'string' && apprId.length > 20, 'requestApproval generates a durable-compatible unique ID');

    const artRes = await coordination.publishArtifact('m-100', 'review_pack.json', 'review_pack', '{"summary":"ok"}');
    assert(typeof artRes.artifactId === 'string' && artRes.artifactId.length > 20, 'publishArtifact generates a unique artifact ID');

    const rules = await coordination.getWorkspaceRules();
    assert(Array.isArray(rules.commandPrefixAllowlist), 'getWorkspaceRules returns command allowlist');
    assert((rules.agentLimits as any)?.maxDepth === 2, 'getWorkspaceRules exposes sub-agent safety limits');
  }

  // task_submit_result publishes the transition intent; V2 owns the terminal
  // write so its completion handler can release DAG dependents exactly once.
  {
    const now = new Date().toISOString();
    const mission: any = {
      id: 'mission-submit-result', workspaceId: 'workspace-submit-result', planId: 'plan-submit-result',
      title: 'Submit result', description: '', status: 'running', executionMode: 'balanced',
      teamTemplateId: null, automationPolicy: null, activeRunId: null, createdAt: now, updatedAt: now, completedAt: null,
    };
    const tasks = new Map<string, any>([
      ['research', {
        id: 'research', missionId: mission.id, planId: mission.planId, title: 'Research', description: '', status: 'running',
        priority: 'medium', assignedAgentId: 'agent-research', assignedRole: 'researcher', requiredCapabilities: [],
        dependsOn: [], worktreeId: null, createdAt: now, updatedAt: now, completedAt: null,
      }],
      ['builder', {
        id: 'builder', missionId: mission.id, planId: mission.planId, title: 'Build', description: '', status: 'planned',
        priority: 'medium', assignedAgentId: null, assignedRole: 'builder', requiredCapabilities: [],
        dependsOn: ['research'], worktreeId: null, createdAt: now, updatedAt: now, completedAt: null,
      }],
    ]);
    const manager: any = {
      async getMission(id: string) { return id === mission.id ? mission : null; },
      async updateMission(_id: string, updates: Record<string, unknown>) { Object.assign(mission, updates); return mission; },
      async getTask(id: string) { return tasks.get(id) || null; },
      async listTasks(id: string) { return [...tasks.values()].filter((task) => task.missionId === id); },
      async updateTask(id: string, updates: Record<string, unknown>) {
        const current = tasks.get(id);
        if (!current) throw new Error('Task not found');
        Object.assign(current, updates);
        return current;
      },
    };
    const eventBus = new LocalEventBus();
    const completions: any[] = [];
    const spawnedTaskIds: string[] = [];
    eventBus.on('task_completed', (event) => { completions.push(event); });
    eventBus.on('task_created', (event) => { spawnedTaskIds.push(event.taskId); });
    const coordination = new CoordinationMCP({ workspacePath: 'test', workspaceManager: manager, eventBus });
    const orchestrator = new OrchestratorV2({ workspacePath: 'test', workspaceManager: manager }, eventBus, undefined, manager);

    await coordination.submitResult('research', 'Research complete');
    assert(tasks.get('research').status === 'running', 'Researcher submitResult does not pre-mark the task done');
    await orchestrator.handleTaskCompleted(completions[0]);
    await orchestrator.handleTaskCompleted({ ...completions[0], id: crypto.randomUUID() });

    assert(tasks.get('research').status === 'done' && tasks.get('builder').status === 'running',
      'Researcher submitResult completion releases the dependent Builder');
    assert(spawnedTaskIds.filter((id) => id === 'builder').length === 1,
      'Duplicate completion is fenced and dispatches the Builder exactly once');
  }

  console.log(`\nTest Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
