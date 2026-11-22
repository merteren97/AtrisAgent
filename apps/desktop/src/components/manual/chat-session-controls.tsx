import { useEffect, useState } from 'react';
import { ChevronDown, Search, Sparkles } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RuntimeBrandIcon, RUNTIME_BRANDS } from '@/components/runtime/runtime-brand-icon';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import type { ManualAgent } from '@/stores/manual-store';

const defaultEffort = (model?: DiscoveredModel) => model?.defaultReasoning || model?.supportedReasoning?.[0];
const providerLabel = (id: string) => ({ claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' } as Record<string, string>)[id] || id;
const pickDefaultModel = (items: DiscoveredModel[], preferredCatalogId?: string) =>
  items.find(model => model.catalogId === preferredCatalogId)
  || items.find(model => model.available && model.availability === 'available' && model.supportedReasoning?.length)
  || items.find(model => model.available && model.availability === 'available')
  || items[0];

export type ChatControlAgent = Pick<ManualAgent, 'id' | 'catalogId' | 'runtimeType' | 'accountProfileId' | 'model' | 'reasoning'>;

export function ChatSessionControls({ agent, agents, pending, onApply }: { agent: ChatControlAgent; agents: readonly unknown[]; pending: boolean; onApply: (model: DiscoveredModel, independent: boolean, reasoning?: string) => Promise<boolean> }) {
  const models = useAccountStore(state => state.discoveredModels);
  const current = models.find(model => model.catalogId === agent.catalogId);
  const [expanded, setExpanded] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [runtime, setRuntime] = useState(agent.runtimeType);
  const [chosen, setChosen] = useState(agent.catalogId);
  const [query, setQuery] = useState('');
  const [reasoning, setReasoning] = useState(agent.reasoning || defaultEffort(current));
  const [applying, setApplying] = useState(false);
  const currentCatalogId = current?.catalogId;
  const currentDefaultEffort = defaultEffort(current);
  useEffect(() => {
    if (expanded) return;
    setRuntime(agent.runtimeType);
    setChosen(agent.catalogId);
    setReasoning(agent.reasoning || currentDefaultEffort);
  }, [agent.catalogId, agent.reasoning, agent.runtimeType, currentCatalogId, currentDefaultEffort, expanded]);

  const selected = models.find(model => model.catalogId === chosen && model.runtimeType === runtime);
  const effort = selected?.supportedReasoning?.some(level => level === reasoning) ? reasoning : defaultEffort(selected);
  const currentEffort = current?.supportedReasoning?.some(level => level === agent.reasoning) ? agent.reasoning : defaultEffort(current);
  const options = models.filter(model => model.runtimeType === runtime && `${model.name} ${model.accountName}`.toLowerCase().includes(query.toLowerCase()));
  const busy = pending || applying;
  const independent = Boolean(selected && (selected.runtimeType !== agent.runtimeType || selected.accountProfileId !== agent.accountProfileId));
  const unchanged = Boolean(selected && !independent && selected.catalogId === agent.catalogId && (effort || undefined) === (agent.reasoning || currentDefaultEffort || undefined));
  const canApplySelected = Boolean(selected && !busy && selected.available && selected.availability === 'available' && !unchanged && (!independent || agents.length < 30));

  const apply = async (model: DiscoveredModel, level?: string) => {
    if (busy || !model.available || model.availability !== 'available') return;
    const isIndependent = model.runtimeType !== agent.runtimeType || model.accountProfileId !== agent.accountProfileId;
    if (isIndependent && agents.length >= 30) return;
    const appliedLevel = model.supportedReasoning?.length ? (level || defaultEffort(model)) : undefined;
    if (!isIndependent && model.catalogId === agent.catalogId && appliedLevel === (agent.reasoning || currentDefaultEffort)) return;
    setApplying(true);
    try {
      const ok = await onApply(model, isIndependent, appliedLevel);
      if (ok) {
        setExpanded(false);
        setEffortMenuOpen(false);
      } else {
        setChosen(agent.catalogId);
        setReasoning(agent.reasoning || currentDefaultEffort);
      }
    } finally { setApplying(false); }
  };

  return <div className="flex min-w-0 items-center gap-1">
    <Popover.Root open={expanded} onOpenChange={open => {
      setExpanded(open);
      if (open) {
        setRuntime(agent.runtimeType);
        setChosen(agent.catalogId);
        setReasoning(agent.reasoning || currentDefaultEffort);
        setQuery('');
      }
    }}>
      <Popover.Trigger asChild>
        <Button type="button" variant={expanded ? 'secondary' : 'ghost'} size="sm" className="max-w-56 gap-2 text-xs text-muted-foreground" aria-label={`Choose CLI and model: ${current?.name || agent.model}`}><RuntimeBrandIcon runtimeId={agent.runtimeType} className="h-4 w-4 shrink-0" /><span className="truncate">{current?.name || agent.model}</span>{!current?.supportedReasoning?.length && agent.reasoning && <span className="text-[10px] capitalize opacity-70">· {agent.reasoning}</span>}<ChevronDown className="h-3 w-3 shrink-0" /></Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={12} collisionPadding={16} aria-label="CLI and model settings" className="z-[120] flex max-h-[min(540px,var(--radix-popover-content-available-height))] w-[min(580px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none">
          <h3 className="mb-3 shrink-0 text-sm font-semibold">Model & CLI</h3>
          <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">{RUNTIME_BRANDS.map(provider => <button type="button" key={provider.id} aria-pressed={runtime === provider.id} disabled={busy} onClick={() => {
            setRuntime(provider.id);
            setQuery('');
            const providerModels = models.filter(model => model.runtimeType === provider.id);
            const fallback = pickDefaultModel(providerModels, provider.id === agent.runtimeType ? agent.catalogId : undefined);
            setChosen(fallback?.catalogId || '');
            setReasoning(fallback?.catalogId === agent.catalogId && agent.reasoning ? agent.reasoning : defaultEffort(fallback));
          }} className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors ${runtime === provider.id ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:bg-accent'}`}><RuntimeBrandIcon runtimeId={provider.id} className="h-5 w-5 shrink-0" />{providerLabel(provider.id)}</button>)}</div>
          <div className="relative mt-3 shrink-0"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Search CLI models" placeholder="Search models or accounts…" className="pl-9" value={query} onChange={event => setQuery(event.target.value)} /></div>
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto" role="radiogroup" aria-label="Available CLI models">{options.map(model => <label key={model.catalogId} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${model.available && model.availability === 'available' ? 'cursor-pointer hover:bg-accent/60' : 'opacity-50'} ${chosen === model.catalogId ? 'bg-primary/5' : ''}`}><input type="radio" name="chat-model" checked={chosen === model.catalogId} disabled={busy || !model.available || model.availability !== 'available' || (agents.length >= 30 && (model.runtimeType !== agent.runtimeType || model.accountProfileId !== agent.accountProfileId))} onChange={() => {
            const level = reasoning && model.supportedReasoning?.some(value => value === reasoning)
              ? reasoning
              : (agent.reasoning && model.supportedReasoning?.some(value => value === agent.reasoning) ? agent.reasoning : defaultEffort(model));
            setChosen(model.catalogId);
            setReasoning(level);
          }} className="accent-primary" /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-xs font-medium">{model.name}</span>{!!model.supportedReasoning?.length && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{model.supportedReasoning.join(' · ')}</span>}</span><span className="block truncate text-[11px] text-muted-foreground">{model.accountName} · {model.available ? model.routeLabel : model.statusBadge}</span></span></label>)}{!options.length && <p className="p-3 text-xs text-muted-foreground">No matching models. Connect or verify this CLI in Accounts.</p>}</div>
          <div className="mt-3 shrink-0 border-t border-border pt-3">
            {selected?.supportedReasoning?.length ? (
              <fieldset>
                <legend className="mb-2 text-xs font-medium">Reasoning level</legend>
                <div className="flex flex-wrap gap-1.5">{selected.supportedReasoning.map(level => <Button key={level} type="button" size="sm" variant={effort === level ? 'secondary' : 'outline'} aria-pressed={effort === level} disabled={busy} onClick={() => setReasoning(level)} className="h-7 px-2.5 text-xs capitalize">{level}</Button>)}</div>
              </fieldset>
            ) : selected ? (
              <p className="text-[11px] text-muted-foreground">{selected.name} manages its own reasoning level. Choose a model family with effort levels (e.g. Gemini 4 Neon or Hydrogen) to pick reasoning.</p>
            ) : null}
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="truncate text-[11px] text-muted-foreground">{independent ? `Opens a new ${providerLabel(runtime)} agent tab` : selected && !unchanged ? (agent.runtimeType === 'opencode' ? 'Applies live without restarting' : 'Restarts this CLI session with the selected model') : 'Select a model or reasoning level'}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => setExpanded(false)}>Cancel</Button>
                <Button type="button" size="sm" className="h-7 px-3 text-xs" disabled={!canApplySelected} onClick={() => selected && void apply(selected, effort)}>{applying ? 'Applying…' : independent ? 'Open new agent' : 'Apply'}</Button>
              </div>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {!!current?.supportedReasoning?.length && (
      <Popover.Root open={effortMenuOpen} onOpenChange={setEffortMenuOpen}>
        <Popover.Trigger asChild>
          <Button type="button" variant={effortMenuOpen ? 'secondary' : 'ghost'} size="sm" disabled={busy} className="h-8 gap-1 px-2 text-xs capitalize text-muted-foreground" aria-label={`Reasoning level: ${currentEffort || 'default'}`} title="Change reasoning level"><Sparkles className="h-3 w-3 shrink-0" /><span>{currentEffort || 'Default'}</span><ChevronDown className="h-3 w-3 shrink-0" /></Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={16} aria-label="Choose reasoning level" className="z-[120] min-w-36 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none">
            <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Reasoning</p>
            {current.supportedReasoning.map(level => (
              <button key={level} type="button" disabled={busy} aria-pressed={currentEffort === level} onClick={() => void apply(current, level)} className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs capitalize transition-colors ${currentEffort === level ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
                <span>{level}</span>
                {currentEffort === level && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </button>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    )}
  </div>;
}
