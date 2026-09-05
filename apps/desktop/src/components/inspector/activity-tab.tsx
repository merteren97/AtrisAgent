import { useState, useRef, useEffect, useMemo, type UIEvent } from 'react';
import { Activity, ArrowDown, Filter } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToolCallRow } from '@/components/chat/tool-call-row';
import { cn } from '@/lib/utils';
import { useMissionStore } from '@/stores/mission-store';
import { useSettingsStore, type TimelineDetailMode } from '@/stores/settings-store';
import { DEFAULT_TIMELINE_WINDOW, growTimelineWindow, tailWindow } from '@/lib/timeline-window';

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
const TOOL_CALL_EVENTS = new Set(['agent_tool_call', 'tool_call_started', 'tool_call_completed']);
const BOTTOM_THRESHOLD = 32;

function isNearBottom(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD;
}

export function ActivityTab() {
  const timeline = useMissionStore((state) => state.timeline);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const detailMode = useSettingsStore((state) => state.timelineDetailMode);
  const setDetailMode = useSettingsStore((state) => state.setTimelineDetailMode);
  const [filter, setFilter] = useState<FilterType>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [visibleItemCount, setVisibleItemCount] = useState(DEFAULT_TIMELINE_WINDOW);
  const shouldFollowRef = useRef(true);
  const viewportRef = useRef<HTMLDivElement>(null);

  const filteredTimeline = useMemo(() => timeline.filter((item) => {
    const type = item.eventType || '';
    if (filter === 'all') return true;
    if (filter === 'agents') return AGENT_EVENTS.has(type);
    if (filter === 'tools') return TOOL_EVENTS.has(type);
    if (filter === 'coordination') return COORDINATION_EVENTS.has(type);
    if (filter === 'errors') return type === 'task_failed' || type === 'mission_failed' || type === 'agent_error';
    return true;
  }), [filter, timeline]);
  const timelineWindow = useMemo(() => tailWindow(filteredTimeline, visibleItemCount), [filteredTimeline, visibleItemCount]);

  useEffect(() => {
    shouldFollowRef.current = true;
    setAutoScroll(true);
    setVisibleItemCount(DEFAULT_TIMELINE_WINDOW);
  }, [activeMissionId]);

  useEffect(() => setVisibleItemCount(DEFAULT_TIMELINE_WINDOW), [filter]);

  useEffect(() => {
    if (timeline.length === 0) {
      shouldFollowRef.current = true;
      setAutoScroll(true);
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;

    if (shouldFollowRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    } else if (isNearBottom(viewport)) {
      shouldFollowRef.current = true;
      setAutoScroll(true);
    }
  }, [filter, timeline]);

  const handleViewportScroll = (event: UIEvent<HTMLDivElement>) => {
    const shouldFollow = isNearBottom(event.currentTarget);
    shouldFollowRef.current = shouldFollow;
    setAutoScroll(shouldFollow);
  };

  const jumpToLatest = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    shouldFollowRef.current = true;
    setAutoScroll(true);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
  };

  const loadOlder = () => {
    const viewport = viewportRef.current;
    const previousHeight = viewport?.scrollHeight || 0;
    shouldFollowRef.current = false;
    setAutoScroll(false);
    setVisibleItemCount((current) => growTimelineWindow(current, filteredTimeline.length));
    requestAnimationFrame(() => {
      if (viewport) viewport.scrollTop += viewport.scrollHeight - previousHeight;
    });
  };

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
      case 'mission_failed': return 'bg-destructive/10 text-destructive hover:bg-destructive/20';
      case 'agent_error': return 'bg-warning/10 text-warning hover:bg-warning/20';
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
        <div className="ml-auto flex shrink-0 rounded-md border border-border/70 bg-background/50 p-0.5" aria-label="Timeline detail">
          {(['summary', 'activity', 'telemetry'] as TimelineDetailMode[]).map((mode) => <button
            key={mode}
            type="button"
            onClick={() => setDetailMode(mode)}
            aria-pressed={detailMode === mode}
            title={`${mode} timeline detail`}
            className={cn('rounded px-1.5 py-0.5 text-[8px] capitalize', detailMode === mode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >{mode}</button>)}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <ScrollArea
          className="h-full"
          viewportRef={viewportRef}
          onViewportScroll={handleViewportScroll}
        >
          <div className="flex flex-col gap-3 p-3">
            {timelineWindow.hiddenCount > 0 && (
              <Button type="button" variant="outline" size="sm" className="mx-auto h-7 text-[10px]" onClick={loadOlder}>
                Load {Math.min(DEFAULT_TIMELINE_WINDOW, timelineWindow.hiddenCount)} older events
              </Button>
            )}
            {timelineWindow.items.map((item) => (
              <div key={item.id} className="flex flex-col gap-1.5 border-b border-border/50 pb-3 last:border-0">
                {TOOL_CALL_EVENTS.has(item.eventType || '') ? <ToolCallRow item={item} /> : (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge variant="secondary" className={cn('h-4 max-w-[150px] truncate border-transparent px-1.5 text-[9px] font-medium', getEventColor(item.eventType))}>
                          {item.eventType === 'agent_thought' ? 'progress summary' : item.eventType || item.type}
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
                  </>
                )}
              </div>
            ))}
            {!filteredTimeline.length && (
              <div className="py-8 text-center text-[10px] text-muted-foreground">No events match this filter.</div>
            )}
          </div>
        </ScrollArea>
        {!autoScroll && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="absolute bottom-3 right-3 z-10 h-7 rounded-full border border-border/80 bg-card/95 px-2.5 text-[10px] shadow-md backdrop-blur-sm"
            onClick={jumpToLatest}
            aria-label="Jump to latest activity"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            <span>New activity</span>
          </Button>
        )}
      </div>
    </div>
  );
}
