import assert from 'node:assert/strict';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent, QuestionAsked } from '@atris-agent-code/event-schema';
import { OpenCodeAdapter } from './opencode-adapter';
import { RuntimeHost } from '../runtime-host';
import { RuntimeHostV2 } from '../runtime-host-v2';
import { ClaudeCodeAdapter } from './claude-code-adapter';

const eventBus = new LocalEventBus();
const events: AgentEvent[] = [];
eventBus.on('*', event => { events.push(event); });
const adapter = new OpenCodeAdapter(eventBus);
const internal = adapter as any;
const session = { id: 'agent', agentInstanceId: 'agent', runtimeSessionId: 'provider', endedAt: null };
internal.activeSessions.set('agent', session);
internal.sessionContext.set('agent', { missionId: 'mission', taskId: 'task', attemptId: 'attempt', runtimeSessionId: 'provider', serverKey: 'server' });
internal.servers.set('server', { key: 'server', cwd: 'D:\\project with spaces', url: 'http://provider.local', username: 'opencode', password: 'session-password', process: { exitCode: null, killed: false } });
const emit = (type: string, properties: object) => internal.handleServerEvent('agent', { type, properties });
const asked = { id: 'request', sessionID: 'provider', questions: [{ header: 'Target', question: 'Which target?', options: [{ label: 'Web', description: 'Browser' }], custom: true }] };
emit('question.asked', { ...asked, sessionID: 'other' });
emit('question.asked', { ...asked, sessionID: undefined });
assert.equal(events.length, 0, 'Global stream questions must match the provider session explicitly');
emit('question.asked', asked);
emit('question.asked', asked);
assert.equal(events.length, 1, 'Repeated asks are deduplicated');
const question = events[0] as QuestionAsked;
assert.equal(question.attemptId, 'attempt');
assert.equal(question.requestId, 'request');
assert.equal(question.runtimeSessionId, 'provider');
assert.equal(adapter.isAwaitingUser('agent'), true);
emit('session.idle', { sessionID: 'provider' });
assert.equal(events.some(event => event.type === 'task_completed'), false, 'Question idle must not complete a task');
assert.equal(internal.activeSessions.has('agent'), true);

// Watchdog renews waiting-user attempt leases without treating human think time as stalled output.
let heartbeatCalls = 0;
const host = new RuntimeHost(eventBus, { watchdogInterval: 0, workspaceManager: {
  heartbeatTaskAttempt: async () => { heartbeatCalls++; return true; },
  finishTaskAttempt: async () => true,
  expireStaleTaskAttempts: async () => [],
} as any });
(host as any).adapters.set('opencode', adapter);
(host as any).activeSessions.set('agent', { adapterId: 'opencode', session, missionId: 'mission', taskId: 'task', attemptId: 'attempt', lastProtocolResponseAt: 0, probeFailures: 0 });
internal.probeSessionResponsiveness = async () => { throw new Error('waiting for user should not need a quiet-output probe'); };
await host.runSessionWatchdog(new Date(1_000_000));
assert.equal(heartbeatCalls, 1);
assert.equal(host.isRuntimeQuestionActive(question), true);
assert.equal(host.isRuntimeQuestionActive({ ...question, attemptId: 'old-attempt' }), false);
assert.equal(host.isRuntimeQuestionActive({ ...question, runtimeSessionId: 'old-provider' }), false);

