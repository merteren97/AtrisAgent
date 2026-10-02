import assert from 'node:assert/strict';
import type { AttachmentRef } from '@atris-agent-code/domain';
import { buildMissionCommandOptions, buildMissionRequestBody, restoreMissionTimeline, useMissionStore, type Mission, type StartMissionOptions } from './mission-store';
import { ApiRequestTimeoutError } from '@/lib/api-client';

const ref: AttachmentRef = { id: 'file-1', workspaceId: 'workspace-attachments', name: 'reference.png',
  mimeType: 'image/png', byteSize: 68, sha256: 'hash', createdAt: '2026-10-02T12:00:00Z' };
const options: StartMissionOptions = { attachmentIds: [ref.id], attachments: [{ ...ref, providerPath: 'private', dataBase64: 'private' } as AttachmentRef],
  workMode: 'plan', teamLaunch: 'confirm', model: 'catalog-1', orchestratorModel: 'orchestrator-1', reasoningLevel: 'high',
  orchestratorReasoningLevel: 'medium', teamTemplate: 'focused', trustMode: 'Review Driven', targetRole: 'builder',
  routeRole: 'researcher', routeScope: 'role', agentProfileIds: { researcher: ' research-profile ' }, command: '/plan',
  automationSettings: { fileWrite: false, gitCommit: false, packageInstall: null } };
