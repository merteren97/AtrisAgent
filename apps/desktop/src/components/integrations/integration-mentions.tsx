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
    void Promise.allSettled([
      apiRequest<{status:string}>('/integrations/github'),
      apiRequest<{connection:unknown}>('/integrations/playwright'),
      apiRequest<{connections:Record<string, unknown>}>('/integrations/editors'),
      apiRequest<{connection:unknown}>('/integrations/unity-cli'),
    ]).then(([github, playwright, editors, unity]) => {
      if (!active) return;
      const ids = new Set<string>();
      if (github.status === 'fulfilled' && github.value.status === 'connected') ids.add('github');
      if (playwright.status === 'fulfilled' && playwright.value.connection) ids.add('playwright');
      if (editors.status === 'fulfilled') for (const id of ['unity-mcp','blender','godot']) if (editors.value.connections[id]) ids.add(id);
      if (unity.status === 'fulfilled' && unity.value.connection) ids.add('unity-cli');
      setItems(CATALOG.filter(item => ids.has(item.id)));
      setIncomplete([github,playwright,editors,unity].some(result => result.status === 'rejected'));
      setLoading(false);
    });
    return () => { active = false; };
  }, [open]);
  return { items, loading, incomplete };
}

export function IntegrationMentionOptions({ items, query, loading, incomplete, onSelect }: { items:IntegrationMention[]; query:string; loading:boolean; incomplete:boolean; onSelect:(mention:string) => void }) {
  const setActiveView = useSettingsStore(state => state.setActiveView);
  const matches = matchingIntegrationMentions(items, query);
  return <div className="border-t border-border pt-1">
    <p className="px-3 py-1 text-[10px] font-medium text-muted-foreground">Verified integrations</p>
    {loading ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">Checking connections…</p> : matches.length ? matches.map(item => <button key={item.id} type="button" onClick={() => onSelect(item.mention)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Plug className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">@{item.mention}<span className="ml-2 text-muted-foreground">{item.label}</span></span><span className="shrink-0 text-[10px] text-muted-foreground">{item.id === 'github' ? 'Read' : 'Setup'}</span></button>) : <p className="px-3 py-2 text-xs text-muted-foreground">{query && items.length ? 'No matching integrations.' : 'No verified integrations.'}</p>}
    {incomplete && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Some connections could not be checked.</p>}
    <button type="button" onClick={() => setActiveView('integrations')} className="rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">Manage integrations</button>
  </div>;
}
