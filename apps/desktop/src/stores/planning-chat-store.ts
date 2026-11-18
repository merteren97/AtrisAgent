import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CodexPermissionMode, RuntimeType } from '@atris-agent-code/domain';
import type { ManualQuestion, ManualToolItem } from '@/stores/manual-store';

export interface PlanningConversation {
  id: string; title: string; workspaceId: string; planId: string;
  runtimeType: RuntimeType; catalogId: string; model: string; accountProfileId: string;
  reasoning?: string; createdAt: string; updatedAt: string; closedAt: string | null;
  codexPermissionMode: CodexPermissionMode; openCodeAutoApprove: boolean;
}
export interface PlanningChatInput { id: string; text: string; catalogId: string; reasoning?: string; attachmentPaths?: string[] }
export interface PlanningChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; content: string; turnId: string;
  createdAt: string; clientMessageId?: string; partial?: boolean; attachmentPaths?: string[];
  thinking?: string; thinkingTokens?: number; tools?: ManualToolItem[];
}
export interface PlanningChatProposal {
  id: string; turnId: string; path: string; content: string; baseRevision: string | null;
  status: 'pending' | 'applied' | 'conflict'; revision?: string; error?: string;
}
export interface PlanningChatState {
  messages: PlanningChatMessage[]; proposals: PlanningChatProposal[];
  status: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  turnId: string | null; revision: number; error?: string; activity?: string;
  conversation?: PlanningConversation;
  approvals?: Array<{ id: string; turnId: string; toolName?: string; description: string; path?: string; command?: string; status?: 'pending' | 'replying' | 'failed'; error?: string }>;
  questions?: ManualQuestion[];
}
interface PlanPreferences {
  draft: string; catalogId: string; reasoning: string;
  editContext?: string;
  /** Unacknowledged requests survive timeouts, plan switches, and app restarts. */
  attempts: PlanningChatInput[];
}
export const EMPTY_PLANNING_CHAT: PlanPreferences = { draft: '', catalogId: '', reasoning: '', attempts: [] };
export const planningChatKey = (workspaceId: string, planId: string, conversationId?: string) => JSON.stringify(conversationId && conversationId !== 'default' ? [workspaceId, planId, conversationId] : [workspaceId, planId]);

interface PlanningChatStore {
  plans: Record<string, PlanPreferences>;
  activeByPlan: Record<string, string>;
  creations: Record<string, string>;
  files: Record<string, File[]>;
  staged: Record<string, Array<{ file: File; path: string }>>;
  select: (key: string, conversationId: string) => void;
  prepareCreation: (fingerprint: string) => string;
  acknowledgeCreation: (fingerprint: string, id: string) => void;
  updateFiles: (key: string, update: (files: File[]) => File[]) => void;
  stageFile: (key: string, file: File, path: string) => void;
  clearSentFiles: (key: string, files: File[]) => void;
  update: (key: string, patch: Partial<Pick<PlanPreferences, 'draft' | 'catalogId' | 'reasoning' | 'editContext'>>) => void;
  setEditContext: (key: string, context: string) => void;
  prepare: (key: string, text: string, catalogId: string, reasoning?: string, attachmentPaths?: string[]) => PlanningChatInput;
  acknowledge: (key: string, input: PlanningChatInput) => void;
}

export const usePlanningChatStore = create<PlanningChatStore>()(persist((set, get) => ({
  plans: {}, activeByPlan: {}, creations: {}, files: {}, staged: {},
  select: (key, conversationId) => set(state => ({ activeByPlan: { ...state.activeByPlan, [key]: conversationId } })),
  prepareCreation: fingerprint => { const previous = get().creations[fingerprint]; if (previous) return previous; const id = crypto.randomUUID(); set(state => ({ creations: { ...state.creations, [fingerprint]: id } })); return id; },
  acknowledgeCreation: (fingerprint, id) => set(state => state.creations[fingerprint] !== id ? state : { creations: Object.fromEntries(Object.entries(state.creations).filter(([key]) => key !== fingerprint)) }),
  updateFiles: (key, update) => set(state => { const files = update(state.files[key] || []); return { files: { ...state.files, [key]: files }, staged: { ...state.staged, [key]: (state.staged[key] || []).filter(item => files.includes(item.file)) } }; }),
  stageFile: (key, file, path) => set(state => ({ staged: { ...state.staged, [key]: [...(state.staged[key] || []).filter(item => item.file !== file), { file, path }] } })),
  clearSentFiles: (key, sent) => set(state => ({ files: { ...state.files, [key]: (state.files[key] || []).filter(file => !sent.includes(file)) }, staged: { ...state.staged, [key]: (state.staged[key] || []).filter(item => !sent.includes(item.file)) } })),
  update: (key, patch) => set(state => ({ plans: {
    ...state.plans, [key]: { ...(state.plans[key] || EMPTY_PLANNING_CHAT), ...patch },
  } })),
  setEditContext: (key, context) => set(state => {
    const plan = state.plans[key] || EMPTY_PLANNING_CHAT;
    const text = plan.editContext && plan.draft.startsWith(plan.editContext) ? plan.draft.slice(plan.editContext.length) : plan.draft;
    return { plans: { ...state.plans, [key]: { ...plan, draft: `${context}${text}`, editContext: context } } };
  }),
  prepare: (key, rawText, catalogId, reasoning, attachmentPaths = []) => {
    const text = rawText.trim();
    const plan = get().plans[key] || EMPTY_PLANNING_CHAT;
    const previous = plan.attempts.find(item => item.text === text && item.catalogId === catalogId && item.reasoning === reasoning && JSON.stringify(item.attachmentPaths || []) === JSON.stringify(attachmentPaths));
    if (previous) return previous;
    const input = { id: crypto.randomUUID(), text, catalogId, ...(reasoning ? { reasoning } : {}), ...(attachmentPaths.length ? { attachmentPaths: [...attachmentPaths] } : {}) };
    set(state => ({ plans: { ...state.plans, [key]: { ...plan, attempts: [...plan.attempts, input] } } }));
    return input;
  },
  acknowledge: (key, input) => set(state => {
    const plan = state.plans[key] || EMPTY_PLANNING_CHAT;
    return { plans: { ...state.plans, [key]: {
      ...plan,
      // A response for an older request must never erase a newer draft.
      draft: plan.draft.trim() === input.text ? '' : plan.draft,
      attempts: plan.attempts.filter(item => item.id !== input.id),
    } } };
  }),
}), { name: 'atris-planning-chat-v1', partialize: ({ plans, activeByPlan, creations }) => ({ plans, activeByPlan, creations }) }));

/** Hide update payloads, including an unfinished streaming fence/header. */
export function planningChatDisplayText(content: string): string {
  let hidden = false;
  const lines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (hidden) {
      if (/^```\s*$/.test(line)) hidden = false;
      continue;
    }
    if (/^```atris-plan-update\b/.test(line)) { hidden = true; continue; }
    lines.push(line);
  }
  // Partial language tags arrive before the JSON. Avoid briefly showing them.
  const last = lines[lines.length - 1];
  if (last && last.startsWith('```a') && '```atris-plan-update'.startsWith(last.trimEnd())) lines.pop();
  return lines.join('\n').trim();
}
