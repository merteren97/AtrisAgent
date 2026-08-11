import { useEffect, useMemo, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageCard } from './message-card';
import { EventCard } from './event-card';
import { ActivityGroup } from './activity-group';
import { useMissionStore, type TimelineItem } from '@/stores/mission-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useAgentStore } from '@/stores/agent-store';
import { Sparkles, Loader2, Check, AlertCircle, Search, Wrench, Ban, MessageSquarePlus, FolderGit2 } from 'lucide-react';

const COMPACT_EVENT_TYPES = new Set([
  'task_created',
  'task_assigned',
  'task_claimed',
  'agent_spawned',
  'agent_started',
  'agent_progressed',
  'agent_thought',
  'agent_context_attached',
  'agent_context_compacted',
  'agent_message_read',
  'agent_tool_call',
  'tool_call_started',
  'tool_call_completed',
]);

type RenderEntry =
  | { kind: 'item'; item: TimelineItem }
  | { kind: 'activity'; items: TimelineItem[] };

function metadataString(item: TimelineItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function streamIdentity(item: TimelineItem): string {
  return metadataString(item, 'agentInstanceId') || item.agentRole || 'orchestrator';
}

function joinStreamText(previous: string, next: string): string {
  if (!previous) return next;
  if (!next) return previous;
  if (/\s$/.test(previous) || /^\s/.test(next)) return `${previous}${next}`;
  if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|>|---)/.test(next)) return `${previous}\n\n${next}`;
  if (/[.!?;:)]$/.test(previous)) return `${previous}\n\n${next}`;
  return `${previous} ${next}`;
}

function isDuplicateTerminalDiagnostic(items: TimelineItem[], index: number): boolean {
  const item = items[index];
  if (item.eventType !== 'agent_error') return false;

  const taskId = metadataString(item, 'taskId');
  const error = metadataString(item, 'error');
  if (!taskId || !error) return false;

  // RuntimeHost may attach an agent-level diagnostic while propagating the same
  // task_failed event. Keep that diagnostic in the Activity inspector for deep
  // telemetry, but show one authoritative failure in the conversational timeline.
  return items.slice(index + 1, index + 4).some((candidate) => (
    candidate.eventType === 'task_failed'
    && metadataString(candidate, 'taskId') === taskId
    && metadataString(candidate, 'error') === error
  ));
}

function prepareTimeline(items: TimelineItem[]): RenderEntry[] {
  const conversationalItems = items.filter((_, index) => !isDuplicateTerminalDiagnostic(items, index));
  const coalesced: TimelineItem[] = [];

  for (const item of conversationalItems) {
    const previous = coalesced[coalesced.length - 1];
    const canMerge = item.type === 'orchestrator_message'
      && previous?.type === 'orchestrator_message'
      && streamIdentity(previous) === streamIdentity(item)
      && previous.eventType === 'text_delta'
      && item.eventType === 'text_delta';

    if (canMerge) {
      coalesced[coalesced.length - 1] = {
        ...previous,
        content: joinStreamText(previous.content, item.content),
        timestamp: item.timestamp || previous.timestamp,
        metadata: { ...previous.metadata, ...item.metadata, coalescedEventCount: Number(previous.metadata?.coalescedEventCount || 1) + 1 },
      };
    } else {
      coalesced.push(item);
    }
  }

  const result: RenderEntry[] = [];
  let activity: TimelineItem[] = [];

  const flush = () => {
    if (activity.length === 0) return;
    if (activity.length === 1) result.push({ kind: 'item', item: activity[0] });
    else result.push({ kind: 'activity', items: activity });
    activity = [];
  };

  for (const item of coalesced) {
    const isCompact = item.type === 'event' && COMPACT_EVENT_TYPES.has(item.eventType || '');
    if (!isCompact) {
      flush();
      result.push({ kind: 'item', item });
      continue;
    }

    const previousRole = activity[0]?.agentRole || 'agent';
    const nextRole = item.agentRole || 'agent';
    if (activity.length > 0 && previousRole !== nextRole) flush();
    activity.push(item);
  }
  flush();
  return result;
}

