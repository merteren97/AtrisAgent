import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

    const coordination = new CoordinationMCP({ workspacePath: path.join(os.tmpdir(), 'atris-packaged-runtime-data'), workspaceManager });

    const ctx = await coordination.getWorkspaceContext(undefined, 'm-100');
    assert(ctx.workspacePath === path.join(os.tmpdir(), 'atris-registered-workspace'), 'getWorkspaceContext resolves the persisted mission workspace instead of the packaged runtime cwd');
    const taskContext = await coordination.getWorkspaceContext(undefined, 'm-100', 't-100');
    assert(taskContext.workspacePath === '/virtual/worktree/t-100', 'agent task context resolves the mission task worktree when one is registered');

    const claimRes = await coordination.claimTask('t-100', 'builder-agent-1', 'builder');
    assert(claimRes.success === true && claimRes.taskId === 't-100', 'claimTask marks task active');
    assert(tasks[0].assignedAgentId === 'builder-agent-1' && tasks[0].status === 'running', 'claimTask persists assignee and running state');

    await coordination.reportProgress('t-100', 'Compiling TypeScript bundle', 50);

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

  console.log(`\nTest Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