const mission: Mission = { id: 'mission-attachments', workspaceId: ref.workspaceId, title: 'Inspect the attached files.', status: 'running', createdAt: ref.createdAt };
const originalFetch = globalThis.fetch;
const posts: Array<{ url: string; body: Record<string, any> }> = [];
let events: Record<string, any>[] = [];
let failPost = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    posts.push({ url, body });
    if (failPost) return json({ error: 'Provider unavailable' }, 503);
    if (url.endsWith('/missions/start')) return json({ missionId: mission.id, accepted: true, status: 'starting' }, 202);
    return json({ turn: { id: 'turn-attachments', attachments: [{ ...ref, name: 'durable.png', providerPath: 'private' }] } }, 202);
  }
  if (url.includes('/events?')) return json(events);
  if (url.includes('/mission-commands?')) return json({ items: [] });
  return json({ mission, tasks: [] });
};
function assertTransport(body: Record<string, any>) {
  assert.deepEqual(body.attachmentIds, ['file-1']);
  assert.equal(body.workMode, 'plan');
  assert.equal(body.teamLaunch, 'confirm');
  assert.equal(body.modelCatalogId, 'catalog-1');
  assert.equal(body.orchestratorModelCatalogId, 'orchestrator-1');
  assert.equal(body.reasoningLevel, 'high');
  assert.equal(body.orchestratorReasoningLevel, 'medium');
  assert.equal(body.executionMode, 'review_driven');
  assert.equal(body.trustMode, 'Review Driven');
  assert.equal(body.teamTemplate, 'focused');
  assert.equal(body.command, '/plan');
  assert.equal(body.targetRole, 'builder');
  assert.equal(body.routeRole, 'researcher');
  assert.equal(body.routeScope, 'role');
  assert.deepEqual(body.agentProfileIds, { researcher: 'research-profile' });
  assert.deepEqual(body.automationSettings, options.automationSettings);
  assert(!('attachments' in body), 'request transports IDs, never UI refs or bytes/paths');
  assert(!('model' in body), 'commands use backend catalog field names');
}
try {
  useMissionStore.setState({ missions: [], timeline: [], queuedTurns: [], activeTasks: [], activeMissionId: null, error: null, pendingMissionStart: null, deletionTracking: {} });
  await useMissionStore.getState().startMission('  ', ref.workspaceId, options);
  const start = posts[0]?.body;
  assert.equal(start.request, 'Inspect the attached files.', 'attachment-only start has a readable fallback');
  assertTransport(start);
  assert.equal(useMissionStore.getState().error, null);
  await useMissionStore.getState().fetchMissionState(mission.id);
  assert.equal(useMissionStore.getState().timeline.length, 1, 'acceptance before event persistence does not duplicate the legacy fallback message');
  assert.deepEqual(useMissionStore.getState().timeline[0]?.metadata?.attachments, [ref], 'optimistic start retains public refs during pending replay');
  events = [{ id: 'persisted-user', type: 'user_message', missionId: mission.id, clientMessageId: start.clientMessageId,
    content: start.request, attachments: [ref], timestamp: ref.createdAt }];
  await useMissionStore.getState().fetchMissionState(mission.id);
  assert.equal(useMissionStore.getState().timeline.filter((entry) => entry.type === 'user_message').length, 1, 'persisted start replaces correlated optimistic message');
  assert.deepEqual(useMissionStore.getState().timeline[0]?.metadata?.attachments, [ref]);

  // Live SSE delivery also replaces the optimistic message without losing attachment metadata.
  useMissionStore.setState({ timeline: [{ id: 'live-client', type: 'user_message', content: 'Live', timestamp: '12:00',
    metadata: { clientMessageId: 'live-client', attachments: [ref], starting: true } }] });
  useMissionStore.getState().addTimelineItem({ id: 'live-durable', type: 'user_message', content: 'Live', timestamp: '12:01', eventType: 'user_message',
    metadata: { clientMessageId: 'live-client', missionId: mission.id, turnId: 'live-turn' } });
  assert.equal(useMissionStore.getState().timeline.length, 1);
  assert.equal(useMissionStore.getState().timeline[0]?.id, 'live-durable');
  assert.deepEqual(useMissionStore.getState().timeline[0]?.metadata?.attachments, [ref]);

  // Exercise real serialized requests for every durable delivery, including continuation.
  for (const delivery of ['queue', 'steer', 'stop_and_replan'] as const) {
    useMissionStore.setState({ missions: [mission], activeMissionId: mission.id, timeline: [], queuedTurns: [], error: null });
    await useMissionStore.getState().sendMissionCommand(mission.id, '', delivery, options);
    const post = posts[posts.length - 1]!.body;
    assert.equal(post.content, 'Inspect the attached files.');
    assert.equal(post.delivery, delivery);
    assertTransport(post.options);
    const message = useMissionStore.getState().timeline.find((entry) => entry.type === 'user_message')!;
    assert.deepEqual(message.metadata?.attachments, [{ ...ref, name: 'durable.png' }], 'public refs from durable turn response are authoritative');
    assert.equal(message.metadata?.turnId, 'turn-attachments');
  }
  useMissionStore.setState({ missions: [{ ...mission, status: 'completed' }], timeline: [], queuedTurns: [] });
  await useMissionStore.getState().continueMission(mission.id, '', options);
  assertTransport(posts[posts.length - 1]!.body.options);
  assert.equal(posts[posts.length - 1]!.body.content, 'Inspect the attached files.', 'attachment-only continuation is sent');
  await useMissionStore.getState().queueMissionTurn(mission.id, '', options);
  assertTransport(posts[posts.length - 1]!.body.options);

  failPost = true;
  useMissionStore.setState({ missions: [mission], timeline: [], queuedTurns: [], error: null });
  await useMissionStore.getState().queueMissionTurn(mission.id, 'Retry me', options);
  assert.equal(useMissionStore.getState().error, 'Provider unavailable', 'void-returning delivery method preserves its submission error');
  const failed = useMissionStore.getState().timeline.find((entry) => entry.type === 'user_message')!;
  assert.equal(failed.metadata?.failed, true);
  assert.deepEqual(failed.metadata?.attachments, [ref]);
  events = [];
  await useMissionStore.getState().fetchMissionState(mission.id);
  assert.deepEqual(useMissionStore.getState().timeline.find((entry) => entry.metadata?.failed)?.metadata?.attachments, [ref], 'failed optimistic refs survive hydration');
  assert.equal(useMissionStore.getState().error, 'Provider unavailable', 'successful replay does not erase submission failure');
  await useMissionStore.getState().fetchCommandQueue(ref.workspaceId);
  assert.equal(useMissionStore.getState().error, 'Provider unavailable', 'background queue refresh cannot erase a submit error');

  await useMissionStore.getState().startMission('', ref.workspaceId, options);
  assert.equal(useMissionStore.getState().error, 'Provider unavailable');
  assert.deepEqual(useMissionStore.getState().timeline[0]?.metadata?.attachments, [ref]);
  assert.equal(useMissionStore.getState().timeline[0]?.metadata?.failed, true);
  globalThis.fetch = async () => { throw new ApiRequestTimeoutError(30_000); };
  await useMissionStore.getState().startMission('', ref.workspaceId, options);
  assert.match(useMissionStore.getState().error || '', /timed out/);
  assert.equal(useMissionStore.getState().pendingMissionStart?.reason, 'deadline');
  assert.deepEqual(useMissionStore.getState().timeline[0]?.metadata?.attachments, [ref]);

  const restored = restoreMissionTimeline(mission, [{ id: 'reload', type: 'user_message', content: 'Saved', attachments: [ref], attachmentIds: [ref.id], workMode: 'research', teamLaunch: 'confirm' }]);
  assert.deepEqual(restored[0]?.metadata?.attachments, [ref], 'cold reload reads refs from durable events');
  assert.equal(restored[0]?.metadata?.workMode, 'research');
  assert.equal(restored[0]?.metadata?.teamLaunch, 'confirm');
  assert.equal(restoreMissionTimeline(mission, [])[0]?.content, mission.title, 'legacy history remains readable');
  const legacy = JSON.parse(JSON.stringify(buildMissionRequestBody('Legacy text', ref.workspaceId)));
  assert.equal(legacy.request, 'Legacy text');
  assert(!('attachmentIds' in legacy) && !('workMode' in legacy) && !('teamLaunch' in legacy));
  assert.deepEqual(JSON.parse(JSON.stringify(buildMissionCommandOptions({}))), {}, 'legacy queue options remain policy-neutral');
  await useMissionStore.getState().queueMissionTurn(mission.id, 'Invalid IDs', { attachmentIds: ['file-1', 'file-1'] });
  assert.match(useMissionStore.getState().error || '', /unique non-empty IDs/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Mission serialized attachment/mode/replay/failure/legacy tests passed.');
