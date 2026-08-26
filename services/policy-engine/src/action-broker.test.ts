import assert from 'node:assert/strict';
import { ActionBroker } from './action-broker';

const broker = new ActionBroker();

const decision = (request: Parameters<ActionBroker['authorize']>[0]) => broker.authorize(request);

assert.equal(decision({ action: 'fileWrite', profile: 'ask', role: 'builder', boundary: 'isolated', runtimeCapabilities: { worktreeAwareness: true } }).allowed, false);
assert.equal(decision({ action: 'fileWrite', profile: 'review', role: 'builder', boundary: 'isolated', runtimeCapabilities: { worktreeAwareness: true } }).allowed, true);
assert.equal(decision({ action: 'workspaceApply', profile: 'review', role: 'builder', boundary: 'workspace' }).allowed, false);
assert.equal(decision({ action: 'workspaceApply', profile: 'auto', role: 'builder', boundary: 'workspace' }).allowed, true);
assert.equal(decision({ action: 'fileWrite', profile: 'auto', role: 'reviewer', boundary: 'isolated', runtimeCapabilities: { worktreeAwareness: true } }).allowed, false);
assert.equal(decision({ action: 'commandExecution', profile: 'auto', role: 'builder', boundary: 'isolated', command: 'rm -rf /', runtimeCapabilities: { structuredEventStreaming: true } }).allowed, false);
assert.equal(decision({ action: 'commandExecution', profile: 'auto', role: 'builder', boundary: 'isolated', command: 'node --version', runtimeCapabilities: { structuredEventStreaming: true } }).allowed, true);
assert.equal(decision({ action: 'commandExecution', profile: 'auto', role: 'builder', boundary: 'isolated', command: 'node --version', runtimeCapabilities: { structuredEventStreaming: false } }).allowed, false);
assert.equal(decision({ action: 'fileWrite', profile: 'auto', role: 'builder', boundary: 'isolated', requiredCapabilities: ['workspace-write'], runtimeCapabilities: { worktreeAwareness: true } }).allowed, true);
assert.equal(decision({ action: 'fileWrite', profile: 'auto', role: 'builder', boundary: 'isolated', requiredCapabilities: ['workspace-write'], runtimeCapabilities: { worktreeAwareness: false } }).allowed, false);
assert.equal(decision({ action: 'commandExecution', profile: 'review', role: 'qa', boundary: 'isolated', command: 'node --version', runtimeCapabilities: { structuredEventStreaming: true } }).allowed, true);
assert.equal(decision({ action: 'commandExecution', profile: 'review', role: 'qa', boundary: 'control_plane', command: 'node --version', runtimeCapabilities: { structuredEventStreaming: true } }).requiresApproval, true);

try {
  broker.assertAllowed({ action: 'workspaceApply', profile: 'ask', role: 'builder', boundary: 'workspace' });
  assert.fail('approval-required action should throw');
} catch (error) {
  assert.equal((error as { code?: string }).code, 'APPROVAL_REQUIRED');
}

console.log('Action broker tests passed.');
