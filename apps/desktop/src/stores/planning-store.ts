import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiRequest } from '@/lib/api-client';

export interface PlanningDocument {
  id: string; workspaceId: string; title: string; status: 'draft' | 'ready';
  createdAt: string; updatedAt: string; pinned: boolean; archivedAt: string | null;
}
export interface PlanningFile { path: string; byteSize: number; mimeType: string }
export interface DocumentVersion { path: string; content: string; revision: string }
export interface PlanningDraft { content: string; baseContent: string; baseRevision: string }
export interface PlanningSource { workspaceId: string; planId: string; executionId: string; snapshotPath: string }
export type PlanningBoardKind = 'section' | 'gallery' | 'comparison' | 'checklist' | 'research' | 'note';
export type PlanningBoardStatus = 'idea' | 'in-progress' | 'review' | 'done' | 'blocked';
export type PlanningBoardCompareMode = 'slider' | 'side-by-side';
export interface PlanningBoardMedia { path: string; alt?: string; label?: string }
export interface PlanningBoardCompare { mode: PlanningBoardCompareMode; before: string; after: string }
export interface PlanningBoardItem {
  id: string; title: string; status?: PlanningBoardStatus; body?: string;
  media?: PlanningBoardMedia[]; compare?: PlanningBoardCompare; prompt?: string; source?: string;
}
export interface PlanningBoardSection {
  id: string; title: string; kind: PlanningBoardKind; status?: PlanningBoardStatus;
  summary?: string; cover?: string; body?: string;
  children?: PlanningBoardSection[]; items?: PlanningBoardItem[];
}
export interface PlanningBoard { schemaVersion: 1; planId: string; updatedAt: string; sections: PlanningBoardSection[] }
export interface PlanningBoardVersion { board: PlanningBoard; revision: string }
export const boardApi = (workspaceId: string, planId: string) => `${planApi(workspaceId, planId)}/board`;
export const planApi = (workspaceId: string, planId?: string) => `/workspaces/${encodeURIComponent(workspaceId)}/plans${planId ? `/${encodeURIComponent(planId)}` : ''}`;
export const documentKey = (workspaceId: string, planId: string, path: string) => JSON.stringify([workspaceId, planId, path]);
interface PlanningState {
  plans: Record<string, PlanningDocument[]>;
  activeByWorkspace: Record<string, string | null>;
  groups: Record<string, boolean>;
  widths: Record<string, number>;
  chatHidden: Record<string, boolean>;
  drafts: Record<string, PlanningDraft>;
  sources: Record<string, PlanningSource>;
  handoffIds: Record<string, string>;
  errors: Record<string, string>;
  loading: Record<string, boolean>;
  creating: boolean;
  setCreating(value: boolean): void;
  select(workspaceId: string, planId: string | null): void;
  toggleGroup(workspaceId: string, group: string): void;
  setWidth(workspaceId: string, width: number): void;
  setChatHidden(workspaceId: string, hidden: boolean): void;
  setDraft(key: string, draft: PlanningDraft): void;
  clearDraft(key: string, expectedContent?: string): void;
  rememberSource(target: string, id: string, source: PlanningSource): void;
  prepareHandoff(fingerprint: string): string;
  acknowledgeHandoff(fingerprint: string, id: string): void;
  refresh(workspaceId: string): Promise<void>;
  create(workspaceId: string, title: string, content?: string): Promise<PlanningDocument>;
  update(workspaceId: string, planId: string, patch: Partial<PlanningDocument>): Promise<void>;
}
const generations = new Map<string, number>();
export const usePlanningStore = create<PlanningState>()(persist((set, get) => ({
  plans: {}, activeByWorkspace: {}, groups: {}, widths: {}, chatHidden: {}, drafts: {}, sources: {}, handoffIds: {}, errors: {}, loading: {}, creating: false,
  setCreating: creating => set({ creating }),
  select: (workspaceId, planId) => set(state => ({ activeByWorkspace: { ...state.activeByWorkspace, [workspaceId]: planId } })),
  toggleGroup: (workspaceId, group) => set(state => { const key = `${workspaceId}:${group}`; return { groups: { ...state.groups, [key]: !state.groups[key] } }; }),
  setWidth: (workspaceId, width) => set(state => ({ widths: { ...state.widths, [workspaceId]: Math.max(320, Math.min(640, width)) } })),
  setChatHidden: (workspaceId, hidden) => set(state => ({ chatHidden: { ...state.chatHidden, [workspaceId]: hidden } })),
  setDraft: (key, draft) => set(state => ({ drafts: { ...state.drafts, [key]: draft } })),
  clearDraft: (key, expectedContent) => set(state => {
    if (expectedContent !== undefined && state.drafts[key]?.content !== expectedContent) return state;
    return { drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => id !== key)) };
  }),
  rememberSource: (target, id, source) => set(state => ({ sources: { ...state.sources, [`${target}:${id}`]: source } })),
  prepareHandoff: fingerprint => {
    const previous = get().handoffIds[fingerprint]; if (previous) return previous;
    const id = crypto.randomUUID(); set(state => ({ handoffIds: { ...state.handoffIds, [fingerprint]: id } })); return id;
  },
  acknowledgeHandoff: (fingerprint, id) => set(state => state.handoffIds[fingerprint] !== id ? state : { handoffIds: Object.fromEntries(Object.entries(state.handoffIds).filter(([key]) => key !== fingerprint)) }),
  refresh: async workspaceId => {
    const generation = (generations.get(workspaceId) || 0) + 1; generations.set(workspaceId, generation);
    set(state => ({ loading: { ...state.loading, [workspaceId]: true } }));
    try {
      const plans = await apiRequest<PlanningDocument[]>(planApi(workspaceId));
      if (generations.get(workspaceId) !== generation) return;
      set(state => ({ plans: { ...state.plans, [workspaceId]: plans }, errors: { ...state.errors, [workspaceId]: '' }, loading: { ...state.loading, [workspaceId]: false } }));
    } catch (error) {
      if (generations.get(workspaceId) === generation) set(state => ({ errors: { ...state.errors, [workspaceId]: error instanceof Error ? error.message : 'Could not load plans.' }, loading: { ...state.loading, [workspaceId]: false } }));
    }
  },
  create: async (workspaceId, title, content) => {
    const plan = await apiRequest<PlanningDocument>(`${planApi(workspaceId)}${content === undefined ? '' : '/import'}`, { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), title, ...(content === undefined ? {} : { content }) }) });
    generations.set(workspaceId, (generations.get(workspaceId) || 0) + 1);
    set(state => ({ plans: { ...state.plans, [workspaceId]: [plan, ...(state.plans[workspaceId] || [])] }, activeByWorkspace: { ...state.activeByWorkspace, [workspaceId]: plan.id }, creating: false, loading: { ...state.loading, [workspaceId]: false } }));
    return plan;
  },
  update: async (workspaceId, planId, patch) => {
    const plan = await apiRequest<PlanningDocument>(planApi(workspaceId, planId), { method: 'PATCH', body: JSON.stringify(patch) });
    generations.set(workspaceId, (generations.get(workspaceId) || 0) + 1);
    set(state => ({ plans: { ...state.plans, [workspaceId]: (state.plans[workspaceId] || []).map(item => item.id === plan.id ? plan : item) }, loading: { ...state.loading, [workspaceId]: false } }));
  },
}), {
  name: 'atris-planning-workspace', version: 1,
  partialize: ({ activeByWorkspace, groups, widths, chatHidden, drafts, sources, handoffIds }) => ({ activeByWorkspace, groups, widths, chatHidden, drafts, sources, handoffIds }),
}));
