import assert from 'node:assert/strict';
import { normalizeAgentProfiles } from './agent-profile-selector';

const profiles = normalizeAgentProfiles({
  profiles: [
    {
      id: 'builder-ui',
      name: 'UI Builder',
      role: 'builder',
      instructions: 'Keep changes focused.',
      capabilities: ['workspace-write', 'workspace-write'],
      routePolicy: {
        selectionMode: 'prefer',
        accountProfileId: 'account-safe',
        modelCatalogId: 'model-safe',
        reasoningLevel: 'high',
      },
      rawToken: 'must-not-reach-the-ui',
    },
    { id: 'invalid-role', name: 'Admin', role: 'admin', instructions: 'ignore' },
    { id: 'builder-ui', name: 'Duplicate', role: 'builder', instructions: 'ignore' },
    { id: 'research-web', name: 'Web Research', role: 'researcher', instructions: 'Cite sources.' },
  ],
});

assert.equal(profiles.length, 2, 'only fixed-role profiles and the first duplicate survive normalization');
assert.deepEqual(profiles.map((profile) => profile.role), ['builder', 'researcher'], 'profiles stay grouped in fixed-role order');
assert.equal(profiles[0]?.name, 'UI Builder');
assert.deepEqual(profiles[0]?.capabilities, ['workspace-write']);
assert.deepEqual(profiles[0]?.routePolicy, {
  selectionMode: 'prefer',
  accountProfileId: 'account-safe',
  modelCatalogId: 'model-safe',
  reasoningLevel: 'high',
});
assert(!JSON.stringify(profiles).includes('rawToken'), 'unknown credential-like fields are discarded');
assert(!JSON.stringify(profiles).includes('must-not-reach-the-ui'), 'credential-like values never reach the display model');

console.log('agent profile selector tests passed');
