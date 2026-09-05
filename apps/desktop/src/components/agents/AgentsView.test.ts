import assert from 'node:assert/strict';
import { emptyAgentProfileDraft, toAgentProfilePayload } from './AgentsView';

const draft = {
  ...emptyAgentProfileDraft('builder'),
  name: 'UI Builder',
  description: 'Focused interface implementation',
  specialty: 'React',
  instructions: 'Keep changes focused.',
  capabilities: 'workspace-write, run-command, workspace-write',
  selectionMode: 'prefer' as const,
  accountProfileId: 'account-safe',
  modelCatalogId: 'model-safe',
  reasoningLevel: 'high' as const,
};

const createPayload = toAgentProfilePayload(draft);
assert.deepEqual(createPayload, {
  role: 'builder',
  name: 'UI Builder',
  description: 'Focused interface implementation',
  specialty: 'React',
  instructions: 'Keep changes focused.',
  capabilities: ['workspace-write', 'run-command'],
  routePolicy: {
    selectionMode: 'prefer',
    accountProfileId: 'account-safe',
    modelCatalogId: 'model-safe',
    reasoningLevel: 'high',
  },
}, 'create payload contains only safe profile fields');

const updatePayload = toAgentProfilePayload({ ...draft, role: 'reviewer' }, false);
assert.equal('role' in updatePayload, false, 'role is immutable in edit payloads');
assert.equal('credentials' in updatePayload, false, 'credential fields are not part of profile payloads');
const defaultRoutePayload = toAgentProfilePayload({ ...emptyAgentProfileDraft('qa'), name: 'QA default' });
assert.equal('routePolicy' in defaultRoutePayload, false, 'legacy/default profiles omit an empty route preference');

console.log('agents view profile payload tests passed');
