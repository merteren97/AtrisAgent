import { useEffect, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RuntimeBrandIcon, RUNTIME_BRANDS } from '@/components/runtime/runtime-brand-icon';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import type { ManualAgent } from '@/stores/manual-store';

const defaultEffort = (model?: DiscoveredModel) => model?.defaultReasoning || model?.supportedReasoning?.[0];

export function ChatSessionControls({ agent, agents, pending, onApply }: { agent: ManualAgent; agents: ManualAgent[]; pending: boolean; onApply: (model: DiscoveredModel, independent: boolean, reasoning?: string) => Promise<boolean> }) {
  const models = useAccountStore(state => state.discoveredModels);
  const current = models.find(model => model.catalogId === agent.catalogId);
  const [expanded, setExpanded] = useState(false);
  const [runtime, setRuntime] = useState(agent.runtimeType);
  const [chosen, setChosen] = useState(agent.catalogId);
  const [query, setQuery] = useState('');
  const [reasoning, setReasoning] = useState(agent.reasoning || defaultEffort(current));
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    setRuntime(agent.runtimeType);
    setChosen(agent.catalogId);
    setReasoning(agent.reasoning || defaultEffort(current));
  }, [agent.catalogId, agent.reasoning, agent.runtimeType, current]);
  const selected = models.find(model => model.catalogId === chosen && model.runtimeType === runtime);
  const effort = selected?.supportedReasoning?.some(level => level === reasoning) ? reasoning : defaultEffort(selected);
  const options = models.filter(model => model.runtimeType === runtime && `${model.name} ${model.accountName}`.toLowerCase().includes(query.toLowerCase()));
  const busy = pending || applying;
  const apply = async (model: DiscoveredModel, level?: string) => {
    if (busy || !model.available || model.availability !== 'available') return;
    const independent = model.runtimeType !== agent.runtimeType || model.accountProfileId !== agent.accountProfileId;
    if (independent && agents.length >= 30) return;
    if (!independent && model.catalogId === agent.catalogId && level === (agent.reasoning || defaultEffort(current))) return;
    setApplying(true);
    try {
      if (!await onApply(model, independent, level)) {
        setChosen(agent.catalogId);
        setReasoning(agent.reasoning || defaultEffort(current));
      }
    } finally { setApplying(false); }
  };
  return <Popover.Root open={expanded} onOpenChange={setExpanded}><Popover.Trigger asChild>
      <Button type="button" variant={expanded ? 'secondary' : 'ghost'} size="sm" className="max-w-64 gap-2 text-xs text-muted-foreground" aria-label={`Choose CLI and model: ${current?.name || agent.model}`}><RuntimeBrandIcon runtimeId={agent.runtimeType} className="h-4 w-4 shrink-0" /><span className="truncate">{current?.name || agent.model}</span>{agent.reasoning && <span className="text-[10px] capitalize opacity-70">· {agent.reasoning}</span>}<ChevronDown className="h-3 w-3 shrink-0" /></Button>
    </Popover.Trigger><Popover.Portal><Popover.Content side="top" align="start" sideOffset={12} collisionPadding={16} aria-label="CLI and model settings" className="z-[120] max-h-[min(520px,var(--radix-popover-content-available-height))] w-[min(580px,calc(100vw-32px))] overflow-y-auto rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none">
      <h3 className="mb-3 text-sm font-semibold">Model & CLI</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{RUNTIME_BRANDS.map(provider => <button type="button" key={provider.id} aria-pressed={runtime === provider.id} disabled={busy} onClick={() => { setRuntime(provider.id); setChosen(''); setQuery(''); }} className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors ${runtime === provider.id ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border text-muted-foreground hover:bg-accent'}`}><RuntimeBrandIcon runtimeId={provider.id} className="h-5 w-5 shrink-0" />{({claude_code:'Claude Code',codex:'Codex',opencode:'OpenCode',antigravity:'Antigravity'} as Record<string,string>)[provider.id]}</button>)}</div>
      <div className="relative mt-3"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Search CLI models" placeholder="Search models or accounts…" className="pl-9" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="mt-2 max-h-44 overflow-y-auto" role="radiogroup" aria-label="Available CLI models">{options.map(model => <label key={model.catalogId} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${model.available && model.availability === 'available' ? 'cursor-pointer hover:bg-accent/60' : 'opacity-50'} ${chosen === model.catalogId ? 'bg-primary/5' : ''}`}><input type="radio" name="chat-model" checked={chosen === model.catalogId} disabled={busy || !model.available || model.availability !== 'available' || (agents.length >= 30 && (model.runtimeType !== agent.runtimeType || model.accountProfileId !== agent.accountProfileId))} onChange={() => { const level = agent.reasoning && model.supportedReasoning?.some(value => value === agent.reasoning) ? agent.reasoning : defaultEffort(model); setChosen(model.catalogId); setReasoning(level); void apply(model, level); }} className="accent-primary" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{model.name}</span><span className="block truncate text-[11px] text-muted-foreground">{model.accountName} · {model.available ? model.routeLabel : model.statusBadge}</span></span></label>)}{!options.length && <p className="p-3 text-xs text-muted-foreground">No matching models. Connect or verify this CLI in Accounts.</p>}</div>
      {!!selected?.supportedReasoning?.length && <fieldset className="mt-3"><legend className="mb-2 text-xs font-medium">Reasoning level</legend><div className="flex flex-wrap gap-1.5">{selected.supportedReasoning.map(level => <Button key={level} type="button" size="sm" variant={effort === level ? 'secondary' : 'outline'} aria-pressed={effort === level} disabled={busy || selected.catalogId !== agent.catalogId} onClick={() => { setReasoning(level); void apply(selected, level); }} className="text-xs capitalize">{level}</Button>)}</div></fieldset>}
    </Popover.Content></Popover.Portal></Popover.Root>;
}
