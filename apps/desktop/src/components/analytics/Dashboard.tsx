import { useEffect, useMemo, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, ListTodo, PlayCircle, Plus, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  isMissionActive,
  isMissionOutcome,
  isMissionQueued,
  missionActivityTimestamp,
  missionStage,
  missionStatusLabel,
  needsMissionAttention,
  type MissionStage,
} from '@/lib/mission-display';
import { useMissionStore, type DurableMissionCommand, type Mission } from '@/stores/mission-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

const STAGES: Array<{ id: MissionStage; label: string }> = [
  { id: 'queue', label: 'Queue' },
  { id: 'plan', label: 'Plan' },
  { id: 'execute', label: 'Execute' },
  { id: 'review', label: 'Review' },
  { id: 'attention', label: 'Attention' },
  { id: 'outcome', label: 'Outcomes' },
];

function relativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'Unknown time';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function MissionRow({ mission, onOpen }: { mission: Mission; onOpen: (missionId: string) => void }) {
  const timestamp = missionActivityTimestamp(mission);
  return (
    <button
      type="button"
      onClick={() => onOpen(mission.id)}
      className="group flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition hover:border-border hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{mission.title || 'Untitled mission'}</span>
        <time dateTime={timestamp} className="mt-0.5 block text-xs text-muted-foreground">{relativeTime(timestamp)}</time>
      </span>
      <Badge variant={needsMissionAttention(mission.status) ? 'destructive' : mission.status === 'completed' ? 'success' : 'secondary'} className="shrink-0 text-[10px]">
        {missionStatusLabel(mission.status)}
      </Badge>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
    </button>
  );
}

function CommandRow({ command, onOpen }: { command: DurableMissionCommand; onOpen: (missionId: string) => void }) {
  const label = command.type === 'stop_and_replan' ? 'Replan' : command.type === 'steer' ? 'Guidance' : 'Follow-up';
  return (
    <button
      type="button"
      onClick={() => onOpen(command.missionId)}
      className="group flex w-full items-start gap-3 rounded-lg border border-primary/15 bg-primary/[0.035] px-3 py-2.5 text-left transition hover:bg-primary/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ListTodo className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{command.missionTitle}</span>
          <Badge variant="outline" className="text-[9px]">{label}</Badge>
        </span>
        <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">{command.preview}</span>
      </span>
      <time dateTime={command.createdAt} className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(command.createdAt)}</time>
    </button>
  );
}

function Section({ title, icon, count, children, empty }: { title: string; icon: ReactNode; count: number; children: ReactNode; empty: string }) {
  return (
    <Card className="overflow-hidden border-border/80 bg-card/75 shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        {icon}
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="secondary" className="ml-auto min-w-6 justify-center text-[10px]">{count}</Badge>
      </div>
      <div className="space-y-1 p-2">
        {count > 0 ? children : <p className="px-3 py-6 text-center text-xs text-muted-foreground">{empty}</p>}
      </div>
    </Card>
  );
}

