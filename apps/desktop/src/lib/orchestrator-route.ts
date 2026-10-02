import { buildComposerRouteOptions, type AgentDirective } from './agent-directive';
import type { DiscoveredModel } from '@/stores/account-store';
import type { OrchestratorPreferences } from '@/stores/orchestrator-preferences-store';

export function resolveOrchestratorRoute(directive: AgentDirective, preferences: OrchestratorPreferences, models: DiscoveredModel[]) {
  const selected = models.find(model => model.catalogId === preferences.selectedModel);
  const directed = models.find(model => model.catalogId === directive.modelCatalogId);
  if (directive.modelCatalogId && !directed?.available) return { options: {}, error: 'The requested model is unavailable. Choose an available model.' };
  const workerDirective = directive.teamWideModel || Boolean(directive.targetRole && directive.targetRole.toLowerCase() !== 'orchestrator');
  const retainsCoordinator = workerDirective || !directive.modelCatalogId;
  if (retainsCoordinator && preferences.selectedModel) {
    if (!selected?.available) return { options: {}, error: 'The coordinator model is unavailable. Choose another model or Auto.' };
    if (selected.suitableRoles.length && !selected.suitableRoles.some(role => role.toLowerCase() === 'orchestrator')) return { options: {}, error: 'The coordinator model does not support orchestration.' };
  }
  const selectedReasoning = selected?.supportedReasoning.length
    ? selected.supportedReasoning.includes(preferences.reasoningLevel as never) ? preferences.reasoningLevel : selected.defaultReasoning || selected.supportedReasoning[0]
    : undefined;
  const resolution = buildComposerRouteOptions(directive, {
    selectedModel: selected?.available ? selected.catalogId : undefined,
    selectedReasoning,
    directiveModelDefaultReasoning: directed?.defaultReasoning || directed?.supportedReasoning[0],
    directiveReasoningSupported: !directive.reasoningLevel || !directed?.supportedReasoning.length || directed.supportedReasoning.includes(directive.reasoningLevel as never),
  });
  if (resolution.error) return resolution;
  if (workerDirective && selected?.available) {
    resolution.options.orchestratorModel = selected.catalogId;
    resolution.options.orchestratorReasoningLevel = selectedReasoning;
  }
  // Explicit text directives retain their own scope; the UI scope applies to a normal model selection.
  const all = preferences.modelScope === 'all' && !directive.teamWideModel && !directive.targetRole && !directive.modelCatalogId;
  const model = directed || selected;
  const required = directive.teamWideModel ? ['builder', 'reviewer', 'researcher', 'qa'] : all ? ['orchestrator', 'builder', 'reviewer', 'researcher', 'qa'] : [directive.targetRole || 'orchestrator'];
  if (model && required.some(role => model.suitableRoles.length && !model.suitableRoles.some(value => value.toLowerCase() === role.toLowerCase()))) {
    return { options: {}, error: 'This model does not support every selected role. Choose a compatible model or limit its scope.' };
  }
  return all && resolution.options.model ? { options: { ...resolution.options, routeRole: undefined, routeScope: 'mission' as const } } : resolution;
}
