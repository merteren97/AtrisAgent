import { useState } from 'react';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import type { ManualAgent } from '@/stores/manual-store';
import type { TerminalSnapshot } from './manual-terminal';

export function ManualAgentSwitcher({agents,selectedId,statuses,hidden,onSelect}:{agents:ManualAgent[];selectedId?:string;statuses:Record<string,TerminalSnapshot['status']>;hidden:Record<string,boolean>;onSelect:(id:string)=>void}) {
  const [history,setHistory]=useState(false);
  const closed=(agent:ManualAgent)=>hidden[agent.id]||['closed','exited','disconnected'].includes(statuses[agent.id]);
  const active=agents.filter(agent=>!closed(agent)), archived=agents.filter(closed);
  const card=(agent:ManualAgent)=><button key={agent.id} type="button" aria-pressed={selectedId===agent.id} onClick={()=>onSelect(agent.id)} className={`flex max-w-64 shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors ${selectedId===agent.id?'border-primary/40 bg-primary/5':'border-transparent hover:bg-accent'}`}><RuntimeBrandIcon runtimeId={agent.runtimeType} className="h-4 w-4 shrink-0"/><span className="min-w-0"><span className="block truncate text-xs font-medium">{agent.name}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{closed(agent)?(statuses[agent.id]==='disconnected'&&!hidden[agent.id]?'Disconnected · history preserved':'Closed · history preserved'):statuses[agent.id]==='open'?'CLI open':'Checking session'}</span></span></button>;
  return <div className="shrink-0 border-b border-border/60 px-4 py-2"><div className="flex items-center gap-2"><div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Open chat agents">{active.map(card)}{!active.length&&<span className="px-2 text-xs text-muted-foreground">No open CLI sessions</span>}</div>{!!archived.length&&<Button type="button" size="sm" variant={history?'secondary':'ghost'} className="shrink-0 gap-1.5 text-xs text-muted-foreground" aria-expanded={history} onClick={()=>setHistory(!history)}><History className="h-3.5 w-3.5"/>History <span className="tabular-nums">{archived.length}</span></Button>}</div>{history&&<div aria-label="Closed agent history" className="mt-2 grid max-h-44 grid-cols-2 gap-1 overflow-auto border-t border-border pt-2 lg:grid-cols-3">{archived.map(card)}</div>}</div>;
}
