import assert from 'node:assert/strict';
import {
  formatDurationCompact,
  formatLiveClock,
  navigateToActivityTarget,
} from './activity-navigation';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useManualStore, type ManualConversation } from '@/stores/manual-store';
import { useMissionStore } from '@/stores/mission-store';
import { useAgentStore } from '@/stores/agent-store';
import { usePlanningStore } from '@/stores/planning-store';
import { planningChatKey, usePlanningChatStore } from '@/stores/planning-chat-store';
import { useSettingsStore } from '@/stores/settings-store';

if (typeof globalThis.window === 'undefined') {
  (globalThis as unknown as { window: { setTimeout: typeof setTimeout } }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };
}

// Duration & clock formatting
assert.equal(formatDurationCompact(null), '—');
assert.equal(formatDurationCompact(undefined), '—');
assert.equal(formatDurationCompact(-100), '—');
assert.equal(formatDurationCompact(42_000), '42s');
assert.equal(formatDurationCompact(60_000), '1m');
assert.equal(formatDurationCompact(252_000), '4m 12s');
assert.equal(formatDurationCompact(3_600_000), '1h');
assert.equal(formatDurationCompact(5_400_000), '1h 30m');

const baseMs = Date.parse('2026-11-18T12:00:00.000Z');
assert.equal(formatLiveClock(null, baseMs), '00:00');
assert.equal(formatLiveClock('invalid-date', baseMs), '00:00');
assert.equal(formatLiveClock('2026-11-18T12:05:00.000Z', baseMs), '00:00', 'future timestamp clamps to 00:00');
assert.equal(formatLiveClock('2026-11-18T11:56:18.000Z', baseMs), '03:42');
assert.equal(formatLiveClock('2026-11-18T10:54:51.000Z', baseMs), '1:05:09');

// Deep-linking: Orchestrator
useWorkspaceStore.setState({
  workspaces: [
    { id: 'ws-a', name: 'Alpha', path: '/tmp/a', createdAt: '2026-11-18T00:00:00Z' } as any,
    { id: 'ws-b', name: 'Beta', path: '/tmp/b', createdAt: '2026-11-18T00:00:00Z' } as any,
  ],
  activeWorkspaceId: 'ws-a',
  lastMissionByWorkspace: { 'ws-b': 'mission-old' },
});
useSettingsStore.setState({ activeView: 'dashboard' });
useManualStore.setState({ mode: 'manual', creating: true });
usePlanningStore.setState({ creating: true });
useMissionStore.setState({ activeMissionId: null });
useAgentStore.setState({ selectedAgentId: null });

await navigateToActivityTarget({
  mode: 'orchestrator',
  workspaceId: 'ws-b',
  missionId: 'mission-target',
  agentId: 'agent-worker-1',
});

assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'ws-b');
assert.equal(useWorkspaceStore.getState().lastMissionByWorkspace['ws-b'], 'mission-target');
assert.equal(useManualStore.getState().mode, 'orchestrator');
assert.equal(useManualStore.getState().creating, false);
assert.equal(usePlanningStore.getState().creating, false);
assert.equal(useMissionStore.getState().activeMissionId, 'mission-target');
assert.equal(useSettingsStore.getState().activeView, 'chat');

await new Promise((resolve) => setTimeout(resolve, 160));
assert.equal(useAgentStore.getState().selectedAgentId, 'agent-worker-1');

// Deep-linking: Manual (already hydrated)
const manualConversation: ManualConversation = {
  id: 'conv-1',
  workspaceId: 'ws-a',
  title: 'Manual Session',
  createdAt: '2026-11-18T10:00:00Z',
  agents: [
    {
      id: 'manual-agent-1',
      conversationId: 'conv-1',
      name: 'Codex',
      catalogId: 'codex:gpt-5',
      runtimeType: 'codex',
      model: 'gpt-5',
      accountProfileId: 'prof-1',
      providerSessionId: 'prov-1',
      cwd: '/tmp/a',
      createdAt: '2026-11-18T10:00:00Z',
    },
  ],
};
useManualStore.setState({
  conversations: { 'ws-a': [manualConversation] },
  hiddenAgents: { 'manual-agent-1': true },
});
useSettingsStore.setState({ activeView: 'settings' });

await navigateToActivityTarget({
  mode: 'manual',
  workspaceId: 'ws-a',
  conversationId: 'conv-1',
  agentId: 'manual-agent-1',
});

assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'ws-a');
assert.equal(useManualStore.getState().mode, 'manual');
assert.equal(useManualStore.getState().activeByWorkspace['ws-a'], 'conv-1');
assert.equal(useManualStore.getState().agentByConversation['conv-1'], 'manual-agent-1');
assert.equal(useManualStore.getState().hiddenAgents['manual-agent-1'], false);
assert.equal(useSettingsStore.getState().activeView, 'chat');

// Deep-linking: Planning
usePlanningStore.setState({
  plans: {
    'ws-b': [
      {
        id: 'plan-9',
        workspaceId: 'ws-b',
        title: 'Dock architecture',
        status: 'draft',
        createdAt: '2026-11-18T00:00:00Z',
        updatedAt: '2026-11-18T01:00:00Z',
        pinned: false,
        archivedAt: null,
      },
    ],
  },
  chatHidden: { 'ws-b': true },
});
useSettingsStore.setState({ activeView: 'agents' });

await navigateToActivityTarget({
  mode: 'planning',
  workspaceId: 'ws-b',
  planId: 'plan-9',
  conversationId: 'plan-chat-2',
});

assert.equal(useWorkspaceStore.getState().activeWorkspaceId, 'ws-b');
assert.equal(useManualStore.getState().mode, 'planning');
assert.equal(usePlanningStore.getState().activeByWorkspace['ws-b'], 'plan-9');
assert.equal(usePlanningStore.getState().chatHidden['ws-b'], false);
assert.equal(usePlanningChatStore.getState().activeByPlan[planningChatKey('ws-b', 'plan-9')], 'plan-chat-2');
assert.equal(useSettingsStore.getState().activeView, 'chat');

console.log('[PASS] activity-navigation formatting and deep-link tests');
