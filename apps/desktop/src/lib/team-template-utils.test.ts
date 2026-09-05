import assert from 'node:assert/strict';
import type { TeamTemplate } from '@atris-agent-code/domain';
import {
  CORE_DEV_TEAM_NAME,
  DEFAULT_TEAM_TEMPLATE_ID,
  getDefaultTeamTemplate,
  isGeneratedTeamTemplate,
  normalizeStoredTeamTemplateId,
  normalizeTeamTemplates,
  reconcileTeamTemplateId,
} from './team-template-utils';

function template(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'custom-team',
    name: 'Custom Team',
    description: '',
    roles: [],
    isDefault: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const core = template({
  id: DEFAULT_TEAM_TEMPLATE_ID,
  name: CORE_DEV_TEAM_NAME,
  isDefault: true,
});
const realCustom = template({ id: 'security-team', name: 'Security Team' });
const generated = template({ id: 'generated-team', name: 'Custom Security Team 1786294023311' });

assert.equal(isGeneratedTeamTemplate(generated), true);
assert.equal(isGeneratedTeamTemplate(template({ name: 'Custom Security Team Alpha' })), false);

const normalized = normalizeTeamTemplates([
  generated,
  realCustom,
  template({ id: 'security-team-duplicate', name: '  security   team  ' }),
  template({ id: 'duplicate-core', name: ' core dev team ' }),
  core,
]);

assert.deepEqual(normalized.map((item) => item.id), [DEFAULT_TEAM_TEMPLATE_ID, 'security-team']);
assert.equal(normalized[0]?.name, CORE_DEV_TEAM_NAME);

assert.equal(
  getDefaultTeamTemplate([realCustom, core])?.id,
  DEFAULT_TEAM_TEMPLATE_ID,
);
assert.equal(
  reconcileTeamTemplateId([core, realCustom], 'deleted-team'),
  DEFAULT_TEAM_TEMPLATE_ID,
);
assert.equal(
  reconcileTeamTemplateId([core, realCustom], generated.id),
  DEFAULT_TEAM_TEMPLATE_ID,
);
assert.equal(
  reconcileTeamTemplateId([realCustom], 'deleted-team'),
  'security-team',
);
assert.equal(reconcileTeamTemplateId([], 'deleted-team'), DEFAULT_TEAM_TEMPLATE_ID);

assert.equal(normalizeStoredTeamTemplateId('Core Dev Team'), DEFAULT_TEAM_TEMPLATE_ID);
assert.equal(normalizeStoredTeamTemplateId('  '), DEFAULT_TEAM_TEMPLATE_ID);
assert.equal(normalizeStoredTeamTemplateId('security-team'), 'security-team');

console.log('team template utility tests passed');