export function AnalyticsDashboard() {
  const { missions, commandQueue, loading, error, fetchMissions, fetchCommandQueue, setActiveMission, clearActiveMission, setComposerInput } = useMissionStore();
  const { workspaces, activeWorkspaceId } = useWorkspaceStore();
  const setActiveView = useSettingsStore((state) => state.setActiveView);
  const workspace = workspaces.find((item) => item.id === activeWorkspaceId);
  const scoped = useMemo(() => missions.filter((mission) => mission.workspaceId === activeWorkspaceId), [activeWorkspaceId, missions]);
  const attention = useMemo(() => scoped.filter((mission) => needsMissionAttention(mission.status)).sort((a, b) => missionActivityTimestamp(b).localeCompare(missionActivityTimestamp(a))), [scoped]);
  const running = useMemo(() => scoped.filter((mission) => isMissionActive(mission.status) && !needsMissionAttention(mission.status)).sort((a, b) => missionActivityTimestamp(b).localeCompare(missionActivityTimestamp(a))), [scoped]);
  const queuedMissions = useMemo(() => scoped.filter((mission) => isMissionQueued(mission.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [scoped]);
  const outcomes = useMemo(() => scoped.filter((mission) => isMissionOutcome(mission.status)).sort((a, b) => missionActivityTimestamp(b).localeCompare(missionActivityTimestamp(a))).slice(0, 8), [scoped]);
  const stageCounts = useMemo(() => STAGES.map((stage) => ({ ...stage, count: scoped.filter((mission) => missionStage(mission.status) === stage.id).length })), [scoped]);

  useEffect(() => {
    if (!activeWorkspaceId) return undefined;
    void fetchCommandQueue(activeWorkspaceId);
    const timer = window.setInterval(() => void fetchCommandQueue(activeWorkspaceId), 5_000);
    return () => window.clearInterval(timer);
  }, [activeWorkspaceId, fetchCommandQueue]);

  const openMission = (missionId: string) => {
    setActiveMission(missionId);
    setActiveView('chat');
  };
  const newMission = () => {
    clearActiveMission();
    setComposerInput('');
    setActiveView('chat');
  };
  const refresh = () => {
    if (!activeWorkspaceId) return;
    void Promise.all([fetchMissions(activeWorkspaceId), fetchCommandQueue(activeWorkspaceId)]);
  };

  return (
    <ScrollArea className="min-h-0 flex-1 bg-background">
      <main className="mx-auto w-full max-w-7xl space-y-5 p-5 pb-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">Operations</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Command Center</h1>
            <p className="mt-1 text-sm text-muted-foreground">{workspace ? `${workspace.name} · decisions, active work, and durable queue` : 'Open a project to begin.'}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={refresh} disabled={!activeWorkspaceId || loading}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" /> Refresh
            </Button>
            <Button size="sm" onClick={newMission} disabled={!activeWorkspaceId}><Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> New mission</Button>
          </div>
        </header>

        {error && <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{error}</div>}

        <section aria-label="Mission state overview" className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card/60 sm:grid-cols-3 xl:grid-cols-6">
          {stageCounts.map((stage) => (
            <div key={stage.id} className="border-b border-r border-border/70 px-4 py-3 last:border-r-0 xl:border-b-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{stage.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{stage.count}</p>
            </div>
          ))}
        </section>

        {!activeWorkspaceId ? (
          <Card className="px-6 py-14 text-center"><p className="text-sm font-medium">No project selected</p><p className="mt-1 text-xs text-muted-foreground">Choose a project from the navigator to see its command center.</p></Card>
        ) : scoped.length === 0 && commandQueue.length === 0 && !loading ? (
          <Card className="px-6 py-14 text-center"><CheckCircle2 className="mx-auto h-6 w-6 text-primary" aria-hidden="true" /><p className="mt-3 text-sm font-medium">Ready for the first mission</p><p className="mt-1 text-xs text-muted-foreground">Start a conversation and the Orchestrator will manage work here.</p><Button size="sm" className="mt-4" onClick={newMission}>Start mission</Button></Card>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Section title="Needs attention" icon={<AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />} count={attention.length} empty="No approvals, blockers, or failures need attention.">
              {attention.map((mission) => <MissionRow key={mission.id} mission={mission} onOpen={openMission} />)}
            </Section>
            <Section title="Running" icon={<PlayCircle className="h-4 w-4 text-primary" aria-hidden="true" />} count={running.length} empty="No missions are currently running.">
              {running.map((mission) => <MissionRow key={mission.id} mission={mission} onOpen={openMission} />)}
            </Section>
            <Section title="Queued" icon={<Clock3 className="h-4 w-4 text-sky-500" aria-hidden="true" />} count={queuedMissions.length + commandQueue.length} empty="The durable queue is clear.">
              {commandQueue.map((command) => <CommandRow key={command.id} command={command} onOpen={openMission} />)}
              {queuedMissions.map((mission) => <MissionRow key={mission.id} mission={mission} onOpen={openMission} />)}
            </Section>
            <Section title="Recent outcomes" icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />} count={outcomes.length} empty="Completed outcomes will appear here.">
              {outcomes.map((mission) => <MissionRow key={mission.id} mission={mission} onOpen={openMission} />)}
            </Section>
          </div>
        )}
      </main>
    </ScrollArea>
  );
}
