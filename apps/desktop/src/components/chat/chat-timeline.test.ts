import assert from 'node:assert/strict';
import type { TimelineItem } from '@/stores/mission-store';
import { prepareTimeline } from './chat-timeline';
import { tailWindow } from '@/lib/timeline-window';

function item(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    id: crypto.randomUUID(),
    type: 'event',
    content: '',
    timestamp: '12:00',
    ...overrides,
  };
}

const liveTimeline = prepareTimeline([
  item({ eventType: 'agent_thought', content: 'First thought', agentRole: 'orchestrator' }),
  item({ eventType: 'task_created', content: 'Task ready', agentRole: 'builder' }),
  item({ eventType: 'agent_thought', content: 'Latest thought', agentRole: 'orchestrator' }),
  item({ type: 'orchestrator_message', eventType: 'text_delta', content: 'Response fragment' }),
], true);

const thinkingEntries = liveTimeline.filter((entry) => entry.kind === 'thinking');
assert.equal(thinkingEntries.length, 1, 'live projection renders one thinking strip');
assert.equal(thinkingEntries[0]?.item.content, 'Latest thought', 'thinking strip replaces older thought text');
assert.equal(
  liveTimeline.some((entry) => entry.kind === 'activity' && entry.items.some((activity) => activity.eventType === 'agent_thought')),
  false,
  'live projection keeps raw thinking events out of the main conversation stream',
);

const projectedWindow = tailWindow(liveTimeline, 2);
assert.equal(projectedWindow.items.length, 2, 'long projections render through a bounded tail window');
assert.equal(projectedWindow.hiddenCount, liveTimeline.length - 2, 'the window reports updates available above');
assert.equal(
  liveTimeline.filter((entry) => entry.kind === 'activity').length,
  1,
  'adjacent low-level events render as one activity group',
);

const historyTimeline = prepareTimeline([
  item({ eventType: 'agent_thought', content: 'Recorded thought', agentRole: 'builder' }),
  item({ eventType: 'agent_error', content: 'Runtime diagnostic', agentRole: 'builder' }),
], false);
assert.equal(
  historyTimeline.some((entry) => entry.kind === 'activity' && entry.items.length === 2),
  true,
  'historical thinking remains available inside the expandable activity group',
);

console.log('chat timeline projection tests passed');