const originalFetch = globalThis.fetch;
let fail = true;
let seen = 0;
globalThis.fetch = async (input, init) => {
  seen++;
  const url = new URL(String(input));
  assert.equal(url.pathname, '/question/request/reply');
  assert.equal(url.searchParams.get('directory'), 'D:\\project with spaces');
  assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from('opencode:session-password').toString('base64')}`);
  assert.deepEqual(JSON.parse(String(init?.body)), { answers: [['Web']] });
  return new Response(JSON.stringify(fail ? { error: 'failure' } : true), { status: fail ? 503 : 200 });
};
try {
  await assert.rejects(host.respondToRuntimeQuestion(question, [['Web']]), /503/);
  assert.equal(adapter.isAwaitingUser('agent'), true, 'Transport failure retains the pending question');
  fail = false;
  await host.respondToRuntimeQuestion(question, [['Web']]);
  assert.equal(seen, 2);
  assert.equal(adapter.isAwaitingUser('agent'), false);
  assert.equal(events.filter(event => event.type === 'question_replied').length, 1);
  emit('question.replied', { sessionID: 'provider', requestID: 'request', answers: [['Web']] });
  assert.equal(events.filter(event => event.type === 'question_replied').length, 1, 'HTTP acceptance and SSE do not duplicate resolution');
  await assert.rejects(host.respondToRuntimeQuestion(question, [['Web']]), /stale/);
} finally { globalThis.fetch = originalFetch; }

emit('question.asked', { ...asked, id: 'second' });
emit('question.rejected', { sessionID: 'other', requestID: 'second' });
assert.equal(adapter.isAwaitingUser('agent'), true);
emit('question.rejected', { sessionID: 'provider', requestID: 'second' });
assert.equal(adapter.isAwaitingUser('agent'), false);
assert.equal(events.at(-1)?.type, 'question_rejected');
emit('question.asked', { ...asked, id: 'third' });
emit('session.error', { sessionID: 'provider', error: { message: 'Provider failed' } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(adapter.isAwaitingUser('agent'), false);
assert.ok(events.some(event => event.type === 'question_rejected' && event.requestId === 'third' && event.outcome === 'cancelled'));
assert.equal(internal.activeSessions.has('agent'), false);
await assert.rejects(new ClaudeCodeAdapter().respondToQuestion('session', 'question', [['answer']]), /does not support/);

// A fast provider cannot ask before the event stream subscription is ready.
{
  const startup = new OpenCodeAdapter();
  const implementation = startup as any;
  let ready: (() => void) | undefined;
  let prompted = false;
  implementation.ensureServer = async () => ({ key: 'startup-server' });
  implementation.startEventStream = async (_session: string, _server: unknown, connected: () => void) => {
    ready = connected;
    await new Promise(() => {});
  };
  implementation.fetchServer = async (_server: unknown, route: string) => {
    if (route === '/session') return new Response(JSON.stringify({ id: 'startup-provider' }));
    prompted = true;
    return new Response(null, { status: 204 });
  };
  const spawning = startup.spawnAgent({ sessionId: 'startup-agent', missionId: 'startup-mission', taskId: 'startup-task', prompt: 'Ask quickly', enableCoordinationMcp: false });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(prompted, false);
  ready!();
  await spawning;
  assert.equal(prompted, true);
  implementation.cleanupSession('startup-agent');
}

// The isolated supervisor bus must forward questions under the real conversation,
// and the host must route the answer back to that isolated adapter/session.
{
  const bus = new LocalEventBus();
  const supervisorAdapter = new OpenCodeAdapter();
  const implementation = supervisorAdapter as any;
  const manager = { resolveRoleExecutionPolicy: async () => undefined, getLatestSupervisorSessionMetadata: async () => undefined, saveSupervisorSessionMetadata: async () => undefined };
  const supervisor: any = new RuntimeHostV2(bus, { workspaceManager: manager as any, watchdogInterval: 0 });
  supervisor.getAccountProfileManager().getProfiles = async () => [{ id: 'profile', provider: 'opencode', runtimeType: 'opencode', authStatus: 'connected', schedulerAuto: true }];
  supervisor.getModelCatalogService().getCachedCatalog = () => [{ catalogId: 'model', runtimeId: 'opencode', accountProfileId: 'profile', runtimeModelId: 'provider/model', supportedRoles: ['orchestrator'], supportedReasoning: [], availability: 'available', source: 'discovered' }];
  supervisor.createIsolatedAdapter = (_runtime: string, privateBus: LocalEventBus) => { supervisorAdapter.setEventBus(privateBus); return supervisorAdapter; };
  implementation.getSessionContinuityCapabilities = () => ({ reuseWhileAlive: false, resumeAfterRestart: false });
  implementation.spawnAgent = async (options: any) => {
    implementation.activeSessions.set(options.sessionId, { id: options.sessionId, agentInstanceId: options.sessionId, runtimeSessionId: 'supervisor-provider' });
    implementation.servers.set('supervisor-server', { key: 'supervisor-server', cwd: 'D:\\supervisor', process: { exitCode: null, killed: false } });
    implementation.sessionContext.set(options.sessionId, { missionId: options.missionId, taskId: options.taskId, attemptId: options.attemptId, runtimeSessionId: 'supervisor-provider', serverKey: 'supervisor-server' });
    implementation.handleServerEvent(options.sessionId, { type: 'question.asked', properties: { ...asked, id: 'supervisor-request', sessionID: 'supervisor-provider' } });
    return implementation.activeSessions.get(options.sessionId);
  };
  implementation.fetchServer = async () => new Response('true');
  implementation.shutdown = async () => undefined;
  const askedInMission = new Promise<QuestionAsked>(resolve => bus.on('question_asked', resolve));
  const acceptedInMission: AgentEvent[] = [];
  bus.on('question_replied', event => { acceptedInMission.push(event); });
  const turn = supervisor.runSupervisorTurn({ missionId: 'conversation', turnId: 'turn-question', prompt: 'Ask target' });
  const supervisorQuestion = await askedInMission;
  assert.equal(supervisorQuestion.missionId, 'conversation');
  assert.equal(supervisorQuestion.turnId, 'turn-question');
  assert.ok(supervisorQuestion.attemptId);
  assert.equal(supervisor.isRuntimeQuestionActive(supervisorQuestion), true);
  implementation.handleServerEvent(supervisorQuestion.agentInstanceId, { type: 'session.idle', properties: { sessionID: 'supervisor-provider' } });
  assert.equal(supervisorAdapter.isAwaitingUser(supervisorQuestion.agentInstanceId), true);
  await supervisor.respondToRuntimeQuestion(supervisorQuestion, [['Web']]);
  assert.equal(acceptedInMission[0].missionId, 'conversation');
  implementation.handleServerEvent(supervisorQuestion.agentInstanceId, { type: 'session.idle', properties: { sessionID: 'supervisor-provider' } });
  assert.equal(await turn, 'OpenCode session completed');
  assert.equal(supervisor.isRuntimeQuestionActive(supervisorQuestion), false);
  await supervisor.stopAll();
}
console.log('OpenCode question session correlation, idle, watchdog, authenticated reply, startup ordering and supervisor round-trip tests passed.');
