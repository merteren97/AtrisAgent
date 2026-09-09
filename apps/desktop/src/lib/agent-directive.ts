import type { DiscoveredModel } from '@/stores/account-store';

export const AGENT_ROLES = ['Orchestrator', 'Builder', 'Reviewer', 'Researcher', 'QA'] as const;
export type AgentRoleLabel = (typeof AGENT_ROLES)[number];
export type ChatCommand = 'plan' | 'agent' | 'review' | 'summarize';

export interface AgentDirective {
  command?: ChatCommand;
  targetRole?: AgentRoleLabel;
  teamWideModel: boolean;
  modelCatalogId?: string;
  modelName?: string;
  reasoningLevel?: string;
  dynamicAgent: boolean;
  matchedBy?: 'explicit-model' | 'catalog-name' | 'runtime-id';
  modelError?: string;
}

const ROLE_ALIASES: Array<[RegExp, AgentRoleLabel]> = [
  [/(?:^|\s)@(orchestrator|orkestrator|master|coordinator)\b/i, 'Orchestrator'],
  [/(?:^|\s)@(builder|developer|gelistirici|geliştirici|coder|kodlayici|kodlayıcı)\b/i, 'Builder'],
  [/(?:^|\s)@(reviewer|review|inceleyici|denetci|denetçi)\b/i, 'Reviewer'],
  [/(?:^|\s)@(researcher|research|arastirmaci|araştırmacı)\b/i, 'Researcher'],
  [/(?:^|\s)@(qa|tester|testci|testçi)\b/i, 'QA'],
  [/\b(orchestrator|orkestrator|master|coordinator)\s+(?:agent|ajan|olarak)\b/i, 'Orchestrator'],
  [/\b(builder|developer|gelistirici|geliştirici|coder|kodlayici|kodlayıcı)\s+(?:agent|ajan|olarak)\b/i, 'Builder'],
  [/\b(reviewer|review|inceleyici|denetci|denetçi)\s+(?:agent|ajan|olarak)\b/i, 'Reviewer'],
  [/\b(researcher|research|arastirmaci|araştırmacı)\s+(?:agent|ajan|olarak)\b/i, 'Researcher'],
  [/\b(qa|tester|testci|testçi)\s+(?:agent|ajan|olarak)\b/i, 'QA'],
];

const DYNAMIC_AGENT_TRIGGER = /(?:^\/agent\b|\bsub[\s-]?agent\b|\balt\s+ajan\b|\buzman\s+ajan\b|\bajan\s+olarak\b|\bagent\s+olarak\b|\bmodel(?:i|ini)?\s+(?:calistir|çalıştır|baslat|başlat)\b)/i;
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

type ModelKey = { value: string; source: 'catalog-name' | 'runtime-id' };

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findRole(input: string): AgentRoleLabel | undefined {
  for (const [pattern, role] of ROLE_ALIASES) {
    if (pattern.test(input)) return role;
  }
  return undefined;
}

function findCommand(input: string): ChatCommand | undefined {
  const match = input.trimStart().match(/^\/(plan|agent|review|summarize)\b/i);
  if (match) return match[1].toLowerCase() as ChatCommand;
  if (/\b(?:review|incele|denetle|kod\s+incelemesi)\b/i.test(input) && /\b(?:ajan|agent|sub[\s-]?agent)\b/i.test(input)) return 'review';
  if (/\b(?:summarize|ozetle|özetle)\b/i.test(input) && /\b(?:ajan|agent|mission|gorev|görev)\b/i.test(input)) return 'summarize';
  return undefined;
}

function hasTeamWideModelIntent(input: string, namedModel: boolean): boolean {
  const value = ` ${normalize(input)} `;
  const mentionsTeam = /\b(?:all|every)\s+(?:the\s+)?(?:subagents?|sub\s+agents?|child\s+agents?|mission\s+agents?|agents?)\b/.test(value)
    || /\b(?:subagents|sub\s+agents|child\s+agents|sub\s*agent\s+lar\w*|sub\s*engine\s+lar\w*)\b/.test(value)
    || /\b(?:tum|butun|her)\s+(?:alt\s+ajanlar?|ajanlar?)\b/.test(value)
    || /\balt\s+ajanlar\b/.test(value);
  const sameModel = /\b(?:the\s+)?same\s+(?:selected\s+)?model\b/.test(value)
    || /\bayni\s+(?:secili\s+)?model(?:i|le)?\b/.test(value);
  const directive = /\b(?:use|uses|using|share|run|runs|keep|stick|have|be|should|must|kullansin|kullansinlar|kullan|calissin|calissinlar|olsun|olarak\s+olsun)\b/.test(value);
  const negated = /\b(?:not|different|separate|farkli|ayri)\b.{0,30}\b(?:same|ayni)\s+(?:selected\s+|secili\s+)?model/.test(value)
    || /\b(?:same|ayni)\s+(?:selected\s+|secili\s+)?model\b.{0,20}\b(?:not|degil)\b/.test(value);
  if (!namedModel && /\b(?:different|separate|farkli|ayri)\s+model/.test(value)) return false;
  return mentionsTeam && (sameModel || namedModel || /\bmodel\w*\b/.test(value)) && directive && !negated;
}

