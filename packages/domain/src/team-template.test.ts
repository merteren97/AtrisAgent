import { resolveTemplateAgentProfile, type TeamTemplate } from './team-template';

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const template: TeamTemplate = {
  id: 'core',
  name: 'Core',
  description: 'Core team',
  roles: [{
    role: 'builder',
    modelProfileId: '',
    accountProfileId: '',
    defaultCapabilities: ['workspace-write'],
    accessLevel: 'write',
  }],
  agentProfiles: [{
    id: 'frontend-designer',
    name: 'Frontend Designer',
    role: 'builder',
    instructions: 'Use the shared component system.',
    capabilities: ['React'],
  }],
  profileDefaults: { builder: 'frontend-designer' },
  isDefault: true,
  createdAt: '2026-09-04T00:00:00.000Z',
};

const workspace = {
  profileDefaults: { builder: { instructions: 'Use the workspace brand tokens.', capabilities: ['Tailwind'] } },
};
const resolved = resolveTemplateAgentProfile('builder', template, workspace);
assert(resolved.source === 'workspace', 'workspace profile override outranks template defaults');
assert(resolved.profile.id === 'frontend-designer', 'workspace partial override preserves the template profile identity');
assert(resolved.profile.instructions.includes('workspace brand'), 'workspace profile instructions are effective');
assert(resolved.profile.capabilities.includes('Tailwind'), 'workspace profile capabilities are effective');

const requestedWithWorkspacePatch = resolveTemplateAgentProfile('builder', template, workspace, undefined, 'frontend-designer');
assert(requestedWithWorkspacePatch.profile.id === 'frontend-designer'
  && requestedWithWorkspacePatch.source === 'workspace'
  && requestedWithWorkspacePatch.profile.instructions.includes('workspace brand'),
  'workspace refinements apply to a requested template profile without replacing its identity');

let missingRequestedProfileRejected = false;
try {
  resolveTemplateAgentProfile('builder', template, undefined, undefined, 'missing-profile');
} catch {
  missingRequestedProfileRejected = true;
}
assert(missingRequestedProfileRejected, 'a missing requested template profile fails closed');

let wrongRoleRequestedProfileRejected = false;
try {
  resolveTemplateAgentProfile('builder', {
    ...template,
    agentProfiles: [{ id: 'reviewer-profile', name: 'Reviewer Profile', role: 'reviewer', instructions: '', capabilities: [] }],
  }, undefined, undefined, 'reviewer-profile');
} catch {
  wrongRoleRequestedProfileRejected = true;
}
assert(wrongRoleRequestedProfileRejected, 'a requested profile assigned to another fixed role fails closed');

let precedenceCannotReplaceRequestedProfile = false;
try {
  resolveTemplateAgentProfile(
    'builder',
    template,
    undefined,
    { id: 'different-profile', name: 'Different Profile' },
    'frontend-designer',
  );
} catch {
  precedenceCannotReplaceRequestedProfile = true;
}
assert(precedenceCannotReplaceRequestedProfile, 'a requested profile cannot be replaced by an explicit mismatched profile');

const legacy = resolveTemplateAgentProfile('researcher', {
  id: 'legacy', name: 'Legacy', description: '', roles: [], isDefault: true, createdAt: '',
});
assert(legacy.profile.role === 'researcher' && legacy.source === 'default', 'legacy templates without profile fields retain safe role defaults');

console.log('[PASS] team-template profile defaults and workspace overrides');
