import assert from 'node:assert/strict';
import { normalizeAgentProfileSelections, useSettingsStore } from './settings-store';

assert.deepEqual(
  normalizeAgentProfileSelections({ orchestrator: ' orch-profile ', builder: 'builder-profile', admin: 'ignored', qa: '' }),
  { orchestrator: 'orch-profile', builder: 'builder-profile' },
  'persisted profile selections are limited to fixed roles',
);

useSettingsStore.setState({ agentProfileIds: {} });
useSettingsStore.getState().setAgentProfileId('reviewer', ' reviewer-profile ');
assert.deepEqual(useSettingsStore.getState().agentProfileIds, { reviewer: 'reviewer-profile' }, 'profile selection is trimmed and persisted in settings state');
useSettingsStore.getState().setAgentProfileId('reviewer', null);
assert.deepEqual(useSettingsStore.getState().agentProfileIds, {}, 'clearing a profile restores the runtime default');

console.log('settings agent profile tests passed');
