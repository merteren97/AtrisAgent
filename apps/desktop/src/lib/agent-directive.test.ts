import assert from 'node:assert/strict';
import type { DiscoveredModel } from '@/stores/account-store';
import { buildComposerRouteOptions, parseAgentDirective } from './agent-directive';

const model = {
  catalogId: 'codex:gpt-5.2',
  runtimeModelId: 'gpt-5.2',
  name: 'GPT-5.2',
  available: true,
} as DiscoveredModel;

for (const input of [
  "Subagent'lar yine aynı model olarak olsun",
  'tüm alt ajanlar aynı modeli kullansın',
  'All subagents should use the same model',
  'Use the same model for every child agent',
  'All the sub-agents must stay on the same model',
  'Every mission agent should be on the same model',
]) {
  const directive = parseAgentDirective(input, [model]);
  assert.equal(directive.teamWideModel, true, input);
  assert.equal(directive.command, undefined, input);
  assert.equal(directive.targetRole, undefined, input);
  assert.equal(directive.dynamicAgent, false, input);
}

for (const input of [
  'Subagents should use different models',
  'Not all subagents should use the same model',
  'Compare agents using the same model family',
  'Use the same formatting model for this document',
]) {
  assert.equal(parseAgentDirective(input, [model]).teamWideModel, false, input);
}

const explicitAgent = parseAgentDirective('/agent investigate the parser', [model]);
assert.equal(explicitAgent.command, 'agent');
assert.equal(explicitAgent.targetRole, 'Builder');
assert.equal(explicitAgent.dynamicAgent, true);

const directModel = parseAgentDirective('/agent @Reviewer model=gpt-5.2', [model]);
assert.equal(directModel.command, 'agent');
assert.equal(directModel.targetRole, 'Reviewer');
assert.equal(directModel.modelCatalogId, model.catalogId);

assert.equal(parseAgentDirective('/review this change', [model]).targetRole, 'Reviewer');
assert.equal(parseAgentDirective('/summarize this mission', [model]).targetRole, 'Orchestrator');

const missionDirective = parseAgentDirective('All subagents should use the same model', [model]);
assert.deepEqual(buildComposerRouteOptions(missionDirective, {
  selectedModel: model.catalogId,
  selectedReasoning: 'high',
}), {
  options: {
    model: model.catalogId,
    reasoningLevel: 'high',
    targetRole: undefined,
    routeRole: undefined,
    routeScope: 'mission',
    command: undefined,
  },
});

assert.deepEqual(buildComposerRouteOptions(parseAgentDirective('Build this', [model]), {
  selectedModel: model.catalogId,
  selectedReasoning: 'medium',
}).options, {
  model: model.catalogId,
  reasoningLevel: 'medium',
  targetRole: undefined,
  routeRole: 'Orchestrator',
  routeScope: 'role',
  command: undefined,
});

assert.match(
  buildComposerRouteOptions(missionDirective, {}).error || '',
  /Select an available model/,
);

console.log('agent directive tests passed');