// Only direct instructions change routing. Quoted examples, code and negation
// remain conversation content, never hidden execution settings.
function instructionText(input: string): string {
  return input.replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/(?:^|\s)["“][^"”]*["”]/g, ' ')
    .replace(/(?:^|\s)'[^'\n]+'/g, ' ');
}

function isNegatedInstruction(input: string): boolean {
  return /\b(?:(?:never|dont|don t|do not|avoid)\s+(?:use|using|run|running|select)|not\s+all\s+(?:sub|child|agent)|kullanma\w*|kullanilma\w*|istemiyorum|degil)\b/.test(normalize(input));
}

function findReasoning(input: string): string | undefined {
  const explicit = input.match(/(?:reasoning|effort|dusunme|düşünme)\s*(?:level|seviyesi)?\s*[:=]\s*["']?([a-z-]+)/i)?.[1];
  const normalizedExplicit = explicit ? normalize(explicit).replace(/\s+/g, '') : undefined;
  if (normalizedExplicit) {
    if (normalizedExplicit === 'extrahigh' || normalizedExplicit === 'cokyuksek') return 'xhigh';
    if ((REASONING_LEVELS as readonly string[]).includes(normalizedExplicit)) return normalizedExplicit;
  }

  const natural = input.match(/\b(low|medium|high|xhigh|max|minimal|dusuk|düşük|orta|yuksek|yüksek|cok\s+yuksek|çok\s+yüksek)\s+(?:reasoning|effort|dusunme|düşünme)\b/i)?.[1];
  if (!natural) return undefined;
  const value = normalize(natural).replace(/\s+/g, '');
  if (value === 'dusuk') return 'low';
  if (value === 'orta') return 'medium';
  if (value === 'yuksek') return 'high';
  if (value === 'cokyuksek') return 'xhigh';
  return value;
}

function explicitModelQuery(input: string): string | undefined {
  const quoted = input.match(/(?:model|model-id|modelid)\s*[:=]\s*(["'])(.*?)\1/i)?.[2]?.trim();
  if (quoted) return quoted;
  const flag = input.match(/--model(?:=|\s+)([a-z0-9._:/-]+)/i)?.[1]?.trim();
  if (flag) return flag;
  const unquoted = input.match(/(?:model|model-id|modelid)\s*[:=]\s*([^,\n]+?)(?=\s+(?:reasoning|effort|dusunme|düşünme)\s*(?:level|seviyesi)?\s*[:=]|\s+@\w+|$)/i)?.[1]?.trim();
  return unquoted || undefined;
}

function modelKeys(model: DiscoveredModel): ModelKey[] {
  const keys: ModelKey[] = [
    { value: model.name, source: 'catalog-name' },
    { value: model.runtimeModelId, source: 'runtime-id' },
    { value: model.catalogId, source: 'runtime-id' },
  ];
  return keys
    .map((item) => ({ ...item, value: normalize(item.value) }))
    .filter((item) => item.value.length >= 4);
}

function findModel(input: string, models: DiscoveredModel[]): Pick<AgentDirective, 'modelCatalogId' | 'modelName' | 'matchedBy' | 'modelError'> {
  const explicitQuery = explicitModelQuery(input);
  const resolve = (matches: DiscoveredModel[], source: AgentDirective['matchedBy']) => {
    const available = [...new Map(matches.filter((model) => model.available).map((model) => [model.catalogId, model])).values()];
    if (available.length > 1) return { modelError: 'This model matches multiple connected routes. Specify its exact catalog ID.' };
    if (available.length === 0) return { modelError: 'The requested model is unavailable. Connect its account or choose an available model.' };
    return { modelCatalogId: available[0].catalogId, modelName: available[0].name, matchedBy: source };
  };
  if (explicitQuery) {
    const query = normalize(explicitQuery);
    const catalogMatch = models.filter((model) => model.catalogId === explicitQuery);
    return resolve(catalogMatch.length ? catalogMatch : models.filter((model) => modelKeys(model).some((key) => key.value === query)), 'explicit-model');
  }

  const normalizedInput = ` ${normalize(input)} `;
  const candidates = models.flatMap((model) => modelKeys(model).map((key) => ({ model, ...key })))
    .filter((candidate) => candidate.value.length >= 5)
    .sort((a, b) => b.value.length - a.value.length);

  const match = candidates.find((candidate) => normalizedInput.includes(` ${candidate.value} `));
  if (!match) return {};
  return resolve(candidates.filter((candidate) => candidate.value.length === match.value.length
    && normalizedInput.includes(` ${candidate.value} `)).map((candidate) => candidate.model), match.source);
}

export function parseAgentDirective(
  input: string,
  models: DiscoveredModel[],
  selectedRole: string = 'Orchestrator',
): AgentDirective {
  input = instructionText(input);
  if (isNegatedInstruction(input)) return { teamWideModel: false, dynamicAgent: false };
  const command = findCommand(input);
  const explicitRole = findRole(input);
  const matchedModel = findModel(input, models);
  const teamWideModel = hasTeamWideModelIntent(input, Boolean(matchedModel.modelCatalogId || matchedModel.modelError));
  const sameModel = /\b(?:same|ayni)\s+(?:selected\s+|secili\s+)?model\w*\b/.test(normalize(input));
  if (teamWideModel && !sameModel && !matchedModel.modelCatalogId && !matchedModel.modelError) {
    matchedModel.modelError = 'The requested subagent model was not found. Specify an available model by its exact name or catalog ID.';
  }
  const dynamicAgent = command === 'agent'
    || (!teamWideModel && DYNAMIC_AGENT_TRIGGER.test(input))
    || Boolean(!teamWideModel && explicitRole && matchedModel.modelCatalogId);

  let targetRole = teamWideModel ? undefined : explicitRole;
  if (!targetRole && command === 'review') targetRole = 'Reviewer';
  if (!targetRole && command === 'summarize') targetRole = 'Orchestrator';
  if (!targetRole && dynamicAgent) {
    targetRole = selectedRole !== 'Orchestrator' && AGENT_ROLES.includes(selectedRole as AgentRoleLabel)
      ? selectedRole as AgentRoleLabel
      : 'Builder';
  }

  return {
    command: command || (dynamicAgent ? 'agent' : undefined),
    targetRole,
    teamWideModel,
    reasoningLevel: findReasoning(input),
    dynamicAgent,
    ...matchedModel,
  };
}

export interface ComposerRouteOptions {
  model?: string;
  orchestratorModel?: string;
  orchestratorReasoningLevel?: string;
  reasoningLevel?: string;
  targetRole?: AgentRoleLabel;
  routeRole?: AgentRoleLabel;
  routeScope?: 'mission' | 'role' | 'subagents';
  command?: ChatCommand;
}

interface ComposerRouteContext {
  selectedModel?: string;
  selectedReasoning?: string;
  directiveModelDefaultReasoning?: string;
  directiveReasoningSupported?: boolean;
}

export function buildComposerRouteOptions(
  directive: AgentDirective,
  context: ComposerRouteContext,
): { options: ComposerRouteOptions; error?: string } {
  if (directive.modelError) return { options: {}, error: directive.modelError };
  const model = directive.modelCatalogId || context.selectedModel;
  const reasoningLevel = directive.reasoningLevel && context.directiveReasoningSupported !== false
    ? directive.reasoningLevel
    : directive.modelCatalogId
      ? context.directiveModelDefaultReasoning
      : context.selectedModel
        ? context.selectedReasoning
        : undefined;

  if (directive.teamWideModel && !model) {
    return {
      options: { command: directive.command, targetRole: directive.targetRole },
      error: 'Select an available model before applying it to all subagents.',
    };
  }

  return {
    options: {
      model,
      ...(directive.teamWideModel ? {orchestratorModel: context.selectedModel, orchestratorReasoningLevel: context.selectedReasoning} : {}),
      reasoningLevel,
      targetRole: directive.targetRole,
      routeRole: directive.teamWideModel ? undefined : directive.targetRole || 'Orchestrator',
      routeScope: model ? (directive.teamWideModel ? 'subagents' : 'role') : undefined,
      command: directive.command,
    },
  };
}
