import { Badge } from '@/components/ui/badge';
import { missionStage, missionStatusLabel, type MissionStage } from '@/lib/mission-display';
import { useMissionStore } from '@/stores/mission-store';

const STAGES: Array<{ id: MissionStage; label: string }> = [
  { id: 'queue', label: 'Queue' },
  { id: 'plan', label: 'Plan' },
  { id: 'execute', label: 'Execute' },
  { id: 'review', label: 'Review' },
  { id: 'attention', label: 'Attention' },
  { id: 'outcome', label: 'Outcome' },
];

export function MissionStateStrip() {
  const { missions, activeMissionId, activeTasks, commandQueue, transportStatus } = useMissionStore();
  const mission = missions.find((item) => item.id === activeMissionId);
  if (!mission) return null;

  const currentStage = missionStage(mission.status);
  const completedTasks = activeTasks.filter((task) => ['completed', 'done', 'verified', 'applied'].includes(task.status)).length;
  const missionQueueCount = commandQueue.filter((command) => command.missionId === mission.id).length;

  return (
    <section className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-card/35 px-3 py-2" aria-label="Mission state" role="status">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {STAGES.map((stage) => {
          const active = stage.id === currentStage;
          return (
            <span key={stage.id} className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${active ? 'bg-primary/12 text-primary ring-1 ring-primary/25' : 'text-muted-foreground'}`}>
              {stage.label}
            </span>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
        <span className="tabular-nums">{completedTasks}/{activeTasks.length} tasks</span>
        {missionQueueCount > 0 && <Badge variant="secondary" className="text-[9px]">{missionQueueCount} queued</Badge>}
        <span className="hidden lg:inline">{transportStatus === 'connected' ? 'Live' : 'Reconnecting'}</span>
        <Badge variant={mission.status === 'failed' || mission.status === 'blocked' ? 'destructive' : 'outline'} className="text-[9px]">
          {missionStatusLabel(mission.status)}
        </Badge>
      </div>
    </section>
  );
}
