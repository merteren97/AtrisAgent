import { create } from 'zustand';
import type { QuestionAsked } from '@atris-agent-code/event-schema';
import { apiRequest } from '@/lib/api-client';

export type QuestionStatus = 'pending' | 'delivering' | 'delivered' | 'accepted' | 'delivery_failed' | 'rejected' | 'cancelled' | 'stale';
export interface OrchestratorQuestion extends QuestionAsked {
  status: QuestionStatus;
  answers?: string[][];
  clientRequestId?: string;
  error?: string;
  updatedAt: string;
  acceptedAt?: string;
  deliveredAt?: string;
  providerAcceptedAt?: string;
}
export interface AnswerDraft { choices: string[]; custom: string; customSelected: boolean }
interface Submission { clientRequestId: string; action: 'reply' | 'cancel'; answers: string[][] }
interface QuestionState {
  byMission: Record<string, OrchestratorQuestion[]>;
  drafts: Record<string, AnswerDraft[]>;
  loading: Record<string, boolean>;
  busy: Record<string, boolean>;
  errors: Record<string, string | undefined>;
  submissions: Record<string, Submission>;
  load(missionId: string): Promise<void>;
  setDraft(missionId: string, questionId: string, index: number, draft: AnswerDraft): void;
  respond(missionId: string, questionId: string, action?: 'reply' | 'cancel'): Promise<void>;
}

export const questionKey = (missionId: string, questionId: string) => JSON.stringify([missionId, questionId]);
export function questionDraft(question: OrchestratorQuestion): AnswerDraft[] {
  return question.questions.map((info, index) => {
    const answers = question.answers?.[index] || [];
    const choices = answers.filter(answer => info.options.some(option => option.label === answer));
    const custom = answers.find(answer => !info.options.some(option => option.label === answer)) || '';
    return { choices, custom, customSelected: Boolean(custom) };
  });
}
export const isQuestionEditable = (question: OrchestratorQuestion) => ['pending', 'delivery_failed'].includes(question.status);

export const useQuestionStore = create<QuestionState>((set, get) => ({
  byMission: {}, drafts: {}, loading: {}, busy: {}, errors: {}, submissions: {},
  async load(missionId) {
    if (get().loading[missionId] || (get().byMission[missionId] || []).some(question => get().busy[questionKey(missionId, question.questionId)])) return;
    set(state => ({ loading: { ...state.loading, [missionId]: true } }));
    try {
      const { questions } = await apiRequest<{ questions: OrchestratorQuestion[] }>(`/missions/${encodeURIComponent(missionId)}/questions`);
      set(state => ({ byMission: { ...state.byMission, [missionId]: questions.map(question => {
        const current = state.byMission[missionId]?.find(item => item.questionId === question.questionId);
        // A GET started before an answer must not regress its newer POST/event state.
        return current && (state.busy[questionKey(missionId, question.questionId)] || current.updatedAt > question.updatedAt) ? current : question;
      }) }, errors: { ...state.errors, [missionId]: undefined } }));
    } catch (error) {
      set(state => ({ errors: { ...state.errors, [missionId]: error instanceof Error ? error.message : 'Could not reload questions.' } }));
    } finally { set(state => ({ loading: { ...state.loading, [missionId]: false } })); }
  },
  setDraft(missionId, questionId, index, draft) {
    const question = get().byMission[missionId]?.find(item => item.questionId === questionId);
    if (!question || !isQuestionEditable(question)) return;
    const key = questionKey(missionId, questionId);
    const drafts = [...(get().drafts[key] || questionDraft(question))];
    drafts[index] = draft;
    set(state => ({ drafts: { ...state.drafts, [key]: drafts }, errors: { ...state.errors, [key]: undefined } }));
  },
  async respond(missionId, questionId, action = 'reply') {
    const key = questionKey(missionId, questionId);
    const question = get().byMission[missionId]?.find(item => item.questionId === questionId);
    if (!question || get().busy[key] || !isQuestionEditable(question)) return;
    const drafts = get().drafts[key] || questionDraft(question);
    const answers = action === 'cancel' ? [] : drafts.map(draft => [...draft.choices, ...(draft.customSelected && draft.custom.trim() ? [draft.custom.trim()] : [])]);
    if (action === 'reply' && answers.some((answer, index) => !answer.length || (!question.questions[index].multiple && answer.length !== 1))) {
      set(state => ({ errors: { ...state.errors, [key]: 'Answer each question before sending.' } }));
      return;
    }
    const previous = get().submissions[key];
    const submission = previous?.action === action && JSON.stringify(previous.answers) === JSON.stringify(answers)
      ? previous : { action, answers, clientRequestId: action === 'reply' && question.clientRequestId && JSON.stringify(question.answers) === JSON.stringify(answers)
        ? question.clientRequestId : crypto.randomUUID() };
    set(state => ({ busy: { ...state.busy, [key]: true }, errors: { ...state.errors, [key]: undefined }, submissions: { ...state.submissions, [key]: submission } }));
    try {
      const reply = await apiRequest<{ accepted: boolean; delivered: boolean; providerAccepted: boolean; question: OrchestratorQuestion }>(
        `/missions/${encodeURIComponent(missionId)}/questions/${encodeURIComponent(questionId)}/${action}`,
        { method: 'POST', body: JSON.stringify({ answers, clientRequestId: submission.clientRequestId }) },
      );
      set(state => ({ byMission: { ...state.byMission, [missionId]: (state.byMission[missionId] || []).map(item => item.questionId === questionId ? reply.question : item) } }));
    } catch (error) {
      set(state => ({ errors: { ...state.errors, [key]: `${error instanceof Error ? error.message : 'Delivery could not be confirmed.'} Reload to check status, or retry the same response.` } }));
    } finally {
      set(state => ({ busy: { ...state.busy, [key]: false } }));
      await get().load(missionId);
    }
  },
}));
