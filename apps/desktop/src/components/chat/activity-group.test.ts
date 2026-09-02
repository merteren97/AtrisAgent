import type { TimelineItem } from '@/stores/mission-store';
import { groupStatus, statusForItem } from './activity-group';

function item(eventType: string, metadata?: Record<string, unknown>): TimelineItem {
  return { id: eventType, type: 'event', eventType, content: eventType, timestamp: 'now', metadata };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`[PASS] ${message}`);
}

assert(statusForItem(item('agent_error')) === 'warning', 'agent_error is diagnostic rather than terminal failure');
assert(groupStatus([item('agent_started'), item('agent_error')]) === 'warning', 'stderr diagnostics produce a diagnostic group status');
assert(statusForItem(item('task_failed')) === 'failure', 'task_failed remains terminal failure');
assert(statusForItem(item('mission_failed')) === 'failure', 'mission_failed remains terminal failure');
assert(statusForItem(item('tool_call_completed', { success: false })) === 'failure', 'explicit false terminal metadata remains failure');
assert(statusForItem(item('task_completed')) === 'success', 'task_completed remains successful terminal status');
