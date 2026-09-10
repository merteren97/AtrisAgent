import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import type { ManualAgent } from '@/stores/manual-store';
import type { TerminalSnapshot } from './manual-terminal';

export function ManualAgentSwitcher({agents,selectedId,statuses,hidden,onSelect}:{agents:ManualAgent[];selectedId?:string;statuses:Record<string,TerminalSnapshot['status']>;hidden:Record<string,boolean>;onSelect:(id:string)=>void}) {
  const visible = agents.filter(agent => !hidden[agent.id]);
  return <nav aria-label="Chat agents" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-4 py-2">
    {visible.map(agent => <button key={agent.id} type="button" aria-pressed={selectedId===agent.id} onClick={()=>onSelect(agent.id)} title={agent.name+' · '+(statuses[agent.id] || 'Checking session')} className={'flex h-9 max-w-56 shrink-0 items-center gap-2 rounded-lg px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring '+(selectedId===agent.id?'bg-secondary font-medium text-foreground':'text-muted-foreground hover:bg-accent hover:text-foreground')}>
      <RuntimeBrandIcon runtimeId={agent.runtimeType} className="h-3.5 w-3.5 shrink-0"/><span className="truncate">{agent.name}</span>
      {statuses[agent.id] && statuses[agent.id]!=='open' && <span className="text-[10px] text-muted-foreground">Offline</span>}
    </button>)}
    {!visible.length && <span className="px-2 text-xs text-muted-foreground">No agents. Add one to get started.</span>}
  </nav>;
}
