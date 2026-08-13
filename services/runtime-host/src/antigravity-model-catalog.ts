import type { CanonicalReasoning, Provider } from '@atris-agent-code/domain';

export interface AntigravityCliModelFamily {
  id: string;
  displayName: string;
  provider: Provider;
  efforts: CanonicalReasoning[];
  routes: Partial<Record<CanonicalReasoning, string>>;
  defaultRoute: string;
  defaultReasoning?: CanonicalReasoning;
}

const REASONING_ORDER: CanonicalReasoning[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REASONING_SUFFIX = /-(minimal|low|medium|high|xhigh|max)$/i;
const DISPLAY_REASONING = /\s*\((Minimal|Low|Medium|High|Thinking|XHigh|Max)\)\s*$/i;

function providerFor(modelId: string): Provider {
  const normalized = modelId.toLowerCase();
  if (normalized.includes('claude')) return 'anthropic';
  if (normalized.includes('gemini')) return 'google';
  return 'local';
}

function normalizeReasoning(value?: string): CanonicalReasoning | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'thinking') return 'high';
  if (REASONING_ORDER.includes(normalized as CanonicalReasoning)) return normalized as CanonicalReasoning;
  return undefined;
}

function reasoningRank(value: CanonicalReasoning): number {
  const index = REASONING_ORDER.indexOf(value);
  return index < 0 ? REASONING_ORDER.length : index;
}

export function parseAntigravityModelsOutput(stdout: string): AntigravityCliModelFamily[] {
  const families = new Map<string, AntigravityCliModelFamily>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\S+)\s{2,}(.+)$/);
    if (!match) continue;

    const route = match[1].trim();
    const rawDisplayName = match[2].trim();
    const suffixMatch = route.match(REASONING_SUFFIX);
    const displayMatch = rawDisplayName.match(DISPLAY_REASONING);
    const reasoning = normalizeReasoning(suffixMatch?.[1] || displayMatch?.[1]);
    const familyId = suffixMatch ? route.slice(0, -suffixMatch[0].length) : route;
    const displayName = rawDisplayName.replace(DISPLAY_REASONING, '').trim() || rawDisplayName;

    const existing = families.get(familyId) || {
      id: familyId,
      displayName,
      provider: providerFor(familyId),
      efforts: [],
      routes: {},
      defaultRoute: route,
      defaultReasoning: undefined,
    };

    if (reasoning) {
      existing.routes[reasoning] = route;
      if (!existing.efforts.includes(reasoning)) existing.efforts.push(reasoning);
    }
    existing.displayName = displayName;
    if (!existing.defaultRoute) existing.defaultRoute = route;
    families.set(familyId, existing);
  }

  return [...families.values()].map((family) => {
    family.efforts.sort((left, right) => reasoningRank(left) - reasoningRank(right));
    family.defaultReasoning = family.efforts.includes('high')
      ? 'high'
      : family.efforts.includes('medium')
        ? 'medium'
        : family.efforts[0];
    if (family.defaultReasoning && family.routes[family.defaultReasoning]) {
      family.defaultRoute = family.routes[family.defaultReasoning]!;
    }
    return family;
  });
}

export function resolveAntigravityModelRoute(
  families: AntigravityCliModelFamily[],
  modelId: string,
  reasoning?: string,
): string {
  const exactRoute = families.flatMap((family) => Object.values(family.routes))
    .find((route) => route === modelId);
  if (exactRoute) return exactRoute;

  const family = families.find((candidate) => candidate.id === modelId);
  if (!family) return modelId;

  const normalizedReasoning = normalizeReasoning(reasoning);
  if (normalizedReasoning && family.routes[normalizedReasoning]) {
    return family.routes[normalizedReasoning]!;
  }
  if (family.defaultReasoning && family.routes[family.defaultReasoning]) {
    return family.routes[family.defaultReasoning]!;
  }
  return family.defaultRoute;
}
