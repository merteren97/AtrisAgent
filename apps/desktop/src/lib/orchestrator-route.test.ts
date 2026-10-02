import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscoveredModel } from '@/stores/account-store';
import type { OrchestratorPreferences } from '@/stores/orchestrator-preferences-store';
import { parseAgentDirective, type AgentDirective } from './agent-directive';
import { resolveOrchestratorRoute } from './orchestrator-route';
import { buildMissionRequestBody } from '@/stores/mission-store';

const roles = ['Orchestrator', 'Builder', 'Reviewer', 'Researcher', 'QA'];
function model(catalogId: string, patch: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: catalogId, catalogId, runtimeModelId: catalogId.split(':').pop()!, name: catalogId,
    provider: 'openai', runtimeType: 'codex', accountProfileId: 'account-a', accountName: 'Account A',
    available: true, availability: 'available', supportsReasoning: true, supportedReasoning: ['medium', 'high'],
    defaultReasoning: 'medium', routeLabel: 'Connected route', contextClass: 'Runtime reported',
    speedClass: 'Runtime managed', entitlement: 'Live account catalog', quotaInfo: 'Not exposed',
    statusBadge: 'Connected', suitableRoles: roles, category: 'connected', source: 'discovered', ...patch,
  };
}
const coordinator = model('codex:account-a:coordinator');
const worker = model('antigravity:account-b:worker', {
  runtimeType: 'antigravity', provider: 'google', accountProfileId: 'account-b',
  suitableRoles: ['Builder', 'Reviewer', 'Researcher', 'QA'], supportedReasoning: ['low'], defaultReasoning: 'low',
});
const base: OrchestratorPreferences = {
  selectedModel: coordinator.catalogId, modelScope: 'coordinator', reasoningLevel: 'high',
  teamTemplate: 'default-core-dev-team', agentProfileIds: {}, trustMode: 'Balanced',
  automationSettings: { fileWrite: null, gitCommit: null, packageInstall: null }, workMode: 'auto', teamLaunch: 'automatic',
};
function resolve(text: string, patch: Partial<OrchestratorPreferences> = {}, models = [coordinator, worker]) {
  return resolveOrchestratorRoute(parseAgentDirective(text, models), { ...base, ...patch }, models);
}
function serialize(options: Parameters<typeof buildMissionRequestBody>[2]) {
  return JSON.parse(JSON.stringify(buildMissionRequestBody('Do the work', 'project-a', options))) as Record<string, unknown>;
}
function assertBlocked(result: ReturnType<typeof resolveOrchestratorRoute>) {
  assert.ok(result.error, 'The route must report an error before the composer can send');
  assert.deepEqual(result.options, {}, 'An invalid route must not supply executable model options');
}

test('coordinator-only selection serializes an explicit role override, never a mission override', () => {
  const result = resolve('Build the requested feature');
  assert.equal(result.error, undefined);
  const body = serialize(result.options);
  assert.equal(body.modelCatalogId, coordinator.catalogId);
  assert.equal(body.routeScope, 'role');
  assert.equal(body.routeRole, 'Orchestrator');
  assert.equal(body.reasoningLevel, 'high');
  assert.equal('orchestratorModelCatalogId' in body, false);
});

test('Everyone selection serializes a mission override with no leftover role selector', () => {
  const result = resolve('Build the requested feature', { modelScope: 'all' });
  assert.equal(result.error, undefined);
  const body = serialize(result.options);
  assert.equal(body.modelCatalogId, coordinator.catalogId);
  assert.equal(body.routeScope, 'mission');
  assert.equal('routeRole' in body, false);
  assert.equal('targetRole' in body, false);
});

test('Auto serializes no fixed model or route scope in either UI scope', () => {
  for (const modelScope of ['coordinator', 'all'] as const) {
    const result = resolve('Build the requested feature', { selectedModel: '', modelScope });
    assert.equal(result.error, undefined);
    const body = serialize(result.options);
    assert.equal('modelCatalogId' in body, false);
    assert.equal('routeScope' in body, false);
    assert.equal('reasoningLevel' in body, false);
  }
});

test('an explicit worker-wide model directive keeps the coordinator and overrides Everyone scope', () => {
  for (const modelScope of ['coordinator', 'all'] as const) {
    const result = resolve(`All subagents should use model=${worker.catalogId}`, { modelScope });
    assert.equal(result.error, undefined);
    assert.deepEqual(serialize(result.options), {
      request: 'Do the work', title: 'Do the work', workspaceId: 'project-a', executionMode: 'balanced',
      modelCatalogId: worker.catalogId, reasoningLevel: 'low', routeScope: 'subagents',
      orchestratorModelCatalogId: coordinator.catalogId, orchestratorReasoningLevel: 'high',
    });
  }
});

test('same-selected-model worker directives stay child-only even with Everyone selected', () => {
  const result = resolve('All subagents should use the same selected model', { modelScope: 'all' });
  assert.equal(result.error, undefined);
  assert.equal(result.options.routeScope, 'subagents');
  assert.equal(result.options.orchestratorModel, coordinator.catalogId);
});

test('explicit role and command directives are not widened by Everyone', () => {
  for (const [text, targetRole] of [['@Reviewer review this', 'Reviewer'], ['/review review this', 'Reviewer'], ['/summarize this', 'Orchestrator']] as const) {
    const result = resolve(text, { modelScope: 'all' });
    assert.equal(result.error, undefined, text);
    assert.equal(result.options.routeScope, 'role', text);
    assert.equal(result.options.routeRole, targetRole, text);
  }
  const result = resolve(`/agent @Reviewer model=${worker.catalogId}`, { modelScope: 'all' });
  assert.equal(result.error, undefined);
  assert.equal(result.options.model, worker.catalogId);
  assert.equal(result.options.routeRole, 'Reviewer');
  assert.equal(result.options.routeScope, 'role');
  assert.equal(result.options.command, 'agent');
  assert.equal(result.options.reasoningLevel, 'low');
});

