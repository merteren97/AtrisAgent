import { useEffect, useState } from 'react';
import { Plug } from 'lucide-react';
import { apiRequest } from '@/lib/api-client';
import { useSettingsStore } from '@/stores/settings-store';

export type IntegrationMention = { id: string; mention: string; label: string };
const CATALOG: IntegrationMention[] = [
  { id:'github', mention:'github', label:'GitHub' },
  { id:'playwright', mention:'playwright', label:'Playwright MCP' },
  { id:'unity-mcp', mention:'unity', label:'Unity MCP' },
  { id:'unity-cli', mention:'unity-cli', label:'Unity CLI' },
  { id:'blender', mention:'blender', label:'Blender MCP' },
  { id:'godot', mention:'godot', label:'Godot MCP' },
];

export function matchingIntegrationMentions(items: IntegrationMention[], query: string): IntegrationMention[] {
  const normalized = query.toLowerCase();
  return items.filter(item => item.mention.includes(normalized) || item.label.toLowerCase().includes(normalized));
}

export function useConnectedIntegrationMentions(open: boolean) {
  const [items, setItems] = useState<IntegrationMention[]>([]);
  const [loading, setLoading] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setItems([]); setIncomplete(false);
    const ids = new Set<string>();
    let pending = 4;
    const collect = (request:Promise<string[]>) => {
      void request.then(found => {
        if (!active) return;
        found.forEach(id => ids.add(id));
        setItems(CATALOG.filter(item => ids.has(item.id)));
      }).catch(() => { if (active) setIncomplete(true); }).finally(() => { if (active && --pending === 0) setLoading(false); });
    };
    collect(apiRequest<{status:string}>('/integrations/github').then(result => result.status === 'connected' ? ['github'] : []));
    collect(apiRequest<{connection:unknown}>('/integrations/playwright').then(result => result.connection ? ['playwright'] : []));
    collect(apiRequest<{connections:Record<string, unknown>}>('/integrations/editors').then(result => ['unity-mcp','blender','godot'].filter(id => result.connections[id])));
    collect(apiRequest<{connection:unknown}>('/integrations/unity-cli').then(result => result.connection ? ['unity-cli'] : []));
    return () => { active = false; };
  }, [open]);
  return { items, loading, incomplete };
}

export function IntegrationMentionOptions({ items, query, loading, incomplete, onSelect, first = true }: { items:IntegrationMention[]; query:string; loading:boolean; incomplete:boolean; onSelect:(mention:string) => void; first?:boolean }) {
  const setActiveView = useSettingsStore(state => state.setActiveView);
  const matches = matchingIntegrationMentions(items, query);
  return <div className="border-t border-border pt-1">
    <p className="px-3 py-1 text-[10px] font-medium text-muted-foreground">Verified integrations</p>
    {matches.length ? matches.map((item,index) => <button key={item.id} type="button" onClick={() => onSelect(item.mention)} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${first && index === 0 ? 'bg-accent' : ''}`}><Plug className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">@{item.mention}<span className="ml-2 text-muted-foreground">{item.label}</span></span>{first && index === 0 ? <kbd className="rounded border border-border px-1 text-[10px] text-muted-foreground">Tab</kbd> : <span className="shrink-0 text-[10px] text-muted-foreground">{item.id === 'github' ? 'Read' : 'Setup'}</span>}</button>) : loading ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Checking connections…</p> : <p className="px-3 py-2 text-xs text-muted-foreground">{query && items.length ? 'No matching integrations.' : 'No verified integrations.'}</p>}
    {incomplete && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Some connections could not be checked.</p>}
    <button type="button" onClick={() => setActiveView('integrations')} className="rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">Manage integrations</button>
  </div>;
}
