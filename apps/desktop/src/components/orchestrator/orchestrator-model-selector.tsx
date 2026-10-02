import { useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Loader2, RefreshCw, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { RuntimeBrandIcon, RUNTIME_BRANDS } from '@/components/runtime/runtime-brand-icon';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useOrchestratorPreferences } from '@/stores/orchestrator-preferences-store';
import { cn } from '@/lib/utils';

export function modelSupportsRole(model: DiscoveredModel, role: string): boolean {
  return !model.suitableRoles.length || model.suitableRoles.some(value => value.toLowerCase() === role.toLowerCase());
}

export function OrchestratorModelSelector() {
  const { preferences, updatePreferences } = useOrchestratorPreferences();
  const { discoveredModels, modelCatalogLoading, modelCatalogError, refreshModels } = useAccountStore();
  const [search, setSearch] = useState('');
  const [runtime, setRuntime] = useState('all');
  const selected = discoveredModels.find(model => model.catalogId === preferences.selectedModel);
  const compatible = useMemo(() => discoveredModels.filter(model => model.available && modelSupportsRole(model, 'orchestrator') && (preferences.modelScope !== 'all' || ['builder', 'reviewer', 'researcher', 'qa'].every(role => modelSupportsRole(model, role)))), [discoveredModels, preferences.modelScope]);
  const matches = compatible.filter(model => (runtime === 'all' || model.runtimeType === runtime) && [model.name, model.accountName, model.routeLabel].some(value => value.toLowerCase().includes(search.toLowerCase().trim())));
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={`Coordinator model: ${selected?.name || 'Auto'}`} className="h-8 max-w-[220px] gap-1.5 px-2 text-xs text-muted-foreground">
      {selected ? <RuntimeBrandIcon runtimeId={selected.runtimeType} className="h-3.5 w-3.5 shrink-0" /> : <Sparkles className="h-3.5 w-3.5 shrink-0" />}<span className="truncate">{selected?.name || 'Model: Auto'}</span><ChevronDown className="h-3 w-3 shrink-0" />
    </Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" sideOffset={8} className="w-[min(420px,calc(100vw-2rem))] p-0">
      <div className="flex items-start justify-between gap-2 border-b border-border p-4"><div><h3 className="text-sm font-semibold">Choose a model</h3><p className="mt-1 text-xs text-muted-foreground">{preferences.modelScope === 'all' ? 'Coordinator and all new specialists' : 'Coordinator only · specialists follow task policies'}</p></div><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Refresh models" disabled={modelCatalogLoading} onClick={() => void refreshModels().catch(() => undefined)}><RefreshCw className={cn('h-3.5 w-3.5', modelCatalogLoading && 'animate-spin')} /></Button></div>
      <div className="space-y-3 p-3"><label className="flex items-center justify-between gap-2 text-xs font-medium">Applies to<select aria-label="Model applies to" className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={preferences.modelScope} onChange={event => updatePreferences({ modelScope: event.target.value as 'coordinator' | 'all' })}><option value="coordinator">Coordinator only</option><option value="all">Everyone</option></select></label>
        <button type="button" onClick={() => updatePreferences({ selectedModel: '' })} className={cn('flex w-full items-center gap-3 rounded-lg border p-3 text-left', !preferences.selectedModel ? 'border-primary/40 bg-primary/5' : 'border-border hover:bg-accent')}><Sparkles className="h-4 w-4 text-primary" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">Automatic selection</span><span className="mt-0.5 block text-xs text-muted-foreground">Choose compatible models for each role.</span></span>{!preferences.selectedModel && <Check className="h-4 w-4 text-primary" />}</button>
        <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><input aria-label="Search models" placeholder="Search connected models…" value={search} onChange={event => setSearch(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
        <div className="flex flex-wrap gap-1"><button type="button" aria-pressed={runtime === 'all'} className={cn('rounded-md px-2 py-1 text-xs', runtime === 'all' ? 'bg-secondary text-foreground' : 'text-muted-foreground')} onClick={() => setRuntime('all')}>All</button>{RUNTIME_BRANDS.map(brand => <button type="button" key={brand.id} aria-label={`Filter ${brand.label} models`} aria-pressed={runtime === brand.id} onClick={() => setRuntime(brand.id)} className={cn('flex items-center gap-1 rounded-md px-2 py-1 text-xs', runtime === brand.id ? 'bg-secondary text-foreground' : 'text-muted-foreground')}><RuntimeBrandIcon runtimeId={brand.id} className="h-3 w-3" />{brand.label}</button>)}</div>
      </div>
      <div className="max-h-56 overflow-y-auto border-t border-border p-2">
        {matches.map(model => <button type="button" key={model.catalogId} onClick={() => updatePreferences({ selectedModel: model.catalogId, reasoningLevel: model.defaultReasoning || model.supportedReasoning[0] || 'none' })} className={cn('flex w-full items-center gap-3 rounded-lg p-2.5 text-left hover:bg-accent', model.catalogId === preferences.selectedModel && 'bg-secondary')}><RuntimeBrandIcon runtimeId={model.runtimeType} className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{model.name}</span><span className="block truncate text-xs text-muted-foreground">{model.accountName} · {model.routeLabel}</span></span>{model.catalogId === preferences.selectedModel && <Check className="h-4 w-4 text-primary" />}</button>)}
        {!matches.length && <div className="space-y-2 p-3 text-xs text-muted-foreground">{modelCatalogLoading ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Discovering models…</span> : modelCatalogError ? <><p className="flex items-start gap-2"><AlertCircle className="h-4 w-4 shrink-0" />{modelCatalogError}</p><Button variant="outline" size="sm" onClick={() => void refreshModels().catch(() => undefined)}>Retry discovery</Button></> : compatible.length ? <><p>No models match these filters.</p><Button variant="ghost" size="sm" onClick={() => { setRuntime('all'); setSearch(''); }}>Clear filters</Button></> : <><p>No connected model supports this scope.</p><Button variant="outline" size="sm" onClick={() => useSettingsStore.getState().setActiveView('accounts')}>Connect a model</Button></>}</div>}
      </div>
      {selected?.supportedReasoning.length ? <div className="flex flex-wrap items-center gap-1 border-t border-border p-3"><span className="mr-1 text-xs text-muted-foreground">Reasoning</span>{selected.supportedReasoning.map(level => <Button key={level} size="sm" variant={preferences.reasoningLevel === level ? 'secondary' : 'ghost'} className="h-7 px-2 text-xs" onClick={() => updatePreferences({ reasoningLevel: level })}>{level === 'xhigh' ? 'Extra high' : level}</Button>)}</div> : null}
      <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">This conversation · active workers keep their current model</p>
    </DropdownMenuContent>
  </DropdownMenu>;
}
