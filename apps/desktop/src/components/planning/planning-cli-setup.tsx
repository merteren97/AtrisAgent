import { useMemo, useState } from 'react';
import { ArrowRight, Check, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RuntimeBrandIcon, RUNTIME_BRANDS } from '@/components/runtime/runtime-brand-icon';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { RuntimeType } from '@atris-agent-code/domain';

export const planningCliName = (runtime: string) => ({ codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity', claude_code: 'Claude Code' }[runtime] || runtime);
export function PlanningCliSetup({ onCreate, onCancel, initialRuntime = 'codex' }: { onCreate: (model: DiscoveredModel, reasoning?: string) => Promise<void>; onCancel?: () => void; initialRuntime?: RuntimeType }) {
  const models = useAccountStore(state => state.discoveredModels);
  const [runtime, setRuntime] = useState<RuntimeType>(initialRuntime);
  const [catalogId, setCatalogId] = useState(''); const [reasoning, setReasoning] = useState('');
  const [query, setQuery] = useState(''); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const options = useMemo(() => models.filter(model => model.runtimeType === runtime && model.available && model.availability === 'available' && model.source !== 'cached'), [models, runtime]);
  const selected = options.find(model => model.catalogId === catalogId) || options[0];
  const visible = options.filter(model => `${model.name} ${model.accountName}`.toLowerCase().includes(query.toLowerCase()));
  const submit = async () => {
    if (!selected || pending) return;
    setPending(true); setError('');
    try { await onCreate(selected, reasoning || selected.defaultReasoning || selected.supportedReasoning[0]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <form aria-label="Choose planning CLI" className="flex min-h-0 flex-col" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="min-h-0 space-y-5 overflow-y-auto p-1">
      <fieldset disabled={pending}><legend className="mb-3 text-xs font-semibold text-muted-foreground">1. Choose your CLI</legend><div className="grid grid-cols-2 gap-2">{RUNTIME_BRANDS.map(provider => {
        const count = models.filter(model => model.runtimeType === provider.id && model.available && model.availability === 'available' && model.source !== 'cached').length;
        return <label key={provider.id} className={`relative flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3.5 transition-colors focus-within:ring-2 focus-within:ring-ring ${runtime === provider.id ? 'border-primary/60 bg-primary/[0.06]' : 'border-border bg-card hover:bg-accent/40'}`}>
          <input type="radio" name="planning-cli" className="sr-only" checked={runtime === provider.id} onChange={() => { setRuntime(provider.id); setCatalogId(''); setReasoning(''); setQuery(''); }} value={provider.id} />
          <RuntimeBrandIcon runtimeId={provider.id} className="h-6 w-6 shrink-0 text-foreground" /><span className="min-w-0"><span className="block truncate text-xs font-semibold">{planningCliName(provider.id)}</span><span className="mt-1 block text-[10px] text-muted-foreground">{count ? `${count} model${count === 1 ? '' : 's'}` : 'Connect in Accounts'}</span></span>{runtime === provider.id && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-primary" />}
        </label>;
      })}</div></fieldset>
      <fieldset disabled={pending}><legend className="mb-2 text-xs font-semibold text-muted-foreground">2. Choose a model</legend>
        {options.length > 4 && <div className="relative mb-2"><Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input aria-label="Search planning models" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models or accounts…" className="h-9 pl-9 text-xs" /></div>}
        <div role="radiogroup" aria-label="Planning CLI models" className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-border bg-card p-1">{visible.map(model => <label key={model.catalogId} className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50 ${selected?.catalogId === model.catalogId ? 'bg-primary/[0.06]' : ''}`}><input type="radio" name="planning-cli-model" value={model.catalogId} checked={selected?.catalogId === model.catalogId} onChange={() => { setCatalogId(model.catalogId); setReasoning(''); }} className="accent-primary" /><span className="min-w-0"><span className="block truncate text-xs font-medium">{model.name}</span><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{model.accountName}</span></span></label>)}{!visible.length && <div className="p-3 text-xs leading-5 text-muted-foreground">{options.length ? 'No matching models.' : 'Connect or verify this CLI account to load its models.'}{!options.length && <Button type="button" variant="link" size="sm" className="mt-1 block h-7 px-0 text-xs" onClick={() => useSettingsStore.getState().setActiveView('accounts')}>Open Accounts</Button>}</div>}</div>
      </fieldset>
      {!!selected?.supportedReasoning.length && <fieldset disabled={pending}><legend className="mb-2 text-xs font-semibold text-muted-foreground">Reasoning level</legend><div className="flex flex-wrap gap-1.5">{selected.supportedReasoning.map(level => <Button key={level} type="button" variant={(reasoning || selected.defaultReasoning || selected.supportedReasoning[0]) === level ? 'secondary' : 'outline'} size="sm" className="h-7 px-2.5 text-[11px] capitalize" aria-pressed={(reasoning || selected.defaultReasoning || selected.supportedReasoning[0]) === level} onClick={() => setReasoning(level)}>{level}</Button>)}</div></fieldset>}
      {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs leading-5 text-destructive">{error}</p>}
    </div>
    <div className="mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-border pt-4">{onCancel && <Button variant="ghost" size="sm" type="button" disabled={pending} onClick={onCancel}>Cancel</Button>}<Button type="submit" size="sm" className="rounded-lg" disabled={!selected || pending}>{pending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="mr-2 h-3.5 w-3.5" />}Start chat</Button></div>
  </form>;
}
