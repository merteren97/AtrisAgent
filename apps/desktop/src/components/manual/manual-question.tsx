import { useState } from 'react';
import { HelpCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ManualQuestion } from '@/stores/manual-store';

export function ManualQuestionCard({ request, onReply, onOpenCode }: { request: ManualQuestion; onReply?: (answers: string[][]) => Promise<void>; onOpenCode: () => void }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [busy, setBusy] = useState(false); const [submitted, setSubmitted] = useState(false); const [error, setError] = useState<string>();
  const choose = (index: number, label: string, multiple?: boolean) => setAnswers(previous => previous.map((selected, at) => at !== index ? selected : multiple ? selected.includes(label) ? selected.filter(value => value !== label) : [...selected, label] : [label]));
  return <section aria-label="Agent question" className="rounded-xl border border-primary/30 bg-primary/5 p-4">
    <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-primary"><HelpCircle className="h-4 w-4" />Agent needs your answer</div>
    {request.questions.map((entry, index) => <fieldset key={index} disabled={!onReply || busy || (submitted && !request.deliveryError)} className="mb-4 last:mb-2">
      <legend className="mb-2 text-sm font-medium">{entry.question}</legend>
      {entry.header && <p className="mb-2 text-xs text-muted-foreground">{entry.header}{entry.multiple ? ' · Select multiple' : ''}</p>}
      <div className="grid gap-1.5">{entry.options.map(option => <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm hover:border-primary/50"><input type={entry.multiple ? 'checkbox' : 'radio'} name={`${request.id}-${index}`} checked={answers[index].includes(option.label)} onChange={() => choose(index, option.label, entry.multiple)} className="mt-0.5 accent-primary" /><span>{option.label}{option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}</span></label>)}</div>
      {entry.custom !== false && <input type="text" aria-label={`Custom answer for ${entry.question}`} placeholder="Type your own answer…" maxLength={2000} value={answers[index].find(value => !entry.options.some(option => option.label === value)) || ''} onChange={event => setAnswers(previous => previous.map((selected, at) => at !== index ? selected : entry.multiple ? [...selected.filter(value => entry.options.some(option => option.label === value)), ...(event.target.value ? [event.target.value] : [])] : event.target.value ? [event.target.value] : []))} className="mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
    </fieldset>)}
    {(error || request.deliveryError) && <p role="alert" className="mb-2 text-xs text-destructive">{error || request.deliveryError}</p>}
    <div className="flex items-center gap-2">{onReply && <Button type="button" size="sm" disabled={busy || (submitted && !request.deliveryError) || answers.some(answer => !answer.length)} onClick={() => { setBusy(true); setError(undefined); void onReply(answers).then(() => setSubmitted(true)).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false)); }}>{busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}{submitted && !request.deliveryError ? 'Delivering…' : request.deliveryError ? 'Retry answer' : 'Submit answers'}</Button>}<Button type="button" size="sm" variant="ghost" onClick={onOpenCode}>Answer in Code</Button></div>
  </section>;
}
