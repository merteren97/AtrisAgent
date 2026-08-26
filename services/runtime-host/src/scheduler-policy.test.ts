import type { AccountProfile, ModelDescriptor, WorkerRequest } from '@atris-agent-code/domain';
import { Scheduler } from './scheduler';

function profile(id: string, runtimeType: AccountProfile['runtimeType']): AccountProfile {
  const now = new Date().toISOString();
  return {
    id,
    provider: runtimeType === 'codex' ? 'openai' : runtimeType === 'claude_code' ? 'anthropic' : 'opencode',
    runtimeType,
    profileName: `${runtimeType}-${id}`,
    authStatus: 'connected',
    configDir: '',
    supportedModels: [],
    usageScope: null,
    createdAt: now,
    updatedAt: now,
    allowedRoles: ['builder'],
    schedulerAuto: true,
    capabilitySnapshot: { worktreeAwareness: true },
  };
}

function model(
  catalogId: string,
  accountProfileId: string,
  runtimeId: ModelDescriptor['runtimeId'],
  options: Partial<ModelDescriptor> = {},
): ModelDescriptor {
  return {
    catalogId,
    runtimeId,
    accountProfileId,
    providerId: runtimeId === 'codex' ? 'openai' : runtimeId === 'claude_code' ? 'anthropic' : 'opencode',
    runtimeModelId: catalogId,
    displayName: catalogId,
    supportedRoles: ['builder'],
    supportedReasoning: ['medium', 'high'],
    inputModalities: ['text'],
    availability: 'available',
    source: 'discovered',
    ...options,
  };
}

function request(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    role: 'builder',
    capabilities: [],
    task: 'test routing',
    priority: 'medium',
    requiresWorktree: true,
    ...overrides,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[FAIL] ${message}`);
  console.log(`[PASS] ${message}`);
}

function run(): void {
  const scheduler = new Scheduler({ availableAdapters: ['codex', 'claude_code', 'opencode'] });
  const codex = profile('profile-codex', 'codex');
  const claude = profile('profile-claude', 'claude_code');
  const codexModel = model('codex-model', codex.id, 'codex');
  const claudeModel = model('claude-model', claude.id, 'claude_code', { isDefault: true });
  const profiles = [codex, claude];
  const models = [codexModel, claudeModel];

  const auto = scheduler.resolveRoute(request({
    routeSelectionMode: 'auto',
    preferredCatalogId: codexModel.catalogId,
    preferredAccountProfileId: codex.id,
    preferredReasoning: 'high',
  }), profiles, models);
  assert(auto.model?.catalogId === claudeModel.catalogId, 'Auto mode ignores stale configured route hints and delegates selection to scheduler scoring');
  assert(auto.reasoningLevel === 'medium', 'Auto mode ignores configured reasoning and uses the role-compatible scheduler default');

  const autoEnabled = profile('profile-auto-enabled', 'codex');
  const autoDisabled = { ...profile('profile-auto-disabled', 'claude_code'), schedulerAuto: false };
  const autoEnabledModel = model('auto-enabled-model', autoEnabled.id, 'codex', { availability: 'unknown' });
  const autoDisabledModel = model('auto-disabled-model', autoDisabled.id, 'claude_code', { isDefault: true });
  const schedulerAutoRoute = scheduler.resolveRoute(
    request({ routeSelectionMode: 'auto' }),
    [autoEnabled, autoDisabled],
    [autoEnabledModel, autoDisabledModel],
  );
  assert(schedulerAutoRoute.profile?.id === autoEnabled.id, 'Auto mode excludes profiles whose schedulerAuto flag is disabled');

  const explicitDisabledRoute = scheduler.resolveRoute(
    request({ routeSelectionMode: 'prefer', preferredAccountProfileId: autoDisabled.id }),
    [autoEnabled, autoDisabled],
    [autoEnabledModel, autoDisabledModel],
  );
  assert(explicitDisabledRoute.profile?.id === autoDisabled.id, 'Prefer mode may explicitly target a scheduler-disabled profile');

  const preferred = scheduler.resolveRoute(request({
    routeSelectionMode: 'prefer',
    preferredCatalogId: codexModel.catalogId,
    preferredAccountProfileId: codex.id,
    preferredReasoning: 'high',
    routingSource: 'team_template',
  }), profiles, models);
  assert(preferred.model?.catalogId === codexModel.catalogId, 'Prefer mode prioritizes the configured account-scoped model');
  assert(preferred.reasoningLevel === 'high', 'Prefer mode applies configured reasoning when the model supports it');
  assert(preferred.reasons.some((reason) => reason.includes('team template')), 'Resolved route records its execution-policy source');

  const fallbackModel = model('codex-fallback', codex.id, 'codex');
  const fixedFallback = scheduler.resolveRoute(request({
    routeSelectionMode: 'fixed',
    preferredCatalogId: 'missing-primary',
    preferredAccountProfileId: codex.id,
    fallbackCatalogIds: [fallbackModel.catalogId],
  }), profiles, [...models, fallbackModel]);
  assert(fixedFallback.model?.catalogId === fallbackModel.catalogId, 'Fixed mode uses ordered fallbacks when the primary route cannot run');

  const crossAccountFallback = model('claude-cross-account-fallback', claude.id, 'claude_code');
  const fixedCrossAccount = scheduler.resolveRoute(request({
    routeSelectionMode: 'fixed',
    preferredCatalogId: 'missing-primary',
    preferredAccountProfileId: codex.id,
    fallbackCatalogIds: [crossAccountFallback.catalogId],
  }), profiles, [...models, crossAccountFallback]);
  assert(
    fixedCrossAccount.model?.catalogId === crossAccountFallback.catalogId && fixedCrossAccount.profile?.id === claude.id,
    'Fixed mode permits an explicitly listed fallback to cross account/runtime boundaries',
  );
  assert(
    fixedCrossAccount.reasons.some((reason) => reason.includes('outside preferred account')),
    'Cross-account fallback is recorded explicitly in the route reasons',
  );

  const fixedAccount = scheduler.resolveRoute(request({
    routeSelectionMode: 'fixed',
    preferredAccountProfileId: claude.id,
  }), profiles, models);
  assert(fixedAccount.profile?.id === claude.id, 'Fixed account-only policy cannot escape to another account');

  const capable = { ...codex, capabilitySnapshot: { worktreeAwareness: true } };
  const incapable = { ...claude, capabilitySnapshot: { worktreeAwareness: false } };
  const capabilityRoute = scheduler.resolveRoute(request({ capabilities: ['workspace-write'] }), [capable, incapable], [codexModel, claudeModel]);
  assert(capabilityRoute.profile?.id === capable.id, 'Scheduler excludes runtimes that do not advertise a required runtime capability');
  assert(scheduler.canFulfill(request({ capabilities: ['implementation'] })), 'Scheduler canFulfill accepts semantic task capabilities when an adapter is registered');
  assert(!new Scheduler({ availableAdapters: [] }).canFulfill(request()), 'Scheduler canFulfill rejects requests when no adapter is registered');

  let rejected = false;
  try {
    scheduler.resolveRoute(request({
      routeSelectionMode: 'fixed',
      preferredAccountProfileId: 'missing-profile',
    }), profiles, models);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('fixed');
  }
  assert(rejected, 'Fixed mode fails explicitly when no permitted route is runnable');

  console.log('\nScheduler policy tests passed.');
}

run();
