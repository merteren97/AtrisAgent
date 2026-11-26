import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import type { ProviderAttachment } from '@atris-agent-code/domain';
import { configureRuntimeControlPlaneBridge } from '../control-plane';
import { CodexAdapter, buildCodexExecArgs, buildCodexTurnInput } from './codex-adapter';
import { ClaudeCodeAdapter, buildClaudeSpawnArgs } from './claude-code-adapter';
import { AntigravityAdapter } from './antigravity-adapter';
import { OpenCodeAdapter } from './opencode-adapter';
import { stageWorkspaceAttachments } from './base-adapter';
import { RuntimeHost } from '../runtime-host';
import { RuntimeHostV2 } from '../runtime-host-v2';

class MockChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 42424;
  exitCode: number | null = null;
  killed = false;
  writtenLines: any[] = [];

  constructor() {
    super();
    let buf = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.writtenLines.push(JSON.parse(line));
        } catch {
          this.writtenLines.push(line);
        }
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    if (this.exitCode === null) {
      this.exitCode = 0;
      queueMicrotask(() => this.emit('close', 0, null));
    }
    return true;
  }

  sendJson(payload: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-phase-b-'));
const imagePath = path.join(tempRoot, 'diagram.png');
const textPath = path.join(tempRoot, 'notes.md');
fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(textPath, '# Architecture Notes\n', 'utf8');

const attachments: ProviderAttachment[] = [
  {
    id: 'att-img',
    workspaceId: 'ws-1',
    name: 'diagram.png',
    mimeType: 'image/png',
    byteSize: 4,
    sha256: 'abc',
    createdAt: new Date().toISOString(),
    providerPath: imagePath,
  },
  {
    id: 'att-doc',
    workspaceId: 'ws-1',
    name: '../../escape/notes.md',
    mimeType: 'text/markdown',
    byteSize: 21,
    sha256: 'def',
    createdAt: new Date().toISOString(),
    providerPath: textPath,
  },
  {
    id: 'att-missing',
    workspaceId: 'ws-1',
    name: 'missing.txt',
    mimeType: 'text/plain',
    byteSize: 10,
    sha256: 'ghi',
    createdAt: new Date().toISOString(),
    providerPath: path.join(tempRoot, 'does-not-exist.txt'),
  },
];

try {
  // 1. Codex app-server JSON-RPC lifecycle: thread/start, turn/start, attachments, turn/steer, approval, turn/resume, fallback
  {
    const bus = new LocalEventBus();
    const events: any[] = [];
    bus.on('*', (event) => { events.push(event); });

    const spawned: Array<{ args: string[]; child: MockChildProcess }> = [];
    const adapter = new CodexAdapter(bus, ((_cmd: string, args: string[]) => {
      const child = new MockChildProcess();
      spawned.push({ args, child });
      if (args[0] === 'app-server') {
        const originalWrite = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: any, ...rest: any[]) => {
          const ok = originalWrite(chunk, ...rest);
          const lines = String(chunk).split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            const msg = JSON.parse(line);
            if (msg.method === 'initialize') {
              child.sendJson({ id: msg.id, result: { serverInfo: { name: 'codex', version: '0.10.0' } } });
            } else if (msg.method === 'thread/start') {
              child.sendJson({ id: msg.id, result: { thread: { id: 'thr-1' } } });
            } else if (msg.method === 'thread/resume') {
              child.sendJson({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
            } else if (msg.method === 'turn/start') {
              child.sendJson({ id: msg.id, result: { turn: { id: 'turn-1' } } });
              child.sendJson({ method: 'turn/started', params: { threadId: 'thr-1', turn: { id: 'turn-1' } } });
            } else if (msg.method === 'turn/steer') {
              child.sendJson({ id: msg.id, result: { ok: true } });
            }
          }
          return ok;
        }) as any;
      }
      return child as unknown as ChildProcess;
    }) as any);

    adapter.probeCapabilities = async () => ({
      structuredEventStreaming: true, sessionResume: true, modelSelection: true,
      reasoningControl: true, toolCallEvents: true, interactiveApproval: true,
      usageInfo: true, cancellation: true, worktreeAwareness: true,
      headlessAuth: true, nativeSubAgent: false,
    });

    assert.deepEqual(adapter.getAdapterCapabilities(), {
      liveSteer: true,
      interactiveApproval: true,
      sessionResume: true,
      reuseWhileAlive: true,
      nativeAttachments: true,
    });
    assert.deepEqual(adapter.getSessionContinuityCapabilities(), {
      reuseWhileAlive: true,
      resumeAfterRestart: true,
    });

    const session = await adapter.spawnAgent({
      sessionId: 'codex-s1',
      missionId: 'm-1',
      taskId: 't-1',
      prompt: 'Inspect the diagram',
      role: 'builder',
      cwd: tempRoot,
      attachments,
      enableCoordinationMcp: false,
      preserveProviderSession: true,
    });

    assert.equal(session.runtimeSessionId, 'thr-1');
    assert.equal(spawned[0].args[0], 'app-server');
    assert.equal(spawned[0].args[1], '--stdio');

    const turnStartRpc = spawned[0].child.writtenLines.find((m) => m.method === 'turn/start');
    assert.ok(turnStartRpc, 'turn/start RPC was sent');
    assert.equal(turnStartRpc.params.input[0].type, 'text');
    assert.ok(turnStartRpc.params.input[0].text.includes('notes.md'));
    assert.deepEqual(turnStartRpc.params.input[1], { type: 'localImage', path: imagePath });

    // Live steer during active turn uses turn/steer
    await adapter.sendInput('codex-s1', { type: 'text', content: 'Also check tests' });
    const steerRpc = spawned[0].child.writtenLines.find((m) => m.method === 'turn/steer');
    assert.ok(steerRpc, 'sendInput during active turn uses turn/steer');
    assert.equal(steerRpc.params.expectedTurnId, 'turn-1');

    // Server-initiated approval request & reply
    spawned[0].child.sendJson({
      id: 'srv-req-7',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test', reason: 'Run unit tests' },
    });
    await new Promise((r) => setTimeout(r, 20));
    const approvalEvent = events.find((e) => e.type === 'approval_requested');
    assert.ok(approvalEvent, 'approval_requested event emitted');
    assert.equal(approvalEvent.approvalId, 'codex-s1:srv-req-7');

    await adapter.respondToApproval(approvalEvent.approvalId, 'approved');
    const approvalReply = spawned[0].child.writtenLines.find((m) => m.id === 'srv-req-7' && m.result);
    assert.deepEqual(approvalReply, { id: 'srv-req-7', result: { decision: 'accept' } });

    // Complete turn while preserving provider session
    spawned[0].child.sendJson({ method: 'item/agentMessage/delta', params: { delta: 'All good.' } });
    spawned[0].child.sendJson({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(events.some((e) => e.type === 'task_completed' && e.result === 'All good.'));
    assert.equal(await adapter.probeProviderSession('thr-1'), true);

    // Next spawnAgent with providerSessionId reuses live app-server
    const session2 = await adapter.spawnAgent({
      sessionId: 'codex-s2',
      missionId: 'm-1',
      taskId: 't-2',
      prompt: 'Follow-up turn',
      role: 'builder',
      cwd: tempRoot,
      providerSessionId: 'thr-1',
      enableCoordinationMcp: false,
    });
    assert.equal(session2.runtimeSessionId, 'thr-1');
    assert.equal(spawned.length, 1, 'reused live app-server process without respawning');

    // sendInput when idle uses turn/start
    spawned[0].child.sendJson({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    await new Promise((r) => setTimeout(r, 20));
    await adapter.releaseProviderSession('thr-1');
    await adapter.shutdown();
    console.log('[PASS] Codex app-server lifecycle (thread/start, turn/start, turn/steer, approval, reuse)');
  }

  // 2. Codex thread/resume on fresh app-server + automatic fallback to codex exec --json with --image
  {
    const bus = new LocalEventBus();
    const spawned: Array<{ args: string[]; child: MockChildProcess }> = [];
    const adapter = new CodexAdapter(bus, ((_cmd: string, args: string[]) => {
      const child = new MockChildProcess();
      spawned.push({ args, child });
      if (args[0] === 'app-server') {
        // Simulate app-server startup failure to trigger automatic exec fallback
        queueMicrotask(() => child.emit('close', 2, null));
      } else if (args[0] === 'exec') {
        queueMicrotask(() => {
          child.sendJson({ type: 'thread.started', thread_id: 'exec-thr-1' });
          child.sendJson({ type: 'turn.completed' });
          child.emit('close', 0, null);
        });
      }
      return child as unknown as ChildProcess;
    }) as any);
    adapter.probeCapabilities = async () => ({
      structuredEventStreaming: true, sessionResume: true, modelSelection: true,
      reasoningControl: true, toolCallEvents: true, interactiveApproval: false,
      usageInfo: true, cancellation: true, worktreeAwareness: true,
      headlessAuth: true, nativeSubAgent: false,
    });

    await adapter.spawnAgent({
      sessionId: 'codex-fallback',
      missionId: 'm-2',
      taskId: 't-2',
      prompt: 'Fallback check',
      role: 'builder',
      cwd: tempRoot,
      attachments,
      enableCoordinationMcp: false,
    });

    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].args[0], 'app-server');
    assert.equal(spawned[1].args[0], 'exec');
    assert.ok(spawned[1].args.includes('--image'), 'codex exec fallback includes --image flag');
    assert.ok(spawned[1].args.includes(imagePath));
    assert.equal(buildCodexTurnInput('hi', attachments).length, 2);
    assert.ok(buildCodexExecArgs({ role: 'builder', attachments }, 'hi').includes('--image'));
    await adapter.shutdown();
    console.log('[PASS] Codex automatic fallback to codex exec --json with --image');
  }

  // 3. ClaudeCodeAdapter --resume, builder tool permissions, and staged attachments
  {
    const claudeWorkspace = path.join(tempRoot, 'claude-ws');
    fs.mkdirSync(claudeWorkspace, { recursive: true });
    const spawned: Array<{ args: string[]; child: MockChildProcess }> = [];
    const adapter = new ClaudeCodeAdapter(new LocalEventBus(), ((_cmd: string, args: string[]) => {
      const child = new MockChildProcess();
      spawned.push({ args, child });
      queueMicrotask(() => {
        child.sendJson({ type: 'system', session_id: 'claude-sess-99' });
        child.sendJson({ type: 'result', session_id: 'claude-sess-99', result: 'done' });
        child.emit('close', 0, null);
      });
      return child as unknown as ChildProcess;
    }) as any);
    adapter.probeCapabilities = async () => ({
      structuredEventStreaming: true, sessionResume: true, modelSelection: true,
      reasoningControl: true, toolCallEvents: true, interactiveApproval: false,
      usageInfo: true, cancellation: true, worktreeAwareness: true,
      headlessAuth: true, nativeSubAgent: true,
    });

    assert.deepEqual(adapter.getAdapterCapabilities(), {
      liveSteer: false,
      interactiveApproval: false,
      sessionResume: true,
      reuseWhileAlive: false,
      nativeAttachments: false,
    });
    assert.deepEqual(adapter.getSessionContinuityCapabilities(), {
      reuseWhileAlive: false,
      resumeAfterRestart: true,
    });

    const session = await adapter.spawnAgent({
      sessionId: 'claude-1',
      missionId: 'm-3',
      taskId: 't-3',
      prompt: 'Build and test',
      role: 'builder',
      cwd: claudeWorkspace,
      providerSessionId: 'claude-prev-1',
      attachments,
      enableCoordinationMcp: false,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.runtimeSessionId, 'claude-sess-99');
    const args = spawned[0].args;
    const resumeIdx = args.indexOf('--resume');
    assert.ok(resumeIdx >= 0 && args[resumeIdx + 1] === 'claude-prev-1', '--resume passes providerSessionId');
    assert.ok(args.includes('--permission-mode') && args[args.indexOf('--permission-mode') + 1] === 'acceptEdits');
    assert.ok(args.includes('--allowedTools') && args.includes('Bash') && args.includes('Edit'), 'builder gets safe Bash/Edit tools');

    const promptArg = args[args.indexOf('-p') + 1];
    assert.ok(promptArg.includes('.atris-attachments/diagram.png'));
    assert.ok(promptArg.includes('.atris-attachments/notes.md'), 'traversal filename sanitized into .atris-attachments/');
    assert.equal(fs.existsSync(path.join(claudeWorkspace, '.atris-attachments')), false, 'ClaudeCodeAdapter cleans up .atris-attachments/ on close');

    const qaArgs = buildClaudeSpawnArgs(
      { role: 'qa', profileCapabilities: ['testing', 'run_command'] },
      'Run tests',
      { reasoningControl: true },
    );
    assert.equal(qaArgs[qaArgs.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(qaArgs.includes('Bash') && !qaArgs.includes('Edit'), 'QA gets Bash without Edit/Write');

    const researcherArgs = buildClaudeSpawnArgs(
      { role: 'researcher' },
      'Read files',
      { reasoningControl: true },
    );
    assert.ok(!researcherArgs.includes('Bash'), 'Researcher does not get Bash');
    console.log('[PASS] ClaudeCodeAdapter --resume, builder/QA tool policy, and staged attachments');
  }

  // 4. Antigravity & OpenCode attachments + RuntimeHost / RuntimeHostV2 forwarding
  {
    const agyWorkspace = path.join(tempRoot, 'agy-ws');
    fs.mkdirSync(agyWorkspace, { recursive: true });
    const staged = stageWorkspaceAttachments(agyWorkspace, attachments);
    assert.equal(staged.staged.length, 2);
    assert.equal(staged.staged[1].relativePath, '.atris-attachments/notes.md');
    staged.cleanup();
    assert.equal(fs.existsSync(path.join(agyWorkspace, '.atris-attachments')), false, 'stageWorkspaceAttachments cleanup removes staged files and empty dir');

    const agyArgsList: string[][] = [];
    const agy = new AntigravityAdapter(
      new LocalEventBus(),
      { getHelpText: async () => '--print --output-format stream-json --sandbox --mode --model', runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } as any,
      (async (_cmd: string, args: string[]) => {
        agyArgsList.push(args);
        assert.ok(fs.existsSync(path.join(agyWorkspace, '.atris-attachments', 'diagram.png')), 'attachment is staged while process runs');
        const child = new MockChildProcess();
        setTimeout(() => {
          child.sendJson({ type: 'result', result: 'ok' });
          child.emit('close', 0, null);
        }, 10);
        return child as unknown as ChildProcess;
      }) as any,
    );
    agy.discoverInstallation = async () => ({ installed: true, path: 'agy', version: '1.1.12' });
    (agy as any).resolveRequestedModelRoute = async () => ({ modelRoute: 'agy-default', args: [] });
    await agy.spawnAgent({
      sessionId: 'agy-1',
      missionId: 'm-4',
      taskId: 't-4',
      prompt: 'Check files',
      role: 'researcher',
      cwd: agyWorkspace,
      attachments,
      enableCoordinationMcp: false,
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(agyArgsList[0][1].includes('.atris-attachments/diagram.png'));
    assert.equal(fs.existsSync(path.join(agyWorkspace, '.atris-attachments')), false, 'AntigravityAdapter cleans up .atris-attachments/ after exit');

    // OpenCode attachments in prompt payload
    const opencodeBodies: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/global/health')) {
        return new Response(JSON.stringify({ version: '1.0.0' }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/session')) {
        return new Response(JSON.stringify({ id: 'oc-sess-1' }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/event')) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: 'oc-sess-1' } })}\n\n`));
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.includes('/prompt_async')) {
        opencodeBodies.push(JSON.parse(String(init?.body || '{}')));
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as any;
    try {
      const oc = new OpenCodeAdapter(new LocalEventBus());
      (oc as any).ensureServer = async () => ({
        key: 'k', profileId: 'default', cwd: tempRoot, url: 'http://127.0.0.1:1',
        username: 'u', password: 'p', process: { killed: false, exitCode: null } as any, diagnostics: '',
      });
      await oc.spawnAgent({
        sessionId: 'oc-1',
        missionId: 'm-4',
        taskId: 't-4',
        prompt: 'Check attachment',
        role: 'builder',
        cwd: tempRoot,
        attachments,
        enableCoordinationMcp: false,
      });
      assert.equal(opencodeBodies.length, 1);
      assert.equal(opencodeBodies[0].parts.length, 3);
      assert.equal(opencodeBodies[0].parts[1].type, 'file');
      assert.equal(opencodeBodies[0].parts[1].url, pathToFileURL(imagePath).href);
    } finally {
      globalThis.fetch = origFetch;
    }

    // RuntimeHost task_created forwarding + RuntimeHostV2 runSupervisorTurn forwarding
    const bus = new LocalEventBus();
    const spawnedCalls: any[] = [];
    const host = new RuntimeHost(bus, { watchdogInterval: 0 });
    host.registerAdapter({
      id: 'codex', name: 'Codex', runtimeType: 'codex',
      setEventBus() {},
      configureProfile() {},
      discoverModels: async () => [],
      getAdapterCapabilities: () => ({ liveSteer: true, interactiveApproval: true, sessionResume: true, reuseWhileAlive: true, nativeAttachments: true }),
      probeCapabilities: async () => ({ structuredEventStreaming: true }),
      spawnAgent: async (opts: any) => {
        spawnedCalls.push(opts);
        return { id: opts.sessionId, agentInstanceId: opts.sessionId, runtimeSessionId: 'r1', startedAt: new Date().toISOString(), endedAt: null };
      },
      shutdown: async () => {},
      cancel: async () => {},
    } as any);
    (host as any).profileManager.getProfiles = async () => [{
      id: 'profile-primary', provider: 'openai', runtimeType: 'codex', profileName: 'Primary', authStatus: 'connected',
      configDir: '', supportedModels: ['gpt-5'], usageScope: null, createdAt: '', updatedAt: '', allowedRoles: ['researcher'], schedulerAuto: true,
    }];
    (host as any).catalogService.getCachedCatalog = () => [{
      catalogId: 'c1', runtimeId: 'codex', accountProfileId: 'profile-primary', providerId: 'openai', runtimeModelId: 'gpt-5',
      displayName: 'GPT-5', supportedRoles: ['researcher'], supportedReasoning: ['medium'], inputModalities: ['text'], availability: 'available', source: 'discovered',
    }];
    await host.handleTaskCreated({
      id: 'evt-att-1',
      type: 'task_created',
      missionId: 'm-att',
      taskId: 't-att',
      title: 'With attachment',
      assignedRole: 'researcher',
      attachments,
      timestamp: new Date().toISOString(),
    } as any);
    assert.equal(spawnedCalls[0]?.attachments?.length, 3, 'RuntimeHost forwards task_created attachments to spawnAgent');
    await host.stopAll();

    const v2 = new RuntimeHostV2(undefined, { watchdogInterval: 0 });
    const v2Spawns: any[] = [];
    (v2 as any).profileManager.getProfiles = async () => [{
      id: 'default', provider: 'openai', runtimeType: 'codex', profileName: 'Primary', authStatus: 'connected',
      configDir: '', supportedModels: ['gpt-5'], usageScope: null, createdAt: '', updatedAt: '', allowedRoles: [], schedulerAuto: true,
    }];
    (v2 as any).catalogService.getCachedCatalog = () => [{
      catalogId: 'c1', runtimeId: 'codex', accountProfileId: 'default', providerId: 'openai', runtimeModelId: 'gpt-5',
      displayName: 'GPT-5', supportedRoles: ['orchestrator', 'builder'], supportedReasoning: ['medium'], inputModalities: ['text'], availability: 'available', source: 'discovered',
    }];
    (v2 as any).getSupervisorPlanningResources = async () => ({
      models: [{ catalogId: 'c1', accountProfileId: 'default', runtimeId: 'codex', runtimeModelId: 'gpt-5', displayName: 'GPT-5', supportedRoles: ['builder'], supportedReasoning: [] }],
      specialists: [],
    });
    (v2 as any).resolveRouteForRole = async () => ({
      adapterId: 'codex',
      model: { catalogId: 'c1', runtimeModelId: 'gpt-5', displayName: 'GPT-5', accountProfileId: 'default', runtimeId: 'codex', providerId: 'openai', supportedRoles: ['orchestrator'], supportedReasoning: [], inputModalities: ['text'], availability: 'available', source: 'discovered' },
    });
    let supBus: LocalEventBus | undefined;
    (v2 as any).createIsolatedAdapter = (_runtimeType: string, eventBus: LocalEventBus) => {
      supBus = eventBus;
      return {
        id: 'codex', name: 'Codex', runtimeType: 'codex',
        setEventBus(b: LocalEventBus) { supBus = b; },
        configureProfile() {},
        getSessionContinuityCapabilities: () => ({ reuseWhileAlive: false, resumeAfterRestart: false }),
        spawnAgent: async (opts: any) => {
          v2Spawns.push(opts);
          queueMicrotask(() => supBus?.emit({
            id: crypto.randomUUID(), type: 'task_completed', missionId: opts.missionId, taskId: opts.taskId,
            agentInstanceId: opts.sessionId, result: 'ok', timestamp: new Date().toISOString(),
          }));
          return { id: opts.sessionId, agentInstanceId: opts.sessionId, runtimeSessionId: 'r2', startedAt: new Date().toISOString(), endedAt: null };
        },
        shutdown: async () => {},
      };
    };
    await v2.runSupervisorTurn({
      missionId: 'm-sup-att',
      turnId: 'turn-att',
      workspacePath: tempRoot,
      prompt: 'Review attachment',
      attachments,
    } as any);
    assert.equal(v2Spawns[0]?.attachments?.length, 3, 'RuntimeHostV2 forwards attachments to supervisor spawnAgent');
    await v2.stopAll();
    console.log('[PASS] Antigravity, OpenCode, RuntimeHost & RuntimeHostV2 attachments');
  }

  // 5. Regression tests for Codex control-plane grants on fallback/reuse and post-startup turn/start errors
  {
    const activeGrants = new Set<string>();
    const issuedIds: string[] = [];
    const revokedIds: string[] = [];
    configureRuntimeControlPlaneBridge({
      endpoint: 'http://127.0.0.1:0/mcp',
      bridgeScriptPath: path.join(tempRoot, 'bridge.js'),
      issueGrant: ({ agentInstanceId }) => {
        issuedIds.push(agentInstanceId);
        activeGrants.add(agentInstanceId);
        return { token: `tok-${issuedIds.length}`, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
      revokeAgent: (agentInstanceId) => {
        revokedIds.push(agentInstanceId);
        activeGrants.delete(agentInstanceId);
      },
    });
    try {
      // 5a. Fallback from app-server startup failure leaves an active (unrevoked) control-plane grant for exec
      const bus = new LocalEventBus();
      const envs: Array<Record<string, string | undefined>> = [];
      const adapter = new CodexAdapter(bus, ((_cmd: string, args: string[], opts: any) => {
        envs.push({ token: opts?.env?.ATRIS_CONTROL_PLANE_TOKEN });
        const child = new MockChildProcess();
        if (args[0] === 'app-server') {
          queueMicrotask(() => child.emit('close', 2, null));
        } else {
          assert.ok(activeGrants.has('fb-grant-1'), 'exec fallback runs with an active, unrevoked control-plane grant');
          queueMicrotask(() => {
            child.sendJson({ type: 'turn.completed' });
            child.emit('close', 0, null);
          });
        }
        return child as unknown as ChildProcess;
      }) as any);
      adapter.probeCapabilities = async () => ({
        structuredEventStreaming: true, sessionResume: true, modelSelection: true,
        reasoningControl: true, toolCallEvents: true, interactiveApproval: false,
        usageInfo: true, cancellation: true, worktreeAwareness: true,
        headlessAuth: true, nativeSubAgent: false,
      });
      await adapter.spawnAgent({
        sessionId: 'fb-grant-1',
        missionId: 'm-5',
        taskId: 't-5',
        prompt: 'Fallback grant check',
        role: 'builder',
        cwd: tempRoot,
        enableCoordinationMcp: true,
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(envs[1]?.token, 'tok-2', 'exec fallback receives fresh unrevoked token');
      assert.equal(activeGrants.size, 0, 'all grants revoked after exec completion');

      // 5b. Post-startup turn/start error does NOT fall back to exec, and reuseAppServerSession does not leak grants
      issuedIds.length = 0;
      revokedIds.length = 0;
      let execSpawned = false;
      const reuseAdapter = new CodexAdapter(bus, ((_cmd: string, args: string[]) => {
        if (args[0] === 'exec') execSpawned = true;
        const child = new MockChildProcess();
        const origWrite = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: any, ...rest: any[]) => {
          const ok = origWrite(chunk, ...rest);
          for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
            const msg = JSON.parse(line);
            if (msg.method === 'initialize') child.sendJson({ id: msg.id, result: {} });
            else if (msg.method === 'thread/start') child.sendJson({ id: msg.id, result: { thread: { id: 'thr-reuse' } } });
            else if (msg.method === 'turn/start') {
              if (msg.params?.input?.[0]?.text?.includes('trigger-429')) {
                child.sendJson({ id: msg.id, error: { code: 429, message: 'HTTP 429 Too Many Requests' } });
              } else {
                child.sendJson({ id: msg.id, result: { turn: { id: 't-ok' } } });
              }
            }
          }
          return ok;
        }) as any;
        return child as unknown as ChildProcess;
      }) as any);
      reuseAdapter.probeCapabilities = adapter.probeCapabilities;

      await assert.rejects(
        reuseAdapter.spawnAgent({
          sessionId: 'turn-err-1',
          missionId: 'm-5b',
          taskId: 't-5b',
          prompt: 'trigger-429',
          role: 'builder',
          cwd: tempRoot,
          enableCoordinationMcp: true,
        }),
        /429/,
      );
      assert.equal(execSpawned, false, 'post-startup turn/start error must not fall back to codex exec');
      assert.equal(activeGrants.size, 0, 'grant revoked after post-startup turn/start error');

      issuedIds.length = 0;
      revokedIds.length = 0;
      await reuseAdapter.spawnAgent({
        sessionId: 'reuse-orig',
        missionId: 'm-5c',
        taskId: 't-5c',
        prompt: 'first turn',
        role: 'builder',
        cwd: tempRoot,
        preserveProviderSession: true,
        enableCoordinationMcp: true,
      });
      // Complete turn 1 so thr-reuse moves to reusableAppServers
      const activeChild = (reuseAdapter as any).appServerBySession.get('reuse-orig').child as MockChildProcess;
      activeChild.sendJson({ method: 'turn/completed', params: { turn: { id: 't-ok', status: 'completed' } } });
      await new Promise((r) => setTimeout(r, 20));
      await reuseAdapter.spawnAgent({
        sessionId: 'reuse-second',
        missionId: 'm-5c',
        taskId: 't-5d',
        prompt: 'second turn',
        role: 'builder',
        cwd: tempRoot,
        providerSessionId: 'thr-reuse',
        enableCoordinationMcp: true,
      });
      assert.deepEqual(issuedIds, ['reuse-orig'], 'reused app-server session does not mint extra grants');
      await reuseAdapter.shutdown();
      assert.deepEqual(revokedIds, ['reuse-orig'], 'shutdown revokes the original spawned grant cleanly');
      assert.equal(activeGrants.size, 0);
      console.log('[PASS] Codex control-plane grant lifecycle (fallback, post-startup error, reuse cleanup)');
    } finally {
      configureRuntimeControlPlaneBridge(undefined);
    }
  }
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore Windows EBUSY */ }
}