export function ChatTimeline() {
  const timeline = useMissionStore((state) => state.timeline);
  const missions = useMissionStore((state) => state.missions);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const activeTasks = useMissionStore((state) => state.activeTasks);
  const loading = useMissionStore((state) => state.loading);
  const setComposerInput = useMissionStore((state) => state.setComposerInput);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const agents = useAgentStore((state) => state.agents);
  const bottomRef = useRef<HTMLDivElement>(null);

  const activeMission = missions.find((mission) => mission.id === activeMissionId);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const missionCancelled = activeMission?.status === 'cancelled';
  const missionAgents = useMemo(
    () => activeMissionId ? agents.filter((agent) => agent.missionId === activeMissionId) : [],
    [activeMissionId, agents],
  );
  const runningAgents = missionCancelled ? 0 : missionAgents.filter((agent) => agent.status === 'running').length;
  const completedTasks = activeTasks.filter((task) => task.status === 'completed' || task.status === 'done').length;
  const renderTimeline = useMemo(() => prepareTimeline(timeline), [timeline]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [timeline]);

  const handleSuggestion = (text: string) => setComposerInput(text);

  const emptyState = activeMission ? (
    <div className="flex min-h-[420px] items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card/50 p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
            {activeMission.status === 'cancelled'
              ? <Ban className="h-4 w-4 text-muted-foreground" />
              : ['failed', 'blocked'].includes(activeMission.status)
                ? <AlertCircle className="h-4 w-4 text-destructive" />
                : activeMission.status === 'completed'
                  ? <Check className="h-4 w-4 text-emerald-400" />
                  : <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Mission</div>
            <h2 className="mt-1 line-clamp-2 text-lg font-semibold tracking-tight">{activeMission.title}</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {loading
                ? 'Restoring the mission timeline and agent sessions…'
                : missionCancelled
                  ? 'This mission was cancelled. Completed work and recorded agent activity remain available, but unfinished work is no longer active.'
                  : runningAgents > 0
                    ? `${runningAgents} agent${runningAgents === 1 ? '' : 's'} actively working. Their delegated sessions remain available in the workspace tree.`
                    : missionAgents.length > 0
                      ? `${missionAgents.length} agent session${missionAgents.length === 1 ? '' : 's'} restored for this mission.`
                      : 'Preparing the orchestrator and mission context…'}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <div className="min-w-[100px] flex-1 rounded-lg border border-border bg-background/60 px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Agents</div>
            <div className="mt-1 text-sm font-semibold">{missionAgents.length}</div>
          </div>
          <div className="min-w-[100px] flex-1 rounded-lg border border-border bg-background/60 px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Active</div>
            <div className="mt-1 text-sm font-semibold">{runningAgents}</div>
          </div>
          <div className="min-w-[100px] flex-1 rounded-lg border border-border bg-background/60 px-3 py-2">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Tasks</div>
            <div className="mt-1 text-sm font-semibold">{completedTasks}/{activeTasks.length}</div>
          </div>
        </div>
      </div>
    </div>
  ) : activeWorkspace ? (
    <div className="flex min-h-[520px] flex-col items-center justify-center px-4 py-14 text-center">
      <div className="mb-4 flex items-center gap-2 rounded-full border border-border/80 bg-card/70 px-3 py-1.5 text-[10px] text-muted-foreground shadow-sm">
        <FolderGit2 className="h-3 w-3 text-primary" />
        <span className="max-w-[280px] truncate font-medium text-foreground/90">{activeWorkspace.name}</span>
        <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
        <span>New chat</span>
      </div>

      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
        <MessageSquarePlus className="h-5 w-5" />
        <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-background bg-emerald-400" />
      </div>
      <h2 className="mt-5 text-xl font-semibold tracking-tight">Start a fresh conversation</h2>
      <p className="mt-2 max-w-lg text-xs leading-relaxed text-muted-foreground">
        This creates a separate mission thread inside <span className="font-medium text-foreground/90">{activeWorkspace.name}</span>. Your existing conversations, plans, agents, and activity stay available in the workspace sidebar.
      </p>

      <div className="mt-6 flex items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
        <Sparkles className="h-3 w-3 text-primary" />
        Each conversation keeps its own mission timeline and agent team.
      </div>

      <div className="mt-7 flex max-w-xl flex-wrap justify-center gap-2">
        <button onClick={() => handleSuggestion('Investigate and fix the current bug, then verify the result')} className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-card/90 hover:text-foreground">
          <Wrench className="h-3.5 w-3.5" />Fix a bug
        </button>
        <button onClick={() => handleSuggestion('Implement this feature cleanly and add the necessary tests')} className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-card/90 hover:text-foreground">
          <Sparkles className="h-3.5 w-3.5" />Build a feature
        </button>
        <button onClick={() => handleSuggestion('Review the recent changes, find risks, and propose fixes')} className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-card/90 hover:text-foreground">
          <Search className="h-3.5 w-3.5" />Review changes
        </button>
      </div>
    </div>
  ) : (
    <div className="flex min-h-[480px] flex-col items-center justify-center px-4 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
        <Sparkles className="h-5 w-5" />
      </div>
      <h2 className="mt-5 text-xl font-semibold tracking-tight">Open a project to get started</h2>
      <p className="mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
        Choose a workspace from the sidebar or open a project folder. Conversations are grouped by project so their plans, agents, and history stay organized.
      </p>
    </div>
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto min-w-0 max-w-4xl space-y-3 px-4 py-6">
        {timeline.length === 0 ? emptyState : renderTimeline.map((entry, index) => {
          if (entry.kind === 'activity') {
            return <ActivityGroup key={`activity-${entry.items[0]?.id || index}`} items={entry.items} />;
          }
          const item = entry.item;
          if (item.type === 'user_message') {
            return <MessageCard key={item.id} role="user" content={item.content} timestamp={item.timestamp} />;
          }
          if (item.type === 'orchestrator_message') {
            return <MessageCard key={item.id} role="orchestrator" content={item.content} timestamp={item.timestamp} />;
          }
          return (
            <EventCard
              key={item.id}
              eventType={item.eventType || 'event'}
              content={item.content}
              timestamp={item.timestamp}
              agentRole={item.agentRole}
              metadata={item.metadata}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
