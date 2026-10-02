import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import { LocalEventBus } from '@atris-agent-code/event-bus';
import type { AgentEvent, QuestionAsked } from '@atris-agent-code/event-schema';
import { OrchestratorInteractions, OrchestratorQuestionStore, registerOrchestratorInteractions, validateQuestionAnswers } from './orchestrator-interactions';

// Mission terminals belong to runs/turns, even when a stale event arrives later.
for (const type of ['mission_failed', 'mission_completed'] as const) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE missions (id TEXT PRIMARY KEY, status TEXT, active_run_id TEXT);
    INSERT INTO missions VALUES ('mission', 'running', 'new-run');
    CREATE TABLE mission_runs (id TEXT PRIMARY KEY, mission_id TEXT, turn_id TEXT, status TEXT);
    INSERT INTO mission_runs VALUES ('old-run', 'mission', 'old-turn', 'failed'), ('new-run', 'mission', 'new-turn', 'running');
    CREATE TABLE conversation_turns (id TEXT PRIMARY KEY, mission_id TEXT, status TEXT);
    INSERT INTO conversation_turns VALUES ('new-turn', 'mission', 'running');`);
  try {
    const store = new OrchestratorQuestionStore(db);
    const question = (questionId: string, correlation: { runId?: string; turnId?: string }): QuestionAsked => ({
      id: `ask-${questionId}`, type: 'question_asked', missionId: 'mission', taskId: 'supervisor-task', questionId, requestId: questionId,
      agentInstanceId: questionId, runtimeSessionId: questionId, adapterId: 'opencode', questions: [],
      timestamp: '2026-01-02T00:00:00.000Z', ...correlation,
    });
    const terminal = (correlation: { runId?: string; turnId?: string } = {}): AgentEvent => ({
      id: 'terminal', type, missionId: 'mission', timestamp: '2026-01-03T00:00:00.000Z',
      reason: 'ended', failedTaskId: null, summary: 'ended', tasksCompleted: 0, totalTasks: 0, ...correlation,
    });
    store.ingest({ ...question('worker', { runId: 'new-run' }), taskId: 'task', attemptId: 'new-attempt' });
    store.ingest(question('supervisor', { turnId: 'new-turn' }));
    const statuses = () => ['worker', 'supervisor'].map(id => store.get('mission', id)?.status);
    store.ingest(terminal({ runId: 'old-run' }));
    assert.deepEqual(statuses(), ['pending', 'pending'], `${type}: late old run cannot cancel worker or turn-only supervisor`);
    store.ingest(terminal({ turnId: 'old-turn' }));
    assert.deepEqual(statuses(), ['pending', 'pending'], `${type}: old turn cannot cancel replacement run`);
    store.ingest(terminal());
    assert.deepEqual(statuses(), ['pending', 'pending'], `${type}: ID-less terminal is unsafe while mission runs`);
    db.exec("UPDATE missions SET status='failed'");
    store.ingest(terminal());
    assert.deepEqual(statuses(), ['pending', 'pending'], `${type}: terminal status alone cannot override active run ownership`);
    db.exec("UPDATE missions SET active_run_id=NULL");
    store.ingest(terminal());
    assert.deepEqual(statuses(), ['pending', 'pending'], `${type}: durable running run still prevents legacy cancellation`);
    db.exec("UPDATE mission_runs SET status='completed'; UPDATE conversation_turns SET status='queued'");
    store.ingest(terminal());
    assert.deepEqual(statuses(), ['pending', 'pending'], `${type}: queued replacement turn prevents legacy cancellation`);
    db.exec("UPDATE missions SET status='running', active_run_id='new-run'; UPDATE mission_runs SET status='running' WHERE id='new-run'; UPDATE conversation_turns SET status='running'");
    store.ingest(terminal({ runId: 'new-run', turnId: 'old-turn' }));
    assert.deepEqual(statuses(), ['pending', 'pending'], `${type}: conflicting turn and run must not cancel`);
    store.ingest(terminal({ runId: 'new-run' }));
    assert.deepEqual(statuses(), ['cancelled', 'cancelled'], `${type}: matching run cancels worker and durable turn-only supervisor`);
    store.ingest(question('turn-worker', { runId: 'new-run' }));
    store.ingest(question('turn-supervisor', { turnId: 'new-turn' }));
    store.ingest(terminal({ turnId: 'new-turn' }));
    assert.equal(store.get('mission', 'turn-worker')?.status, 'cancelled', `${type}: matching durable turn resolves worker run`);
    assert.equal(store.get('mission', 'turn-supervisor')?.status, 'cancelled', `${type}: matching turn cancels supervisor`);
    store.ingest(question('ambiguous-supervisor', { turnId: 'new-turn' }));
    db.exec("INSERT INTO mission_runs VALUES ('retry-run', 'mission', 'new-turn', 'running')");
    store.ingest(terminal({ runId: 'new-run' }));
    assert.equal(store.get('mission', 'ambiguous-supervisor')?.status, 'pending', `${type}: ambiguous turn mapping must not guess run ownership`);
    db.exec("DELETE FROM mission_runs WHERE id='retry-run'");
    store.ingest({ ...terminal({ runId: 'new-run' }), timestamp: '2026-01-01T00:00:00.000Z' });
    assert.equal(store.get('mission', 'ambiguous-supervisor')?.status, 'cancelled', `${type}: matching ownership works regardless of timestamp order`);
    store.ingest(question('legacy', {}));
    store.ingest(terminal({ runId: 'new-run' }));
    assert.equal(store.get('mission', 'legacy')?.status, 'pending', `${type}: correlated event cannot assume ownership of an uncorrelated question`);
    db.exec("UPDATE missions SET status='completed', active_run_id=NULL; UPDATE mission_runs SET status='completed'; UPDATE conversation_turns SET status='completed'");
    store.ingest(terminal());
    assert.equal(store.get('mission', 'legacy')?.status, 'cancelled', `${type}: safe authoritative terminal mission permits legacy event`);
  } finally { db.close(); }
}

const sqlite = new Database(':memory:');
sqlite.pragma('foreign_keys = ON');
sqlite.exec("CREATE TABLE missions (id TEXT PRIMARY KEY, status TEXT); INSERT INTO missions VALUES ('mission', 'running'), ('other', 'running')");
const eventBus = new LocalEventBus();
let active = true;
let calls = 0;
let fail = false;
let confirm = false;
let release: (() => void) | undefined;
let pause = false;
const runtimeHost = {
  isRuntimeQuestionActive: () => active,
  async respondToRuntimeQuestion(question: QuestionAsked, answers: string[][]) {
    calls++;
    if (pause) await new Promise<void>(resolve => { release = resolve; });
    if (fail) throw new Error('authenticated provider transport failed');
    if (confirm) eventBus.emit({ ...question, id: crypto.randomUUID(), type: 'question_replied', answers });
  },
  async rejectRuntimeQuestion(question: QuestionAsked) {
    calls++;
    eventBus.emit({ ...question, id: crypto.randomUUID(), type: 'question_rejected', outcome: 'rejected', reason: 'User dismissed' });
  },
};
const ask = (id: string): QuestionAsked => ({
  id: `event-${id}`, type: 'question_asked', questionId: `session:${id}`, requestId: id,
  missionId: 'mission', taskId: 'task', attemptId: 'attempt', agentInstanceId: 'session', runtimeSessionId: 'provider-session', adapterId: 'opencode',
  questions: [{ header: 'Target', question: 'Which target?', options: [{ label: 'Web', description: 'Browser' }, { label: 'Desktop', description: 'Native' }], custom: true }],
  timestamp: new Date().toISOString(),
});
let interactions = new OrchestratorInteractions({ sqlite, eventBus, runtimeHost });
eventBus.emit(ask('one'));
assert.equal(interactions.list('mission').questions[0].status, 'pending');
assert.throws(() => validateQuestionAnswers(ask('one'), [['Web', 'Desktop']]), /one answer/);
assert.throws(() => validateQuestionAnswers(ask('one'), [[]]), /non-empty/);
assert.throws(() => validateQuestionAnswers({ ...ask('one'), questions: [{ ...ask('one').questions[0], custom: false }] }, [['Other']]), /listed choices/);
assert.deepEqual(validateQuestionAnswers(ask('one'), [['Custom target']]), [['Custom target']]);

// Concurrent duplicates observe the durable claim and never call the provider twice.
pause = true;
const first = interactions.respond('mission', 'session:one', { answers: [['Web']], clientRequestId: 'client-one' });
const duplicate = await interactions.respond('mission', 'session:one', { answers: [['Web']], clientRequestId: 'client-one' });
assert.equal(duplicate.accepted, true);
assert.equal(duplicate.delivered, false);
assert.equal(duplicate.question.status, 'delivering');
assert.equal(calls, 1);
release!();
const delivered = await first;
assert.equal(delivered.question.status, 'delivered');
assert.equal(delivered.providerAccepted, false, 'transport delivery is not provider acceptance');
pause = false;
await interactions.respond('mission', 'session:one', { answers: [['Web']], clientRequestId: 'client-one' });
assert.equal(calls, 1);
await assert.rejects(interactions.respond('mission', 'session:one', { answers: [['Desktop']], clientRequestId: 'client-one' }), /different response/);
await assert.rejects(interactions.respond('other', 'session:one', { answers: [['Web']], clientRequestId: 'client-one' }), /not found/);
eventBus.emit({ ...ask('one'), id: 'wrong-session', type: 'question_replied', runtimeSessionId: 'old-session', answers: [['Web']] });
assert.equal(interactions.store.get('mission', 'session:one')?.status, 'delivered');
eventBus.emit({ ...ask('one'), id: 'provider-acceptance', type: 'question_replied', answers: [['Web']] });
assert.equal(interactions.store.get('mission', 'session:one')?.status, 'accepted');

eventBus.emit(ask('two'));
fail = true;
const failed = await interactions.respond('mission', 'session:two', { answers: [['Desktop']], clientRequestId: 'client-two' });
assert.equal(failed.accepted, true);
assert.equal(failed.delivered, false);
assert.equal(failed.question.status, 'delivery_failed');
assert.match(failed.question.error!, /authenticated/);
// Reconstruct over the same database: pending/error/resolved requests and keys survive.
interactions.dispose();
interactions = new OrchestratorInteractions({ sqlite, eventBus, runtimeHost });
assert.equal(interactions.store.get('mission', 'session:one')?.status, 'accepted');
assert.deepEqual(interactions.store.get('mission', 'session:two')?.answers, [['Desktop']]);
fail = false;
confirm = true;
const retried = await interactions.respond('mission', 'session:two', { answers: [['Desktop']], clientRequestId: 'client-two' });
assert.equal(retried.question.status, 'accepted', 'SSE acceptance before HTTP return is preserved');
assert.equal(retried.providerAccepted, true);

eventBus.emit(ask('stale'));
active = false;
const beforeStale = calls;
assert.equal(interactions.list('mission').questions.find(q => q.requestId === 'stale')?.status, 'stale');
const stale = await interactions.respond('mission', 'session:stale', { answers: [['Web']], clientRequestId: 'stale-client' });
assert.equal(stale.accepted, false);
assert.equal(calls, beforeStale);
active = true;
eventBus.emit(ask('cancel'));
const cancelled = await interactions.respond('mission', 'session:cancel', { clientRequestId: 'cancel-client' }, 'cancel');
assert.equal(cancelled.question.status, 'rejected');
assert.equal(cancelled.delivered, true, 'Confirmed dismissal is delivered, independently of answer acceptance');

eventBus.emit({ ...ask('attempt-fence'), runId: 'new-run' });
eventBus.emit({ id: 'old-run-task-terminal', type: 'task_failed', missionId: 'mission', taskId: 'task', agentInstanceId: 'session', runId: 'old-run', error: 'old run', timestamp: '2099-01-01T00:00:00.000Z' });
assert.equal(interactions.store.get('mission', 'session:attempt-fence')?.status, 'pending', 'run fence precedes otherwise matching worker identity');
eventBus.emit({ id: 'old-terminal', type: 'task_failed', missionId: 'mission', taskId: 'task', agentInstanceId: 'old-session', error: 'old attempt', timestamp: new Date().toISOString() });
assert.equal(interactions.store.get('mission', 'session:attempt-fence')?.status, 'pending');
eventBus.emit({ id: 'real-terminal', type: 'agent_cancelled', missionId: 'mission', taskId: 'task', agentInstanceId: 'session', timestamp: new Date().toISOString() });
assert.equal(interactions.store.get('mission', 'session:attempt-fence')?.status, 'cancelled');

eventBus.emit(ask('interrupted'));
assert.equal(interactions.store.claim(interactions.store.get('mission', 'session:interrupted')!, 'interrupted-client', 'reply', [['Web']]), true);
interactions.dispose();
interactions = new OrchestratorInteractions({ sqlite, eventBus, runtimeHost });
assert.equal(interactions.store.get('mission', 'session:interrupted')?.status, 'delivery_failed');
assert.match(interactions.store.get('mission', 'session:interrupted')?.error || '', /restarted/);
interactions.dispose();

// Verify exported registration and HTTP validation with an actual local server.
const app = express();
app.use(express.json());
const routes = registerOrchestratorInteractions(app, { sqlite, eventBus, runtimeHost });
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address() as { port: number };
try {
  const root = `http://127.0.0.1:${address.port}/api/missions`;
  assert.equal((await fetch(`${root}/missing/questions`)).status, 404);
  const history = await (await fetch(`${root}/mission/questions`)).json() as { questions: unknown[] };
  assert.ok(history.questions.length >= 6);
  assert.equal((await fetch(`${root}/mission/questions/session%3Ainterrupted/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: [['Web']] }) })).status, 400);
} finally {
  routes.dispose();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  sqlite.close();
}
console.log('Orchestrator question durability, delivery, fencing and HTTP tests passed.');
