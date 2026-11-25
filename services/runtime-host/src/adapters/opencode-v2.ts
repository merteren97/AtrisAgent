import type { CanonicalReasoning } from '@atris-agent-code/domain';

export const isOpenCodeV2 = (version?: string): boolean =>
  Number(version?.match(/(?:^|\s)v?(\d+)\./i)?.[1]) >= 2;

export function v2ModelRef(route?: string, variant?: string) {
  if (!route) return undefined;
  const [model] = route.split('#');
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length - 1) throw new Error('OpenCode expects a provider/model identifier.');
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(variant ? { variant } : {}) };
}

export interface V2Model {
  id: string;
  providerID: string;
  name?: string;
  enabled: boolean;
  variants?: { id: string }[];
  capabilities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
}

export function v2Models(envelope: any): V2Model[] {
  if (!Array.isArray(envelope?.data) || envelope.data.some((row: any) =>
    !row || typeof row.id !== 'string' || typeof row.providerID !== 'string' || typeof row.enabled !== 'boolean')) {
    throw new Error('OpenCode returned an unrecognized model catalog.');
  }
  return envelope.data.filter((row: V2Model) => row.enabled);
}

export function v2Reasoning(model: V2Model): CanonicalReasoning[] {
  return (model.variants || []).map(item => item.id)
    .filter((id): id is CanonicalReasoning => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(id));
}

export function hasOpenCodeConnections(rows: unknown): boolean {
  if (!Array.isArray(rows)) throw new Error('OpenCode returned an unrecognized integration list.');
  return rows.some(row => Array.isArray(row?.connections) && row.connections.some((c: any) =>
    (c?.type === 'credential' || c?.type === 'env') && c.status?.status !== 'needs_auth'));
}

export interface V2Field {
  key: string;
  type: string;
  title?: string;
  description?: string;
  options?: { value: string; label: string; description?: string }[];
  custom?: boolean;
  hidden?: boolean;
  when?: unknown[];
}

export function v2Questions(fields: V2Field[], title: string) {
  if (!Array.isArray(fields) || fields.some(field => field.hidden || field.when?.length ||
    !['string','multiselect','boolean','integer','number'].includes(field.type))) return undefined;
  return fields.map(field => ({
    header: field.title || title,
    question: field.description || field.title || field.key,
    options: field.type === 'boolean' ? [{ label: 'true' }, { label: 'false' }] : (field.options || []),
    multiple: field.type === 'multiselect',
    custom: field.type !== 'boolean' && (!field.options?.length || field.custom === true),
  }));
}

export function v2FormAnswer(fields: V2Field[], answers: string[][]) {
  if (answers.length !== fields.length) throw new Error('OpenCode form answers do not match its fields.');
  return Object.fromEntries(fields.map((field, index) => {
    const selected = answers[index].map(label => field.options?.find(item => item.label === label)?.value ?? label);
    if (!selected.length && field.type !== 'multiselect') return [field.key, undefined];
    if (field.type === 'boolean' && !['true','false'].includes(selected[0])) throw new Error('A boolean answer is required.');
    if (field.type === 'integer' || field.type === 'number') {
      const number = Number(selected[0]);
      if (!selected[0].trim() || !Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) {
        throw new Error('A numeric answer is required.');
      }
      return [field.key, number];
    }
    const value = field.type === 'multiselect' ? selected : field.type === 'boolean' ? selected[0] === 'true' : selected[0];
    return [field.key, value];
  }));
}
