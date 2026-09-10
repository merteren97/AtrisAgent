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
    orchestratorModel: model.catalogId,
    orchestratorReasoningLevel: 'high',
    reasoningLevel: 'high',
    targetRole: undefined,
    routeRole: undefined,
    routeScope: 'subagents',
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

const gemini = {...model, name:'Gemini 3.8 Flash', runtimeModelId:'gemini-3.8-flash',catalogId:'antigravity:account:gemini-3.8-flash'};
for (const input of ['Use Gemini 3.8 Flash for all subagents', "Bütün sub-agent'lar için Gemini 3.8 Flash modelini kullan", 'Tüm alt ajanlar Gemini 3.8 Flash kullansın']) {
  const directive = parseAgentDirective(input,[model,gemini]);
  assert.equal(directive.teamWideModel,true,input);
  assert.equal(directive.dynamicAgent,false,input);
  const route=buildComposerRouteOptions(directive,{selectedModel:model.catalogId});
  assert.equal(route.options.routeScope,'subagents');
  assert.equal(route.options.model,gemini.catalogId);
}
for(const input of ['Do not use Gemini 3.8 Flash for all subagents','Discuss the example "Use Gemini 3.8 Flash for all subagents"','```Use Gemini 3.8 Flash for all subagents```']) assert.equal(parseAgentDirective(input,[gemini]).teamWideModel,false,input);
assert.ok(buildComposerRouteOptions(parseAgentDirective('Use Gemini 3.8 Flash for all subagents',[{...gemini,available:false}]),{selectedModel:model.catalogId}).error);
assert.ok(buildComposerRouteOptions(parseAgentDirective('Use Missing model for all subagents',[gemini]),{selectedModel:model.catalogId}).error);
assert.ok(parseAgentDirective('Use Gemini 3.8 Flash for all subagents',[gemini,{...gemini,catalogId:'another-account:model'}]).modelError);
assert.equal(parseAgentDirective('Use a subagent with Gemini 3.8 Flash',[gemini]).teamWideModel,false);
assert.equal(parseAgentDirective('/agent model="Gemini 3.8 Flash"',[gemini]).modelCatalogId,gemini.catalogId);
console.log('Named subagent routing, unavailable routes and quoted instruction tests passed.');
