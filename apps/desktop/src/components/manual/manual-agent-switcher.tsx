import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import type { ManualAgent } from '@/stores/manual-store';
import type { TerminalSnapshot } from './manual-terminal';
import { activityNotice, useManualActivity } from './manual-activity';
import { useManualStore } from '@/stores/manual-store';
import { X } from 'lucide-react';

export function ManualAgentSwitcher({agents,selectedId,statuses,hidden,onSelect,onDelete,pending}:{agents:ManualAgent[];selectedId?:string;statuses:Record<string,TerminalSnapshot['status']>;hidden:Record<string,boolean>;onSelect:(id:string)=>void;onDelete:(agent:ManualAgent)=>void;pending:boolean}) {
  const visible = agents.filter(agent => !hidden[agent.id]);
  const observations = useManualActivity(state => state.agents);
  const acknowledged = useManualStore(state => state.acknowledgedActivity);
  return <nav aria-label="Chat agents" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-4 py-2">
    {visible.map(agent => {
      const notice = activityNotice(observations[agent.id], acknowledged[agent.id]);
      return <div key={agent.id} className={'group flex h-9 max-w-64 shrink-0 items-center rounded-lg transition-colors '+(selectedId===agent.id?'bg-secondary text-foreground':'text-muted-foreground hover:bg-accent hover:text-foreground')}>
        <button type="button" aria-pressed={selectedId===agent.id} onClick={()=>onSelect(agent.id)} title={agent.name+' · '+(notice === 'attention' ? 'Needs your attention' : notice === 'completed' ? 'Turn finished' : statuses[agent.id] || 'Checking session')} className="flex min-w-0 items-center gap-2 py-2 pl-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <RuntimeBrandIcon runtimeId={agent.runtimeType} className="h-3.5 w-3.5 shrink-0"/><span className="truncate">{agent.name}</span>
          {notice ? <span className={`shrink-0 text-[10px] font-semibold ${notice === 'attention' ? 'text-amber-500' : 'text-emerald-500'}`}>{notice === 'attention' ? 'Attention' : 'Done'}</span> : statuses[agent.id] && statuses[agent.id]!=='open' ? <span className="text-[10px] text-muted-foreground">Offline</span> : null}
        </button>
        <button type="button" disabled={pending} aria-label={`Delete agent: ${agent.name}`} title={`Delete ${agent.name}`} onClick={()=>onDelete(agent)} className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><X className="h-3.5 w-3.5"/></button>
      </div>;
    })}
    {!visible.length && <span className="px-2 text-xs text-muted-foreground">No agents. Add one to get started.</span>}
  </nav>;
}