test('an explicit individual worker model also preserves the selected coordinator in a fresh request', () => {
  const result = resolve(`/agent @Reviewer model=${worker.catalogId}`);
  assert.equal(result.error, undefined);
  const body = serialize(result.options);
  assert.equal(body.orchestratorModelCatalogId, coordinator.catalogId);
  assert.equal(body.orchestratorReasoningLevel, 'high');
});

test('an explicit coordinator model retains role scope rather than inheriting Everyone', () => {
  const alternate = model('claude_code:account-c:alternate', { runtimeType: 'claude_code', provider: 'anthropic', suitableRoles: ['Orchestrator'] });
  const result = resolve(`@Orchestrator model=${alternate.catalogId}`, { modelScope: 'all' }, [coordinator, alternate]);
  assert.equal(result.error, undefined);
  assert.equal(result.options.model, alternate.catalogId);
  assert.equal(result.options.routeScope, 'role');
  assert.equal(result.options.routeRole, 'Orchestrator');
});

test('removed or unavailable selected models block normal submission in both scopes', () => {
  for (const modelScope of ['coordinator', 'all'] as const) {
    assertBlocked(resolve('Do the work', { modelScope }, [worker]));
    assertBlocked(resolve('Do the work', { modelScope }, [{ ...coordinator, available: false }, worker]));
  }
});

test('a worker-wide explicit model cannot silently drop a removed selected coordinator', () => {
  assertBlocked(resolve(`All subagents should use model=${worker.catalogId}`, {}, [worker]));
});

test('a worker-wide explicit model cannot silently drop an unavailable selected coordinator', () => {
  assertBlocked(resolve(`All subagents should use model=${worker.catalogId}`, {}, [{ ...coordinator, available: false }, worker]));
});

test('a worker-wide explicit model validates the preserved coordinator role separately', () => {
  assertBlocked(resolve(`All subagents should use model=${worker.catalogId}`, {}, [{ ...coordinator, suitableRoles: ['Builder'] }, worker]));
});

test('an explicit coordinator replacement may supersede a removed UI model', () => {
  const replacement = model('codex:account-a:replacement', { suitableRoles: ['Orchestrator'] });
  const result = resolve(`@Orchestrator model=${replacement.catalogId}`, {}, [replacement]);
  assert.equal(result.error, undefined);
  assert.equal(result.options.model, replacement.catalogId);
});

test('selected model compatibility covers coordinator versus every role, case-insensitively', () => {
  const coordOnly = { ...coordinator, suitableRoles: ['oRcHeStRaToR'] };
  assert.equal(resolve('Do the work', {}, [coordOnly]).error, undefined);
  assertBlocked(resolve('Do the work', { modelScope: 'all' }, [coordOnly]));
  assertBlocked(resolve('Do the work', {}, [{ ...coordinator, suitableRoles: ['Builder'] }]));
  assert.equal(resolve('Do the work', { modelScope: 'all' }, [{ ...coordinator, suitableRoles: [] }]).error, undefined, 'Empty role metadata preserves the existing unrestricted-model convention');
});

test('worker-wide directives require compatibility with each worker role, but not coordinator', () => {
  assert.equal(resolve(`All subagents should use model=${worker.catalogId}`).error, undefined);
  for (const missingRole of ['Builder', 'Reviewer', 'Researcher', 'QA']) {
    const incomplete = { ...worker, suitableRoles: worker.suitableRoles.filter(role => role !== missingRole) };
    assertBlocked(resolve(`All subagents should use model=${worker.catalogId}`, {}, [coordinator, incomplete]));
  }
});

test('role directives validate the explicit model against the target role', () => {
  assertBlocked(resolve(`/agent @Reviewer model=${worker.catalogId}`, {}, [coordinator, { ...worker, suitableRoles: ['Builder'] }]));
});

test('fresh parsing rejects removed explicit models instead of falling back to the UI selection', () => {
  assertBlocked(resolve('All subagents should use model=missing:route:model'));
  assertBlocked(resolve(`All subagents should use model=${worker.catalogId}`, {}, [coordinator, { ...worker, available: false }]));
});

for (const [status, models] of [
  ['removed', [coordinator]],
  ['unavailable', [coordinator, { ...worker, available: false }]],
] as const) {
  test(`a previously parsed directive rejects a now-${status} explicit model`, () => {
    const directive = parseAgentDirective(`All subagents should use model=${worker.catalogId}`, [coordinator, worker]);
    assertBlocked(resolveOrchestratorRoute(directive, base, [...models]));
  });
}

test('saved selected reasoning cannot serialize an effort unsupported by the current provider', () => {
  const highOnly = { ...coordinator, supportedReasoning: ['high'] as DiscoveredModel['supportedReasoning'], defaultReasoning: 'high' as const };
  const result = resolve('Do the work', { reasoningLevel: 'medium' }, [highOnly]);
  assert.ok(result.error || result.options.reasoningLevel === 'high', 'Reject unsupported saved effort or normalize it to the discovered model default');
});

test('explicit reasoning uses the directed provider capabilities rather than coordinator defaults', () => {
  const directive: AgentDirective = { teamWideModel: true, dynamicAgent: false, modelCatalogId: worker.catalogId, reasoningLevel: 'high' };
  const result = resolveOrchestratorRoute(directive, base, [coordinator, worker]);
  assert.equal(result.error, undefined);
  assert.equal(result.options.reasoningLevel, 'low');
  assert.equal(result.options.orchestratorReasoningLevel, 'high');
});
