import { useEffect, useState } from 'react';
import type { Approval } from '@atris-agent-code/domain';
import { AlertCircle, Check, ChevronRight, Circle, Loader2, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';
import { useMissionStore } from '@/stores/mission-store';
import { useAgentStore } from '@/stores/agent-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useQuestionStore } from './question-store';

export function OrchestratorWorkCard() {
  const { activeMissionId, missions, activeTasks, fetchMissionState } = useMissionStore();
  const agents = useAgentStore(state => state.agents);
  const questions = useQuestionStore(state => activeMissionId ? state.byMission[activeMissionId] : undefined);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mission = missions.find(item => item.id === activeMissionId);
  const status = mission?.status;
  useEffect(() => {
    let cancelled = false;
    setApproval(null); setError(null);
    if (!activeMissionId || status !== 'waiting_for_approval') return;
    const load = async () => {
      try {
        const approvals = await apiRequest<Approval[]>(`/missions/${encodeURIComponent(activeMissionId)}/approvals`);
        if (!cancelled) { setApproval(approvals.find(item => item.type === 'plan' && item.status === 'pending') || null); setError(null); }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load the team approval.'); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeMissionId, status]);
  if (!mission || !activeTasks.length) return null;
  const tasks = activeTasks.filter(task => !mission.planId || !task.planId || task.planId === mission.planId);
  const completed = tasks.filter(task => ['completed', 'done', 'verified', 'applied'].includes(task.status));
  const terminal = ['completed', 'failed', 'cancelled', 'blocked'].includes(mission.status);
  const working = terminal ? [] : agents.filter(agent => agent.missionId === mission.id && agent.status === 'running');
  const queued = tasks.filter(task => ['planned', 'pending', 'queued'].includes(task.status));
  const waitingQuestions = (questions || []).filter(question => ['pending', 'delivery_failed', 'delivering', 'delivered'].includes(question.status));
  const roles = Array.from(new Set(tasks.map(task => task.assignedRole).filter(Boolean)));
  const decide = async (decision: 'approved' | 'rejected') => {
    if (!approval || deciding) return;
    const missionId = mission.id;
    setDeciding(true); setError(null);
    try {
      await apiRequest(`/approvals/${encodeURIComponent(approval.id)}/decide`, { method: 'POST', body: JSON.stringify({ decision }) });
      setApproval(null);
      if (useMissionStore.getState().activeMissionId === missionId) await fetchMissionState(missionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Approval could not be confirmed. Reload the plan before retrying.'); }
    finally { setDeciding(false); }
  };
  return <section aria-label="Orchestrator work summary" className="rounded-xl border border-border bg-card p-4">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><UsersRound className="h-3.5 w-3.5" />{approval ? 'Your team is ready to start' : 'Orchestrator work'}</div><h3 className="mt-1.5 truncate text-sm font-semibold" title={mission.title}>{mission.title}</h3></div><Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-xs" onClick={() => useSettingsStore.getState().openInspector('plan')}>Details<ChevronRight className="h-3.5 w-3.5" /></Button></div>
    <ul className="mt-3 space-y-2">{tasks.slice(0, 3).map(task => <li key={task.id} className="flex items-start gap-2 text-xs"><span className="mt-0.5 shrink-0">{completed.some(item => item.id === task.id) ? <Check className="h-3.5 w-3.5 text-primary" /> : ['running', 'assigned', 'claimed'].includes(task.status) && !terminal ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : ['failed', 'blocked', 'rejected'].includes(task.status) ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}</span><span className="min-w-0 flex-1 break-words">{task.title}</span><span className="shrink-0 text-[11px] text-muted-foreground">{task.assignedRole || 'Auto'}</span></li>)}</ul>
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"><span>{completed.length}/{tasks.length} steps complete</span>{working.length > 0 && <span>{working.length} working</span>}{queued.length > 0 && !terminal && <span>{queued.length} awaiting dispatch</span>}{waitingQuestions.length > 0 && <span className="text-primary">{waitingQuestions.length} awaiting your answer</span>}{tasks.length > 3 && <span>{tasks.length - 3} more steps in Details</span>}</div>
    {approval && <div className="mt-4 space-y-3 border-t border-border pt-3"><p className="text-xs leading-5 text-muted-foreground">{roles.join(' · ')}<br />Start this task plan? Action permissions and review checks still apply.</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={deciding} onClick={() => void decide('approved')}>{deciding && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Approve and start</Button><Button variant="outline" size="sm" disabled={deciding} onClick={() => void decide('rejected')}>Do not start</Button></div></div>}
    {error && <p role="alert" className="mt-3 break-words text-xs text-destructive">{error}</p>}
  </section>;
}
