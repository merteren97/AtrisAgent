import assert from 'node:assert/strict';
import {
  canRetryMission,
  isMissionActive,
  isMissionCancellable,
  isMissionOutcome,
  isMissionQueued,
  missionStage,
  needsMissionAttention,
} from './mission-display';

assert.equal(needsMissionAttention('waiting_for_approval'), true);
assert.equal(needsMissionAttention('failed'), true);
assert.equal(isMissionActive('reviewing'), true);
assert.equal(isMissionQueued('ready'), true);
assert.equal(isMissionOutcome('cancelled'), true);
assert.equal(missionStage('applying'), 'execute');
assert.equal(missionStage('verifying'), 'review');
assert.equal(missionStage('blocked'), 'attention');
assert.equal(isMissionCancellable('completed'), false);
assert.equal(isMissionCancellable('blocked'), true);
assert.equal(canRetryMission('failed', ['done', 'rejected']), true);
assert.equal(canRetryMission('completed', ['rejected']), false);
assert.equal(canRetryMission('failed', ['done']), false);

console.log('mission display policy tests passed');
