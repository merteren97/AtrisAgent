import assert from 'node:assert/strict';
import {
  clampRightDockWidth,
  RIGHT_DOCK_DEFAULT_WIDTH,
  RIGHT_DOCK_MAX_WIDTH,
  RIGHT_DOCK_MIN_WIDTH,
  useRightDockStore,
} from './right-dock-store';
import { useBrowserStore } from './browser-store';
import {
  computeActivityCounts,
  isClearableActivityItem,
  reconcileActivitySummary,
  sortActivityItems,
} from './activity-store';
import type { ActivitySummaryItem, ActivitySummaryResponse } from '@/lib/activity-types';

// Reset stores
useRightDockStore.setState({ open: false, activeTab: 'activity', width: RIGHT_DOCK_DEFAULT_WIDTH, expanded: false });
useBrowserStore.setState({ url: null, requestId: 0, expanded: false, width: RIGHT_DOCK_DEFAULT_WIDTH });

assert.equal(useRightDockStore.getState().open, false);
assert.equal(useRightDockStore.getState().activeTab, 'activity');
assert.equal(useRightDockStore.getState().width, 400);

// Width clamping
assert.equal(clampRightDockWidth(100), RIGHT_DOCK_MIN_WIDTH);
assert.equal(clampRightDockWidth(1400), RIGHT_DOCK_MAX_WIDTH);
assert.equal(clampRightDockWidth(Number.NaN), RIGHT_DOCK_DEFAULT_WIDTH);
useRightDockStore.getState().setWidth(520.6);
assert.equal(useRightDockStore.getState().width, 521);

// Activity & Browser toggles
useRightDockStore.getState().toggleActivity();
assert.equal(useRightDockStore.getState().open, true);
assert.equal(useRightDockStore.getState().activeTab, 'activity');

useRightDockStore.getState().toggleBrowser();
assert.equal(useRightDockStore.getState().open, true);
assert.equal(useRightDockStore.getState().activeTab, 'browser');

useRightDockStore.getState().setExpanded(true);
assert.equal(useRightDockStore.getState().expanded, true);

useRightDockStore.getState().toggleBrowser();
assert.equal(useRightDockStore.getState().open, false, 'toggling active browser tab closes dock');
assert.equal(useRightDockStore.getState().expanded, false, 'closing dock resets expanded state');

useRightDockStore.getState().openActivity();
assert.equal(useRightDockStore.getState().open, true);
assert.equal(useRightDockStore.getState().activeTab, 'activity');
useRightDockStore.getState().closeDock();
assert.equal(useRightDockStore.getState().open, false);

// Browser store integration preserves backwards compatibility and syncs RightDock
useBrowserStore.getState().open('javascript:alert(1)');
assert.equal(useBrowserStore.getState().url, null);
assert.equal(useRightDockStore.getState().open, false);

useBrowserStore.getState().open('https://example.com/docs');
assert.equal(useBrowserStore.getState().url, 'https://example.com/docs');
assert.equal(useBrowserStore.getState().requestId, 1);
assert.equal(useRightDockStore.getState().open, true, 'opening browser URL opens RightDock');
assert.equal(useRightDockStore.getState().activeTab, 'browser', 'opening browser URL activates browser tab');

useBrowserStore.getState().setWidth(640);
assert.equal(useRightDockStore.getState().width, 640);
useBrowserStore.getState().setExpanded(true);
assert.equal(useRightDockStore.getState().expanded, true);

useBrowserStore.getState().close();
assert.equal(useBrowserStore.getState().url, null, 'closing page clears browser URL');
assert.equal(useRightDockStore.getState().open, true, 'closing page keeps RightDock open');

