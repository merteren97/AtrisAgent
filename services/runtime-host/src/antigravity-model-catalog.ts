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

interface ParsedModelRow {
  route: string;
  displayName?: string;
  reasoning?: string;
}

const REASONING_ORDER: CanonicalReasoning[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REASONING_SUFFIX = /-(minimal|low|medium|high|xhigh|max|thinking)$/i;
const DISPLAY_REASONING = /\s*(?:\((minimal|low|medium|high|xhigh|max|thinking)\)|\[(minimal|low|medium|high|xhigh|max|thinking)\])\s*$/i;
const ANSI_ESCAPE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function providerFor(modelId: string): Provider {
  const normalized = modelId.toLowerCase();
  if (normalized.includes('claude')) return 'anthropic';
  if (normalized.includes('gemini')) return 'google';
  return 'local';
}

function normalizeReasoning(value?: string): CanonicalReasoning | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized === 'thinking') return 'high';
  if (normalized.endsWith(' thinking')) return 'high';
  if (REASONING_ORDER.includes(normalized as CanonicalReasoning)) return normalized as CanonicalReasoning;
  return undefined;
}

function reasoningRank(value: CanonicalReasoning): number {
  const index = REASONING_ORDER.indexOf(value);
  return index < 0 ? REASONING_ORDER.length : index;
}

function cleanOutput(value: string): string {
  return value.replace(ANSI_ESCAPE, '').replace(/^\uFEFF/, '');
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isModelRoute(value: string): boolean {
  const route = value.trim();
  return Boolean(route)
    && !/[\s]/.test(route)
    && route.length <= 256
    && /^[a-z0-9][a-z0-9._:-]*$/i.test(route)
    && (route.includes('-') || route.includes('_') || route.includes('.') || /\d/.test(route));
}

function displayNameForRoute(route: string): string {
  return route
    .split(/[-_.:]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function displayAndReasoning(
  rawDisplayName: string | undefined,
  explicitReasoning?: string,
): { displayName?: string; reasoning?: string } {
  const displayName = rawDisplayName?.trim();
  const displayMatch = displayName?.match(DISPLAY_REASONING);
  const displayReasoning = displayMatch?.[1] || displayMatch?.[2];
  return {
    displayName: displayName?.replace(DISPLAY_REASONING, '').trim() || displayName,
    reasoning: explicitReasoning || displayReasoning,
  };
}

function parseTableRows(stdout: string): ParsedModelRow[] {
  const rows: ParsedModelRow[] = [];
  for (const rawLine of cleanOutput(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Current AGY output is a two-column table. Tabs, multiple spaces, and a
    // single separator before a capitalized display name are all accepted.
    const match = line.match(/^(\S+)(?:\t+|\s{2,}|\s+(?=[A-Z]))(.+?)\s*$/);
    if (!match || !isModelRoute(match[1])) continue;
    rows.push({ route: match[1], ...displayAndReasoning(match[2]) });
  }
  return rows;
}

function parseJsonRows(stdout: string): ParsedModelRow[] {
  const values: unknown[] = [];
  const cleaned = cleanOutput(stdout).trim();
  if (!cleaned) return [];

  try {
    values.push(JSON.parse(cleaned));
  } catch {
    // Some CLI versions may emit one JSON object per line with diagnostics
    // around it. Keep valid JSON values and let table parsing handle the rest.
    for (const line of cleaned.split(/\r?\n/)) {
      try { values.push(JSON.parse(line)); } catch { /* Ignore non-JSON lines. */ }
    }
  }

  const rows: ParsedModelRow[] = [];
  const seen = new Set<string>();
  const add = (row: ParsedModelRow): void => {
    const route = row.route.trim();
    if (!isModelRoute(route)) return;
    const key = `${route}\u0000${row.reasoning || ''}\u0000${row.displayName || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ ...row, route });
  };

  const visit = (value: unknown, inModelCollection = false, depth = 0): void => {
    if (depth > 8 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, true, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    const route = firstString(record, [
      'slug', 'modelId', 'model_id', 'runtimeModelId', 'runtime_model_id', 'route', 'model', 'id',
    ]);
    const rawDisplayName = firstString(record, ['displayName', 'display_name', 'label', 'title', 'name']);
    const explicitReasoning = firstString(record, [
      'reasoning', 'reasoningLevel', 'reasoning_level', 'effort', 'thinkingLevel', 'thinking_level',
    ]);
    const recordType = firstString(record, ['type', 'kind'])?.toLowerCase();
    const isModelRecord = Boolean(route && (inModelCollection || rawDisplayName || explicitReasoning || recordType?.includes('model')));
    if (route && isModelRecord) {
      const parsed = displayAndReasoning(rawDisplayName && rawDisplayName !== route ? rawDisplayName : undefined, explicitReasoning);
      add({ route, displayName: parsed.displayName, reasoning: parsed.reasoning });
    }

    for (const key of ['models', 'modelList', 'model_list', 'availableModels', 'available_models', 'items', 'data', 'routes']) {
      if (key in record) visit(record[key], true, depth + 1);
    }

    // A JSON object may also be a route-to-label map. Preserve each route key
    // exactly as supplied by the CLI.
    for (const [key, nested] of Object.entries(record)) {
      if (!isModelRoute(key)) continue;
      if (typeof nested === 'string') {
        add({ route: key, ...displayAndReasoning(nested) });
      } else if (nested && typeof nested === 'object') {
        const nestedRecord = nested as Record<string, unknown>;
        const label = firstString(nestedRecord, ['displayName', 'display_name', 'label', 'title', 'name']);
        const reasoning = firstString(nestedRecord, ['reasoning', 'reasoningLevel', 'reasoning_level', 'effort']);
        add({ route: key, ...displayAndReasoning(label, reasoning) });
      }
    }
  };

  for (const value of values) visit(value);
  return rows;
}

function buildFamilies(rows: ParsedModelRow[]): AntigravityCliModelFamily[] {
  const families = new Map<string, AntigravityCliModelFamily>();
  for (const row of rows) {
    const route = row.route.trim();
    if (!route) continue;
    const suffixMatch = route.match(REASONING_SUFFIX);
    const displayInfo = displayAndReasoning(row.displayName, row.reasoning);
    const reasoning = normalizeReasoning(suffixMatch?.[1] || displayInfo.reasoning);
    const familyId = suffixMatch ? route.slice(0, -suffixMatch[0].length) : route;
    const displayName = displayInfo.displayName || displayNameForRoute(familyId);
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

export function parseAntigravityModelsOutput(stdout: string): AntigravityCliModelFamily[] {
  const jsonRows = parseJsonRows(stdout);
  return buildFamilies(jsonRows.length ? jsonRows : parseTableRows(stdout));
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
