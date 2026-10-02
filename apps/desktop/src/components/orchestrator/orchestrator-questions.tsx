import { useEffect, useId, useState } from 'react';
import { Check, HelpCircle, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMissionStore } from '@/stores/mission-store';
import { useAgentStore } from '@/stores/agent-store';
import { cn } from '@/lib/utils';
import {
  isQuestionEditable, questionDraft, questionKey, useQuestionStore,
  type OrchestratorQuestion, type QuestionStatus,
} from './question-store';

const labels: Record<QuestionStatus, string> = {
  pending: 'Waiting for your answer', delivering: 'Response saved · delivering',
  delivered: 'Delivered · awaiting provider confirmation', accepted: 'Answer accepted by provider',
  delivery_failed: 'Response saved · delivery failed', rejected: 'Question dismissed',
  cancelled: 'Question cancelled', stale: 'Originating session ended',
};

/** Standalone main-chat question surface. Parent places this above the timeline. */
export function OrchestratorQuestions({ className }: { className?: string }) {
  const missionId = useMissionStore(state => state.activeMissionId);
  const questions = useQuestionStore(state => missionId ? state.byMission[missionId] : undefined);
  const loading = useQuestionStore(state => missionId ? state.loading[missionId] : false);
  const error = useQuestionStore(state => missionId ? state.errors[missionId] : undefined);
  const load = useQuestionStore(state => state.load);
  useEffect(() => {
    if (!missionId) return;
    void load(missionId);
    const timer = window.setInterval(() => { if (!document.hidden) void load(missionId); }, 2_000);
    const refresh = () => { if (!document.hidden) void load(missionId); };
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [missionId, load]);
  if (!missionId) return null;
  if (!questions?.length && !error) return loading && !questions ? <p className="px-4 py-2 text-xs text-muted-foreground" role="status">Checking worker questions…</p> : null;
  const pending = (questions || []).filter(question => !['accepted', 'rejected', 'cancelled', 'stale'].includes(question.status));
  const resolved = (questions || []).filter(question => ['accepted', 'rejected', 'cancelled', 'stale'].includes(question.status));
  return (
    <section aria-label="Worker questions" className={cn('space-y-3 text-foreground', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><HelpCircle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />Worker questions{pending.length > 0 && <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{pending.length}</span>}</h2>
        <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void load(missionId)}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />Reload</Button>
      </div>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {pending.map(question => <QuestionCard key={questionKey(missionId, question.questionId)} question={question} />)}
      {resolved.length > 0 && <details className="rounded-lg border border-border bg-card px-4 py-3"><summary className="cursor-pointer text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Resolved questions ({resolved.length})</summary><div className="mt-3 space-y-3">{resolved.map(question => <QuestionCard key={question.questionId} question={question} />)}</div></details>}
    </section>
  );
}

function QuestionCard({ question }: { question: OrchestratorQuestion }) {
  const worker = useAgentStore(state => state.agents.find(agent => agent.id === question.agentInstanceId));
  const task = useMissionStore(state => state.activeTasks.find(item => item.id === question.taskId));
  const id = useId();
  const key = questionKey(question.missionId, question.questionId);
  const savedDrafts = useQuestionStore(state => state.drafts[key]);
  const busy = useQuestionStore(state => state.busy[key]);
  const error = useQuestionStore(state => state.errors[key]);
  const setDraft = useQuestionStore(state => state.setDraft);
  const respond = useQuestionStore(state => state.respond);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const editable = isQuestionEditable(question) && !busy;
  const drafts = savedDrafts || questionDraft(question);
  const ready = drafts.every(draft => draft.choices.length > 0 || (draft.customSelected && draft.custom.trim().length > 0));
  return (
    <article aria-labelledby={`${id}-title`} aria-busy={Boolean(busy)} className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><h3 id={`${id}-title`} className="text-sm font-semibold">{question.questions[0]?.header || 'Your team needs information'}</h3><p className="mt-1 break-words text-xs text-muted-foreground">{worker?.displayName || (question.adapterId === 'opencode' ? 'OpenCode' : question.adapterId)} · {task?.title || (question.taskId.startsWith('turn-') ? 'Coordinator' : 'Delegated task')}</p></div>
        <p role="status" className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">{busy || question.status === 'delivering' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : question.status === 'accepted' ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}{busy ? 'Saving and delivering response…' : labels[question.status]}</p>
      </div>
      {editable || busy ? (
        <form onSubmit={event => { event.preventDefault(); void respond(question.missionId, question.questionId); }} className="space-y-4">
          {question.questions.map((info, index) => {
            const draft = drafts[index];
            const change = (choices: string[], customSelected = draft.customSelected) => setDraft(question.missionId, question.questionId, index, { ...draft, choices, customSelected });
            return <fieldset key={index} disabled={!editable} className="min-w-0 space-y-2">
              <legend className="mb-2 whitespace-pre-wrap break-words text-sm font-medium leading-6">{info.question}</legend>
              {info.multiple && <p className="text-xs text-muted-foreground">Choose one or more answers.</p>}
              <div className="grid gap-2 sm:grid-cols-2">
                {info.options.map((option, optionIndex) => <label key={optionIndex} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring', draft.choices.includes(option.label) ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-accent')}>
                  <input type={info.multiple ? 'checkbox' : 'radio'} name={`${id}-${index}`} checked={draft.choices.includes(option.label)} className="mt-1 accent-primary" onChange={event => change(info.multiple ? event.target.checked ? [...draft.choices, option.label] : draft.choices.filter(choice => choice !== option.label) : [option.label], info.multiple ? draft.customSelected : false)} />
                  <span className="min-w-0 break-words"><span className="block font-medium">{option.label}</span>{option.description && <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>}</span>
                </label>)}
              </div>
              {info.custom !== false && <div className="rounded-lg border border-border p-3">
                <label className="flex cursor-pointer items-center gap-2.5 text-sm"><input type={info.multiple ? 'checkbox' : 'radio'} name={`${id}-${index}`} checked={draft.customSelected} className="accent-primary" onChange={event => change(info.multiple ? draft.choices : [], event.target.checked)} />Custom answer</label>
                {draft.customSelected && <><label htmlFor={`${id}-custom-${index}`} className="sr-only">Custom answer: {info.question}</label><textarea id={`${id}-custom-${index}`} rows={3} maxLength={16000} value={draft.custom} onChange={event => setDraft(question.missionId, question.questionId, index, { ...draft, custom: event.target.value })} className="mt-3 block w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Tell the worker how to proceed…" /></>}
              </div>}
            </fieldset>;
          })}
          {(error || question.error) && <p role="alert" className="break-words text-sm text-destructive">{error || question.error}</p>}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button type="submit" size="sm" disabled={!editable || !ready}>{question.status === 'delivery_failed' || error ? 'Retry response' : 'Send answer'}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={!editable} onClick={() => setConfirmCancel(!confirmCancel)}>Dismiss question</Button>
            <span className="text-xs text-muted-foreground">Answers provide information; they do not approve actions.</span>
          </div>
          {confirmCancel && <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-3 text-xs"><span>Dismiss without an answer? The worker may stop or ask again.</span><Button type="button" variant="outline" size="sm" disabled={!editable} onClick={() => { setConfirmCancel(false); void respond(question.missionId, question.questionId, 'cancel'); }}>Confirm dismissal</Button><Button type="button" variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>Keep question</Button></div>}
        </form>
      ) : <div className="space-y-2 text-sm">{question.questions.map((info, index) => <div key={index}><p className="whitespace-pre-wrap break-words font-medium">{info.question}</p>{question.answers?.[index]?.length ? <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{question.answers[index].join(' · ')}</p> : null}</div>)}{question.error && <p className="break-words text-xs text-muted-foreground">{question.error}</p>}{question.status === 'stale' && <p className="text-xs text-muted-foreground">Retry the task to open a new worker session.</p>}</div>}
    </article>
  );
}