// Activity reconciliation & helper tests
const baseManualItem: ActivitySummaryItem = {
  itemKey: 'manual:conv-1',
  mode: 'manual',
  workspaceId: 'ws-1',
  workspaceName: 'AtrisAgent',
  title: 'Fix dock layout',
  state: 'running',
  statusLabel: 'Running',
  runtimeTypes: ['codex'],
  models: ['gpt-5'],
  activeCount: 1,
  totalAgentCount: 1,
  attention: null,
  startedAt: '2026-11-18T10:00:00.000Z',
  completedAt: null,
  updatedAt: '2026-11-18T10:02:00.000Z',
  createdAt: '2026-11-18T10:00:00.000Z',
  durationMs: 120_000,
  pinnedAt: null,
  unreadCompletion: false,
  target: { mode: 'manual', workspaceId: 'ws-1', conversationId: 'conv-1', agentId: 'agent-1' },
  manualAgents: [
    {
      id: 'agent-1',
      name: 'Codex',
      runtimeType: 'codex',
      model: 'gpt-5',
      rawState: 'working',
    },
  ],
};

const staleAttentionItem: ActivitySummaryItem = {
  ...baseManualItem,
  itemKey: 'manual:conv-2',
  state: 'attention',
  attention: {
    kind: 'approval',
    preview: 'Approve rm -rf',
    sinceAt: '2026-11-18T10:01:00.000Z',
    agentId: 'agent-2',
  },
  durationMs: null,
  target: { mode: 'manual', workspaceId: 'ws-1', conversationId: 'conv-2', agentId: 'agent-2' },
  manualAgents: [
    {
      id: 'agent-2',
      name: 'Claude',
      runtimeType: 'claude_code',
      model: 'sonnet',
      rawState: 'attention',
      attentionPreview: 'Approve rm -rf',
    },
  ],
};

const summary: ActivitySummaryResponse = {
  items: [baseManualItem, staleAttentionItem],
  counts: { attention: 1, running: 1, unreadCompleted: 0, total: 2 },
  generatedAt: '2026-11-18T10:05:00.000Z',
};

const reconciled = reconcileActivitySummary(
  summary,
  {
    'agent-1': { lifecycle: 'closed', state: 'unknown' },
    'agent-2': { lifecycle: 'exited', state: 'unknown' },
  },
  true,
);

assert.equal(reconciled.items[0]?.state, 'completed', 'closed terminal with durationMs downgrades working to completed');
assert.equal(reconciled.items[0]?.manualAgents?.[0]?.rawState, 'completed');
assert.equal(reconciled.items[0]?.activeCount, 0);
assert.equal(reconciled.items[1]?.state, 'idle', 'exited terminal without durationMs downgrades attention to idle');
assert.equal(reconciled.items[1]?.attention, null);
assert.deepEqual(reconciled.counts, { attention: 0, running: 0, unreadCompleted: 0, total: 2 });

const keepLive = reconcileActivitySummary(
  summary,
  {
    'agent-1': { lifecycle: 'open', state: 'working' },
    'agent-2': { lifecycle: 'open', state: 'attention' },
  },
  true,
);
assert.equal(keepLive.items[0]?.state, 'running');
assert.equal(keepLive.items[1]?.state, 'attention');
assert.deepEqual(keepLive.counts, { attention: 1, running: 1, unreadCompleted: 0, total: 2 });

const completedPinned: ActivitySummaryItem = {
  ...baseManualItem,
  itemKey: 'manual:pinned',
  state: 'completed',
  pinnedAt: '2026-11-18T10:04:00.000Z',
  unreadCompletion: true,
};
const completedNormal: ActivitySummaryItem = {
  ...baseManualItem,
  itemKey: 'manual:done',
  state: 'completed',
  pinnedAt: null,
  unreadCompletion: true,
};
assert.equal(isClearableActivityItem(completedPinned), false, 'pinned items cannot be cleared');
assert.equal(isClearableActivityItem(completedNormal), true, 'unpinned terminal items can be cleared');
assert.equal(isClearableActivityItem(completedNormal, 'other-ws'), false, 'workspace scope filters clearable items');
assert.equal(isClearableActivityItem(completedNormal, 'ws-1', 'orchestrator'), false, 'mode filter filters clearable items');
assert.deepEqual(
  computeActivityCounts([completedPinned, completedNormal]),
  { attention: 0, running: 0, unreadCompleted: 2, total: 2 },
);
assert.equal(sortActivityItems([completedNormal, completedPinned])[0]?.itemKey, 'manual:pinned');

console.log('[PASS] right-dock-store and activity reconciliation tests');
