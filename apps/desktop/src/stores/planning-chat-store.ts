import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PlanningChatInput { id: string; text: string; catalogId: string; reasoning?: string }
export interface PlanningChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; content: string; turnId: string;
  createdAt: string; clientMessageId?: string; partial?: boolean;
}
export interface PlanningChatProposal {
  id: string; turnId: string; path: string; content: string; baseRevision: string | null;
  status: 'pending' | 'applied' | 'conflict'; revision?: string; error?: string;
}
export interface PlanningChatState {
  messages: PlanningChatMessage[]; proposals: PlanningChatProposal[];
  status: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  turnId: string | null; revision: number; error?: string; activity?: string;
}
interface PlanPreferences {
  draft: string; catalogId: string; reasoning: string;
  /** Unacknowledged requests survive timeouts, plan switches, and app restarts. */
  attempts: PlanningChatInput[];
}
export const EMPTY_PLANNING_CHAT: PlanPreferences = { draft: '', catalogId: '', reasoning: '', attempts: [] };
export const planningChatKey = (workspaceId: string, planId: string) => JSON.stringify([workspaceId, planId]);

interface PlanningChatStore {
  plans: Record<string, PlanPreferences>;
  update: (key: string, patch: Partial<Pick<PlanPreferences, 'draft' | 'catalogId' | 'reasoning'>>) => void;
  prepare: (key: string, text: string, catalogId: string, reasoning?: string) => PlanningChatInput;
  acknowledge: (key: string, input: PlanningChatInput) => void;
}

export const usePlanningChatStore = create<PlanningChatStore>()(persist((set, get) => ({
  plans: {},
  update: (key, patch) => set(state => ({ plans: {
    ...state.plans, [key]: { ...(state.plans[key] || EMPTY_PLANNING_CHAT), ...patch },
  } })),
  prepare: (key, rawText, catalogId, reasoning) => {
    const text = rawText.trim();
    const plan = get().plans[key] || EMPTY_PLANNING_CHAT;
    const previous = plan.attempts.find(item => item.text === text && item.catalogId === catalogId && item.reasoning === reasoning);
    if (previous) return previous;
    const input = { id: crypto.randomUUID(), text, catalogId, ...(reasoning ? { reasoning } : {}) };
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
}), { name: 'atris-planning-chat-v1' }));

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
