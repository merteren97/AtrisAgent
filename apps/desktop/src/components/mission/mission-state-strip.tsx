import { Badge } from '@/components/ui/badge';
import { missionStatusLabel, projectMissionError, projectMissionLifecycle } from '@/lib/mission-display';
import { useMissionStore } from '@/stores/mission-store';
import { useAccountStore } from '@/stores/account-store';
import { AlertCircle, Loader2, Wifi } from 'lucide-react';

const TRANSPORT_LABEL = {
  idle: 'Offline',
  connecting: 'Connecting',
  connected: 'Live',
  reconnecting: 'Reconnecting',
  error: 'Live error',
} as const;

export function MissionStateStrip() {
  const { missions, activeMissionId, activeTasks, commandQueue, transportStatus, transportError, error, timeline, pendingMissionStart } = useMissionStore();
  const serviceOnline = useAccountStore((state) => state.serviceOnline);
  const serviceError = useAccountStore((state) => state.error);
  const mission = missions.find((item) => item.id === activeMissionId);
  if (!mission && !pendingMissionStart) return null;

  const completedTasks = activeTasks.filter((task) => ['completed', 'done', 'verified', 'applied'].includes(task.status)).length;
  const missionQueueCount = mission ? commandQueue.filter((command) => command.missionId === mission.id).length : 0;
  const visibleError = transportError || error || (!serviceOnline ? serviceError : null);
  const projectedError = projectMissionError(visibleError, timeline);
  const lifecycle = projectMissionLifecycle(mission?.status || 'starting', { pending: Boolean(pendingMissionStart) });
  const title = mission?.title || pendingMissionStart?.request || 'New mission';

  return (
    <section className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-card/35 px-3 py-1.5" aria-label="Mission and connection status" role="status">
      <div className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>
        {title}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
        {visibleError ? (
          <span className="flex max-w-72 items-center gap-1 truncate text-destructive" title={projectedError?.action || visibleError} role="alert">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="truncate">{projectedError ? `${projectedError.stageLabel}: ${projectedError.message}` : visibleError}</span>
          </span>
        ) : (
          <span className="hidden items-center gap-1 sm:flex" title={lifecycle.description}>
            {lifecycle.isPending || transportStatus === 'connecting' || transportStatus === 'reconnecting' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wifi className="h-3 w-3" />}
            {pendingMissionStart?.reason === 'deadline' ? 'Start uncertain' : serviceOnline ? TRANSPORT_LABEL[transportStatus] : 'Service offline'}
          </span>
        )}
        <span className="hidden tabular-nums sm:inline">{completedTasks}/{activeTasks.length} tasks</span>
        {missionQueueCount > 0 && <Badge variant="secondary" className="text-[9px]">{missionQueueCount} queued</Badge>}
        <Badge variant={mission?.status === 'failed' || mission?.status === 'blocked' ? 'destructive' : 'outline'} className="text-[9px]">
          {lifecycle.label || missionStatusLabel(mission?.status || 'starting')}
        </Badge>
      </div>
    </section>
  );
}
