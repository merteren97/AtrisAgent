import assert from 'node:assert/strict';
import { conversationDeleteActionLabel, conversationDeleteStatusLabel } from './sidebar';

const missionWithoutDeletion = { deletionState: undefined };
assert.equal(conversationDeleteActionLabel(missionWithoutDeletion), 'Delete conversation…', 'normal conversations expose the permanent delete action');
assert.equal(conversationDeleteStatusLabel(missionWithoutDeletion), null, 'normal conversations do not show a deletion status');

const pendingMission = { deletionState: { status: 'pending' as const } };
assert.equal(conversationDeleteActionLabel(pendingMission), 'Check deletion status…', 'pending conversations expose a status check action');
assert.equal(conversationDeleteStatusLabel(pendingMission), 'Deleting…', 'pending conversations announce deletion progress');

const retryableMission = { deletionState: { status: 'retryable' as const } };
assert.equal(conversationDeleteActionLabel(retryableMission), 'Retry conversation deletion…', 'retryable conversations expose recovery from the action menu');
assert.equal(conversationDeleteStatusLabel(retryableMission), 'Delete failed · retry', 'retryable conversations announce a recoverable deletion failure');

console.log('[PASS] sidebar conversation deletion affordance copy');
