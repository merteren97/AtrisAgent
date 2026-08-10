import { useState, useRef, useEffect } from 'react';
import { Activity, Filter } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useMissionStore } from '@/stores/mission-store';

type FilterType = 'all' | 'agents' | 'tools' | 'coordination' | 'errors';

const AGENT_EVENTS = new Set([
  'agent_spawned', 'agent_started', 'agent_progressed', 'agent_waiting', 'agent_resumed', 'agent_completed',
  'agent_thought', 'agent_context_attached', 'agent_context_compacted',
]);
const COORDINATION_EVENTS = new Set([
  'agent_message_sent', 'agent_message_read', 'task_assigned', 'task_split', 'task_merged', 'plan_revised',
  'verification_started', 'verification_finding', 'verification_completed', 'review_completed', 'revision_requested',
]);
const TOOL_EVENTS = new Set(['agent_tool_call', 'tool_call_started', 'tool_call_completed', 'file_changed']);

export function ActivityTab() {
  const { timeline } = useMissionStore();
  const [filter, setFilter] = useState<FilterType>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredTimeline = timeline.filter((item) => {
    const type = item.eventType || '';
    if (filter === 'all') return true;
    if (filter === 'agents') return AGENT_EVENTS.has(type);
    if (filter === 'tools') return TOOL_EVENTS.has(type);
    if (filter === 'coordination') return COORDINATION_EVENTS.has(type);
    if (filter === 'errors') return type === 'task_failed' || type === 'mission_failed' || type === 'agent_error';
    return true;
  });

  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [filteredTimeline.length, autoScroll]);

  if (timeline.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-foreground">
        <Activity className="mb-3 h-10 w-10 opacity-20" />
        <h3 className="mb-1 text-sm font-medium text-foreground">No activity yet</h3>
        <p className="text-xs">Agent delegation, tools, messages, verification, and mission events appear here.</p>
      </div>
    );
  }

  const getEventColor = (eventType?: string) => {
    if (eventType && COORDINATION_EVENTS.has(eventType)) return 'bg-cyan-500/10 text-cyan-500 hover:bg-cyan-500/20';
    switch (eventType) {
      case 'agent_spawned': return 'bg-purple-500/10 text-purple-400 hover:bg-purple-500/20';
      case 'agent_thought': return 'bg-purple-500/10 text-purple-500 hover:bg-purple-500/20';
      case 'agent_tool_call':
      case 'tool_call_started':
      case 'tool_call_completed': return 'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20';
      case 'task_completed':
      case 'agent_completed': return 'bg-success/10 text-success hover:bg-success/20';
      case 'task_failed':
      case 'agent_error':
      case 'mission_failed': return 'bg-destructive/10 text-destructive hover:bg-destructive/20';
      case 'mission_started':
      case 'mission_completed': return 'bg-primary/10 text-primary hover:bg-primary/20';
      case 'file_changed': return 'bg-warning/10 text-warning hover:bg-warning/20';
      case 'agent_context_attached':
      case 'agent_context_compacted': return 'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20';
      default: return 'bg-muted text-muted-foreground hover:bg-muted/80';
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/20 p-2">
        <Filter className="ml-1 mr-1 h-3.5 w-3.5 text-muted-foreground" />
        <div className="no-scrollbar flex min-w-0 gap-1 overflow-x-auto">
          {(['all', 'agents', 'tools', 'coordination', 'errors'] as FilterType[]).map((value) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={cn(
                'whitespace-nowrap rounded-md px-2 py-1 text-[10px] capitalize transition-colors',
                filter === value
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <ScrollArea
        className="flex-1"
        onScroll={(event) => {
          const target = event.target as HTMLDivElement;
          setAutoScroll(target.scrollHeight - target.scrollTop <= target.clientHeight + 20);
        }}
      >
        <div className="flex flex-col gap-3 p-3">
          {filteredTimeline.map((item) => (
            <div key={item.id} className="flex flex-col gap-1.5 border-b border-border/50 pb-3 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant="secondary" className={cn('h-4 max-w-[150px] truncate border-transparent px-1.5 text-[9px] font-medium', getEventColor(item.eventType))}>
                    {item.eventType || item.type}
                  </Badge>
                  {item.agentRole && (
                    <Badge variant="outline" className="h-4 px-1.5 text-[9px] capitalize text-muted-foreground">
                      {item.agentRole}
                    </Badge>
                  )}
                </div>
                <span className="shrink-0 text-[9px] text-muted-foreground">{item.timestamp}</span>
              </div>

              <div className={cn(
                'break-words whitespace-pre-wrap text-[11px] leading-relaxed',
                TOOL_EVENTS.has(item.eventType || '') ? 'rounded-md bg-muted/50 p-2 font-mono text-muted-foreground' : 'text-foreground',
              )}>
                {item.content}
              </div>
            </div>
          ))}
          {!filteredTimeline.length && (
            <div className="py-8 text-center text-[10px] text-muted-foreground">No events match this filter.</div>
          )}
          <div ref={scrollRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
