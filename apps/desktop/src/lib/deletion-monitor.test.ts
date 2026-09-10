import assert from 'node:assert/strict';
import { startConversationDeletionMonitor } from './deletion-monitor';
import { useMissionStore, type Mission } from '@/stores/mission-store';
import { apiRequest, ApiRequestTimeoutError } from './api-client';

const originalFetch = globalThis.fetch;
const mission: Mission = { id: 'delete-background', workspaceId: 'workspace', title: 'Disposable test', status: 'cancelled', createdAt: '2026-09-06', deletionState: { status: 'pending', operationId: 'delete-op' } };
const requests: string[] = [];
let checks = 0;
globalThis.fetch = async (input, init) => {
  requests.push(`${init?.method} ${input}`);
  checks += 1;
  return new Response(JSON.stringify({ status: checks === 1 ? 'running' : 'completed', operationId: 'delete-op' }), {
    status: checks === 1 ? 202 : 200, headers: { 'content-type': 'application/json' },
  });
};
useMissionStore.setState({ missions: [mission], activeMissionId: mission.id });
const dispose = startConversationDeletionMonitor(5);
try {
  const deadline = Date.now() + 2_000;
  while (useMissionStore.getState().missions.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(useMissionStore.getState().missions.length, 0, 'background cleanup removes the conversation without an open dialog');
  assert.equal(checks, 2, 'polling follows pending status through completion');
  assert(requests.every((request) => request.startsWith('GET ') && request.endsWith('/deletion')), 'background monitor only reads status');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checks, 2, 'completed operations stop polling');
} finally { dispose(); }

checks = 0;
globalThis.fetch = async () => {
  checks += 1;
  return new Response(JSON.stringify({ status: 'retryable', error: 'Cleanup paused' }), { status: 503, headers: { 'content-type': 'application/json' } });
};
useMissionStore.setState({ missions: [mission], deletionTracking: {} });
const disposeRetry = startConversationDeletionMonitor(5);
try {
  const deadline = Date.now() + 2_000;
  while (!checks && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checks, 1, 'a retryable failure stops automatic polling and never retries deletion');
  assert.equal(useMissionStore.getState().missions[0]?.deletionState?.status, 'retryable');
} finally { disposeRetry(); globalThis.fetch = originalFetch; }

checks = 0;
globalThis.fetch = async (input, init) => {
  checks += 1;
  assert.equal(init?.method, 'GET', 'hidden deletion tracking is reconciled read-only');
  assert(String(input).endsWith('/missions/hidden-delete/deletion'), 'hidden deletion tracking keeps polling by mission ID');
  return new Response(JSON.stringify({ status: 'completed', operationId: 'hidden-op' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
useMissionStore.setState({ missions: [], activeMissionId: null, deletionTracking: {
  'hidden-delete': { workspaceId: 'workspace', result: { status: 'pending', operationId: 'hidden-op' }, updatedAt: Date.now() },
} });
const disposeHidden = startConversationDeletionMonitor(5);
try {
  const deadline = Date.now() + 2_000;
  while (useMissionStore.getState().deletionTracking['hidden-delete']?.result.status === 'pending' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(useMissionStore.getState().deletionTracking['hidden-delete']?.result.status, 'completed', 'hidden deletion completion is retained after a workspace list switch');
  assert.equal(checks, 1, 'hidden deletion is reconciled without requiring a visible mission row');
} finally { disposeHidden(); globalThis.fetch = originalFetch; }
// One stalled status read must not hold up another completed conversation.
let releaseSlow!: () => void;
const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
globalThis.fetch = async (input) => {
  if (String(input).includes('/slow/')) await slow;
  return new Response(JSON.stringify({ status: 'completed' }), { headers: { 'content-type': 'application/json' } });
};
useMissionStore.setState({ missions: [{ ...mission, id: 'slow' }, { ...mission, id: 'fast' }], deletionTracking: {} });
const disposeParallel = startConversationDeletionMonitor(5);
try {
  const deadline = Date.now() + 1_000;
  while (useMissionStore.getState().missions.some((item) => item.id === 'fast') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(useMissionStore.getState().missions.map((item) => item.id), ['slow'], 'completed deletion is observed while another status request is blocked');
} finally { disposeParallel(); releaseSlow(); globalThis.fetch = originalFetch; }

globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
  start(controller) {
    init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
  },
}), { headers: { 'content-type': 'application/json' } });
try {
  await assert.rejects(apiRequest('/missions/body-timeout/deletion', { timeoutMs: 20 }), ApiRequestTimeoutError,
    'request deadline covers a stalled JSON body after response headers arrive');
} finally { globalThis.fetch = originalFetch; }
console.log('background conversation deletion tests passed');
