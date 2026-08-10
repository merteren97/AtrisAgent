import type { DiscoveredModel } from '@/stores/account-store';

export const AGENT_ROLES = ['Orchestrator', 'Builder', 'Reviewer', 'Researcher', 'QA'] as const;
export type AgentRoleLabel = (typeof AGENT_ROLES)[number];
export type ChatCommand = 'plan' | 'agent' | 'review' | 'summarize';

export interface AgentDirective {
  command?: ChatCommand;
  targetRole?: AgentRoleLabel;
  modelCatalogId?: string;
  modelName?: string;
  reasoningLevel?: string;
  dynamicAgent: boolean;
  matchedBy?: 'explicit-model' | 'catalog-name' | 'runtime-id';
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
  ];
  return keys
    .map((item) => ({ ...item, value: normalize(item.value) }))
    .filter((item) => item.value.length >= 4);
}

function findModel(input: string, models: DiscoveredModel[]): Pick<AgentDirective, 'modelCatalogId' | 'modelName' | 'matchedBy'> {
  const available = models.filter((model) => model.available);
  const explicitQuery = explicitModelQuery(input);
  if (explicitQuery) {
    const query = normalize(explicitQuery);
    const exact = available.find((model) => modelKeys(model).some((key) => key.value === query));
    const partial = exact || available.find((model) => modelKeys(model).some((key) => key.value.includes(query) || query.includes(key.value)));
    if (partial) {
      return { modelCatalogId: partial.catalogId, modelName: partial.name, matchedBy: 'explicit-model' };
    }
  }

  const normalizedInput = ` ${normalize(input)} `;
  const candidates = available.flatMap((model) => modelKeys(model).map((key) => ({ model, ...key })))
    .filter((candidate) => candidate.value.length >= 5)
    .sort((a, b) => b.value.length - a.value.length);

  const match = candidates.find((candidate) => normalizedInput.includes(` ${candidate.value} `));
  if (!match) return {};
  return {
    modelCatalogId: match.model.catalogId,
    modelName: match.model.name,
    matchedBy: match.source,
  };
}

export function parseAgentDirective(
  input: string,
  models: DiscoveredModel[],
  selectedRole: string = 'Orchestrator',
): AgentDirective {
  const command = findCommand(input);
  const explicitRole = findRole(input);
  const matchedModel = findModel(input, models);
  const dynamicAgent = command === 'agent' || DYNAMIC_AGENT_TRIGGER.test(input) || Boolean(explicitRole && matchedModel.modelCatalogId);

  let targetRole = explicitRole;
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
    reasoningLevel: findReasoning(input),
    dynamicAgent,
    ...matchedModel,
  };
}
