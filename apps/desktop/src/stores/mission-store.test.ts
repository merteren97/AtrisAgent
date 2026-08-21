import assert from 'node:assert/strict';
import type { TimelineItem } from './mission-store';
import { reconcileApprovalTimeline } from './mission-store';

function item(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    id: crypto.randomUUID(),
    type: 'event',
    content: '',
    timestamp: '12:00',
    ...overrides,
  };
}

const request = item({
  id: 'approval-request-event',
  eventType: 'approval_requested',
  content: 'Allow the plan to run.',
  metadata: {
    approvalId: 'approval-1',
    approvalType: 'plan',
    description: 'Allow the plan to run.',
  },
});
const response = item({
  id: 'approval-response-event',
  eventType: 'approval_responded',
  content: 'Approval approved by user.',
  metadata: {
    approvalId: 'approval-1',
    approved: true,
    decidedBy: 'user',
    timestamp: '2026-08-21T12:01:00.000Z',
  },
});

const reconciled = reconcileApprovalTimeline([request, response]);
assert.equal(reconciled.length, 2, 'approval history keeps request and response events');
assert.equal(reconciled[0]?.metadata?.approvalStatus, 'approved', 'request is resolved by matching approval ID');
assert.equal(reconciled[0]?.metadata?.approvalResponseId, 'approval-response-event', 'request links to its response event');
assert.equal(reconciled[1]?.metadata?.approvalStatus, 'approved', 'response remains resolved');
assert.equal(reconciled[1]?.metadata?.approvalType, 'plan', 'response inherits request metadata');

const responseFirst = reconcileApprovalTimeline([response, request]);
assert.equal(responseFirst[1]?.metadata?.approvalStatus, 'approved', 'event order does not affect reconciliation');

console.log('mission approval lifecycle tests passed');
