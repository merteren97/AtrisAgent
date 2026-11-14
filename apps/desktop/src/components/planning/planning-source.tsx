import { useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen } from 'lucide-react';
import { apiRequest } from '@/lib/api-client';
import { useManualStore } from '@/stores/manual-store';
import { useMissionStore } from '@/stores/mission-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePlanningStore, type PlanningSource } from '@/stores/planning-store';

export function PlanningSourceBanner() {
  const mode = useManualStore(state => state.mode);
  const workspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const manualId = useManualStore(state => workspaceId ? state.activeByWorkspace[workspaceId] : undefined);
  const missionId = useMissionStore(state => state.activeMissionId);
  const target = mode === 'manual' ? 'manual' : mode === 'orchestrator' ? 'orchestrator' : null;
  const targetId = target === 'manual' ? manualId : missionId;
  const known = usePlanningStore(state => target && targetId ? state.sources[`${target}:${targetId}`] : undefined);
  const [source, setSource] = useState<PlanningSource | null>(null);
  useEffect(() => {
    setSource(null);
    if (!target || !targetId || known) return;
    let disposed = false;
    void apiRequest<PlanningSource | null>(`/planning-source/${target}/${encodeURIComponent(targetId)}`).then(value => { if (!disposed) setSource(value); }).catch(() => {});
    return () => { disposed = true; };
  }, [target, targetId, known]);
  const origin = known || source;
  if (!target || !origin) return null;
  return <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-primary/[0.04] px-5 py-2 text-xs"><span className="flex items-center gap-2 text-muted-foreground"><BookOpen className="h-3.5 w-3.5 text-primary" />Working from a saved plan snapshot</span><button type="button" className="flex shrink-0 items-center gap-1 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { useWorkspaceStore.getState().setActiveWorkspace(origin.workspaceId); usePlanningStore.getState().select(origin.workspaceId, origin.planId); useManualStore.getState().setMode('planning'); }}>Open source plan<ArrowUpRight className="h-3.5 w-3.5" /></button></div>;
}
