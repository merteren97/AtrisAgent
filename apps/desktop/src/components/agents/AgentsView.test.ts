import assert from 'node:assert/strict';
import { emptyAgentProfileDraft, toAgentProfilePayload, validateAgentProfileDraft } from './AgentsView';
import type { AccountProfile } from '@atris-agent-code/domain';
import type { DiscoveredModel } from '@/stores/account-store';

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

const clearedPayload = JSON.parse(JSON.stringify(toAgentProfilePayload({ ...emptyAgentProfileDraft(), name: 'Research' }, false, {
  selectionMode: 'fixed', accountProfileId: 'old-account', modelCatalogId: 'old-model', reasoningLevel: 'high',
  fallbackCatalogIds: ['fallback-model'], allowedCatalogIds: [], allowedAccountProfileIds: ['safe-account'],
})));
assert.deepEqual(clearedPayload.routePolicy, { selectionMode: 'auto', fallbackCatalogIds: ['fallback-model'], allowedCatalogIds: [], allowedAccountProfileIds: ['safe-account'] }, 'editing clears explicit preferences while preserving fallback routes and restrictive allowlists');
assert.equal(clearedPayload.description, '', 'description can be cleared on edit');
assert.equal(clearedPayload.specialty, '', 'specialty can be cleared on edit');

const account = { id: 'account-safe', allowedRoles: ['builder'] } as AccountProfile;
const model = { catalogId: 'model-safe', accountProfileId: 'account-safe', suitableRoles: ['Builder'], supportedReasoning: ['low', 'high'] } as DiscoveredModel;
const fixed = { ...draft, selectionMode: 'fixed' as const };
assert.equal(validateAgentProfileDraft(fixed, [account], [model]), null, 'compatible fixed routing is valid');
assert.match(validateAgentProfileDraft({ ...fixed, accountProfileId: '', modelCatalogId: '' }, [account], [model])!, /fixed route needs/i);
assert.match(validateAgentProfileDraft(fixed, [], [model])!, /account is no longer available/i);
assert.match(validateAgentProfileDraft(fixed, [account], [])!, /model is no longer/i);
assert.match(validateAgentProfileDraft({ ...fixed, accountProfileId: 'other' }, [account, { ...account, id: 'other' }], [model])!, /different account/i);
assert.match(validateAgentProfileDraft({ ...fixed, reasoningLevel: 'max' }, [account], [model])!, /reasoning level/i);
assert.match(validateAgentProfileDraft(fixed, [{ ...account, allowedRoles: ['researcher'] }], [model])!, /account does not allow/i);
assert.match(validateAgentProfileDraft(fixed, [account], [{ ...model, suitableRoles: ['QA'] }])!, /model does not support/i);
assert.equal(validateAgentProfileDraft(fixed, [{ ...account, allowedRoles: [] }], [model]), null, 'empty account roles retain the scheduler all-role convention');
assert.equal(validateAgentProfileDraft({ ...emptyAgentProfileDraft(), name: 'Basic researcher' }, [], []), null, 'basic automatic creation does not require accounts');
assert.equal(validateAgentProfileDraft({ ...emptyAgentProfileDraft(), name: 'Fallback', selectionMode: 'fixed' }, [], [], { fallbackCatalogIds: ['saved-route'] }), null, 'existing explicit fallback routes remain editable');

console.log('agents view profile payload tests passed');
