import { useEffect, useState } from 'react';
import { HelpCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ManualQuestion } from '@/stores/manual-store';

const QUESTION_DRAFTS_STORAGE_KEY = 'atris-manual-question-drafts-v2';
const MAX_STORED_QUESTION_DRAFTS = 60;
const memoryQuestionDrafts = new Map<string, string[][]>();

function questionDraftKey(scope: string, request: ManualQuestion): string {
  return JSON.stringify([scope, request.id, request.questions.map(q => [q.question, Boolean(q.multiple), Boolean(q.custom), q.options.map(o => o.label)])]);
}

function readPersistedDraftMap(): Record<string, string[][]> {
  try {
    if (typeof globalThis.localStorage === 'undefined') return {};
    const raw = globalThis.localStorage.getItem(QUESTION_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, string[][]>
      : {};
  } catch {
    return {};
  }
}

function writePersistedDraftMap(entries: Record<string, string[][]>): void {
  try {
    if (typeof globalThis.localStorage === 'undefined') return;
    const keys = Object.keys(entries);
    const trimmed = keys.length > MAX_STORED_QUESTION_DRAFTS
      ? Object.fromEntries(keys.slice(keys.length - MAX_STORED_QUESTION_DRAFTS).map(k => [k, entries[k]]))
      : entries;
    globalThis.localStorage.setItem(QUESTION_DRAFTS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota or private-mode errors; in-memory map still preserves drafts across tab switches.
  }
}

function isValidDraftForRequest(candidate: unknown, questionCount: number): candidate is string[][] {
  return (
    Array.isArray(candidate)
    && candidate.length === questionCount
    && candidate.every(item => Array.isArray(item) && item.every(val => typeof val === 'string'))
  );
}

export function getSavedQuestionDraft(request: ManualQuestion, scope: string): string[][] {
  const count = request.questions.length;
  const key = questionDraftKey(scope, request);
  const fromMemory = memoryQuestionDrafts.get(key);
  if (isValidDraftForRequest(fromMemory, count)) {
    return fromMemory.map(items => [...items]);
  }
  const persisted = readPersistedDraftMap();
  const fromStorage = persisted[key];
  if (isValidDraftForRequest(fromStorage, count)) {
    return fromStorage.map(items => [...items]);
  }
  return request.questions.map(() => []);
}

export function saveQuestionDraft(request: ManualQuestion, answers: string[][], scope: string): void {
  const copy = answers.map(items => [...items]);
  const key = questionDraftKey(scope, request);
  memoryQuestionDrafts.delete(key);
  memoryQuestionDrafts.set(key, copy);
  if (memoryQuestionDrafts.size > MAX_STORED_QUESTION_DRAFTS) memoryQuestionDrafts.delete(memoryQuestionDrafts.keys().next().value!);
  const persisted = readPersistedDraftMap();
  delete persisted[key];
  persisted[key] = copy;
  writePersistedDraftMap(persisted);
}

export function clearSavedQuestionDraft(request: ManualQuestion, scope: string): void {
  const key = questionDraftKey(scope, request);
  memoryQuestionDrafts.delete(key);
  const persisted = readPersistedDraftMap();
  delete persisted[key];
  writePersistedDraftMap(persisted);
}

export function buildAntigravityQuestionKeystrokes(question: ManualQuestion, answers: string[][]): string[] {
  const steps: string[] = [];
  for (let qIdx = 0; qIdx < question.questions.length; qIdx += 1) {
    const entry = question.questions[qIdx];
    const selected = answers[qIdx] || [];
    if (!entry.multiple) {
      const chosen = selected[0] || '';
      const optionIndex = entry.options.findIndex(opt => opt.label === chosen);
      if (optionIndex >= 0) {
        steps.push('\u001b[B'.repeat(optionIndex) + '\r');
      } else {
        steps.push('\u001b[B'.repeat(entry.options.length) + '\r');
        steps.push(chosen.replace(/[\r\n]+/g, ' ') + '\r');
      }
      continue;
    }

    const optionIndices = entry.options
      .map((opt, idx) => (selected.includes(opt.label) ? idx : -1))
      .filter(idx => idx >= 0);
    const custom = selected.find(val => !entry.options.some(opt => opt.label === val));
    let pos = 0;
    for (const idx of optionIndices) {
      steps.push('\u001b[B'.repeat(idx - pos) + ' ');
      pos = idx;
    }
    if (custom) {
      steps.push('\u001b[B'.repeat(entry.options.length - pos) + '\r');
      steps.push(custom.replace(/[\r\n]+/g, ' ') + '\r');
      pos = entry.options.length;
    }
    steps.push('\r');
  }
  return steps;
}

export function ManualQuestionCard({
  draftScope,
  request,
  onReply,
  onOpenCode,
}: {
  draftScope: string;
  request: ManualQuestion;
  onReply?: (answers: string[][]) => Promise<void>;
  onOpenCode?: () => void;
}) {
  const draftKey = questionDraftKey(draftScope, request);
  const [answers, setAnswers] = useState<string[][]>(() => getSavedQuestionDraft(request, draftScope));
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setAnswers(getSavedQuestionDraft(request, draftScope));
    setSubmitted(false);
    setError(undefined);
  }, [draftKey]);

  useEffect(() => {
    if (!submitted || request.deliveryError) return;
    const timer = setTimeout(() => {
      setSubmitted(false);
      setError('Answer was sent, but the prompt is still open. Retry or switch to Code.');
    }, 8000);
    return () => clearTimeout(timer);
  }, [submitted, request.deliveryError]);

  const updateAnswers = (updater: (previous: string[][]) => string[][]) => {
    const next = updater(answers);
    setAnswers(next);
    saveQuestionDraft(request, next, draftScope);
  };

  const choose = (index: number, label: string, multiple?: boolean) =>
    updateAnswers(previous =>
      previous.map((selected, at) =>
        at !== index
          ? selected
          : multiple
            ? selected.includes(label)
              ? selected.filter(value => value !== label)
              : [...selected, label]
            : [label]
      )
    );

  return (
    <section aria-label="Agent question" className="rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-primary">
        <HelpCircle className="h-4 w-4" />
        Agent needs your answer
      </div>
      {request.questions.map((entry, index) => {
        const selected = answers[index] || [];
        const stepHeader = entry.header || (request.questions.length > 1 ? `Question ${index + 1}/${request.questions.length}` : '');
        const customValue = selected.find(value => !entry.options.some(option => option.label === value)) || '';

        return (
          <fieldset key={index} disabled={!onReply || busy || (submitted && !request.deliveryError)} className="mb-4 last:mb-2">
            {(stepHeader || entry.multiple) && (
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {stepHeader && <span>{stepHeader}</span>}
                {entry.multiple && (
                  <span className="rounded-md border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-foreground/80">
                    Multiple choice · Select all that apply
                  </span>
                )}
              </div>
            )}
            <legend className="mb-2 text-sm font-medium">{entry.question}</legend>
            <div className="grid gap-1.5">
              {entry.options.map(option => {
                const isSelected = selected.includes(option.label);
                return (
                  <label
                    key={option.label}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      isSelected
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-background/60 hover:border-primary/50'
                    }`}
                  >
                    <input
                      type={entry.multiple ? 'checkbox' : 'radio'}
                      name={`${request.id}-${index}`}
                      checked={isSelected}
                      onChange={() => choose(index, option.label, entry.multiple)}
                      className="mt-0.5 accent-primary"
                    />
                    <span>
                      {option.label}
                      {option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            {entry.custom !== false && (
              <input
                type="text"
                aria-label={`Custom answer for ${entry.question}`}
                placeholder="Write-in… (or type your own answer)"
                maxLength={2000}
                value={customValue}
                onChange={event =>
                  updateAnswers(previous =>
                    previous.map((current, at) =>
                      at !== index
                        ? current
                        : entry.multiple
                          ? [
                              ...current.filter(value => entry.options.some(option => option.label === value)),
                              ...(event.target.value ? [event.target.value] : []),
                            ]
                          : event.target.value
                            ? [event.target.value]
                            : []
                    )
                  )
                }
                className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
          </fieldset>
        );
      })}
      {(error || request.deliveryError) && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {error || request.deliveryError}
        </p>
      )}
      <div className="flex items-center gap-2">
        {onReply && (
          <Button
            type="button"
            size="sm"
            disabled={busy || (submitted && !request.deliveryError) || answers.some(answer => !answer.some(value => value.trim()))}
            onClick={() => {
              const cleaned = answers.map(group => group.map(value => value.trim()).filter(Boolean));
              setBusy(true);
              setError(undefined);
              void onReply(cleaned)
                .then(() => {
                  clearSavedQuestionDraft(request, draftScope);
                  setSubmitted(true);
                })
                .catch(e => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {submitted && !request.deliveryError ? 'Delivering…' : (error || request.deliveryError) ? 'Retry answer' : 'Submit answers'}
          </Button>
        )}
        {onOpenCode && (
          <Button type="button" size="sm" variant="ghost" onClick={onOpenCode}>
            Answer in Code
          </Button>
        )}
      </div>
    </section>
  );
}
