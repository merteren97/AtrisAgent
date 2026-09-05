import {
  defaultAgentProfile,
  mergeAgentProfiles,
  normalizeAgentProfile,
  parseAgentProfile,
  resolveAgentProfile,
} from './agent';

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const templateProfile = normalizeAgentProfile({
  id: 'frontend-designer',
  name: 'Frontend Designer',
  role: 'BUILDER',
  instructions: 'Prefer accessible, calm UI.',
  capabilities: ['React', 'React'],
  allowedRoutePolicy: {
    allowedCatalogIds: ['codex:primary:frontend', 'codex:primary:frontend'],
  },
});
assert(templateProfile.role === 'builder', 'named profile normalizes role casing to a fixed core role');
assert(templateProfile.capabilities.length === 1, 'profile capabilities are deduplicated');
assert(templateProfile.allowedRoutePolicy?.allowedCatalogIds?.length === 1, 'profile route allowlist is normalized');

let malformedAllowlistRejected = false;
try {
  normalizeAgentProfile({ role: 'builder', allowedRoutePolicy: { allowedCatalogIds: 'not-an-array' } });
} catch {
  malformedAllowlistRejected = true;
}
assert(malformedAllowlistRejected, 'malformed profile allowlists fail closed instead of becoming unrestricted');
let invalidAllowlistEntryRejected = false;
try {
  normalizeAgentProfile({ role: 'builder', routePolicy: { allowedRuntimeTypes: ['opencode', 'unknown-runtime'] } });
} catch {
  invalidAllowlistEntryRejected = true;
}
assert(invalidAllowlistEntryRejected, 'unknown runtime allowlist entries are rejected');
const denyAll = normalizeAgentProfile({ role: 'builder', allowedRoutePolicy: { allowedCatalogIds: [] } });
assert(Array.isArray(denyAll.allowedRoutePolicy?.allowedCatalogIds) && denyAll.allowedRoutePolicy?.allowedCatalogIds.length === 0,
  'an explicit empty profile allowlist remains deny-all');
const narrowed = mergeAgentProfiles(
  normalizeAgentProfile({ role: 'builder', allowedRoutePolicy: { allowedCatalogIds: ['catalog-a', 'catalog-b'] } }),
  { allowedRoutePolicy: { allowedCatalogIds: ['catalog-b'] } },
);
assert(narrowed.allowedRoutePolicy?.allowedCatalogIds?.join(',') === 'catalog-b',
  'profile allowlist overrides can narrow but never broaden an inherited route constraint');

const resolved = resolveAgentProfile('builder', {
  default: { name: 'Default Builder', instructions: 'Use legacy defaults.' },
  teamTemplate: templateProfile,
  workspace: { instructions: 'Use the workspace design system.', capabilities: ['Tailwind'] },
  explicit: { name: 'Landing Specialist' },
});
assert(resolved.source === 'explicit', 'explicit profile override has highest precedence');
assert(resolved.profile.name === 'Landing Specialist', 'explicit profile fields override template defaults');
assert(resolved.profile.instructions === 'Use the workspace design system.', 'workspace profile fields survive an explicit partial override');
assert(resolved.profile.capabilities.includes('Tailwind'), 'workspace capabilities are retained');
assert(resolved.profile.name === 'Landing Specialist' && resolved.profile.instructions === 'Use the workspace design system.',
  'legacy defaults remain the lowest-precedence profile layer');
let requestedProfileMismatchRejected = false;
try {
  resolveAgentProfile('builder', {
    teamTemplate: { id: 'template-specialist', role: 'builder', name: 'Template Specialist' },
    explicit: { id: 'different-specialist', name: 'Different Specialist' },
    requestedProfileId: 'template-specialist',
  });
} catch {
  requestedProfileMismatchRejected = true;
}
assert(requestedProfileMismatchRejected, 'an explicit requested profile id cannot be replaced by a later precedence layer');

let roleMismatchRejected = false;
try {
  mergeAgentProfiles(defaultAgentProfile('builder'), { role: 'reviewer', name: 'Unsafe override' });
} catch {
  roleMismatchRejected = true;
}
assert(roleMismatchRejected, 'profile overrides cannot replace the fixed security role');
assert(parseAgentProfile({ id: 'invalid', role: 'admin' }) === undefined, 'unknown security roles are rejected');

console.log('[PASS] agent profile normalization, precedence, and fixed-role guards');
