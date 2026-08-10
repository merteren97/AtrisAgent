import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Award,
  Check,
  CheckCircle2,
  Code2,
  Database,
  FileEdit,
  FileText,
  GitCompare,
  Hammer,
  ListTodo,
  Package,
  Rocket,
  RotateCcw,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface EventCardProps {
  eventType: string;
  content: string;
  timestamp: string;
  agentRole?: string;
  metadata?: Record<string, unknown>;
}

const ROLE_LABELS: Record<string, string> = {
  orchestrator: 'Orchestrator',
  builder: 'Builder',
  reviewer: 'Reviewer',
  researcher: 'Researcher',
  qa: 'QA',
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function EventCard({ eventType, content, timestamp, agentRole, metadata = {} }: EventCardProps) {
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (eventType === 'plan_generated' || eventType === 'plan_updated') {
    const tasks = Array.isArray(metadata.tasks)
      ? metadata.tasks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : [];

    return (
      <Card accent="bg-primary" border="border-primary/30" background="bg-primary/5">
        <CardHeader
          icon={<FileText className="h-4 w-4 text-primary" />}
          iconClass="bg-primary/20"
          title="Mission plan generated"
          timestamp={timestamp}
          badge="Orchestrator"
        />
        <p className="text-sm leading-relaxed text-foreground/80">
          {content || asString(metadata.summary) || 'The Orchestrator created an execution plan.'}
        </p>
        {tasks.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-border/50 bg-background/60 p-3 text-xs">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Execution steps
            </div>
            {tasks.map((task, index) => {
              const title = asString(task.title) || asString(task.description) || `Task ${index + 1}`;
              const dependencies = Array.isArray(task.dependencies)
                ? task.dependencies.filter((item): item is string => typeof item === 'string')
                : [];
              return (
                <div key={asString(task.id) || `${title}-${index}`} className="flex items-center gap-2">
                  <span className="font-mono font-bold text-primary">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/90">{title}</span>
                  {dependencies.length > 0 && (
                    <Badge variant="secondary" className="h-4 shrink-0 py-0 text-[9px]">
                      Depends on {dependencies.length}
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {asString(metadata.planId) && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              Plan {asString(metadata.planId)!.slice(0, 8)}
            </Badge>
          )}
          {asNumber(metadata.taskCount) !== undefined && (
            <span className="flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2 py-1 text-xs text-muted-foreground">
              <ListTodo className="h-3.5 w-3.5" />
              {asNumber(metadata.taskCount)} tasks
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          A separate approval card is shown when the selected trust mode requires plan approval.
        </p>
      </Card>
    );
  }

  if (eventType === 'approval_requested' || asString(metadata.approvalId)) {
    const approvalId = asString(metadata.approvalId);
    const approvalType = asString(metadata.approvalType) || 'policy';
    const normalizedType = approvalType.replace(/_/g, ' ');

    const handleDecision = async (nextDecision: 'approved' | 'rejected') => {
      if (!approvalId) {
        setSubmitError('This approval event does not include a persisted approval ID. Refresh the mission timeline.');
        return;
      }
      setIsSubmitting(true);
      setSubmitError(null);
      try {
        await apiRequest(`/approvals/${encodeURIComponent(approvalId)}/decide`, {
          method: 'POST',
          body: JSON.stringify({ decision: nextDecision }),
        });
        setDecision(nextDecision);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'The approval decision could not be submitted.');
      } finally {
        setIsSubmitting(false);
      }
    };

    return (
      <Card accent="bg-amber-500" border="border-amber-500/30" background="bg-amber-500/5">
        <CardHeader
          icon={approvalIcon(approvalType)}
          iconClass="bg-amber-500/20"
          title={approvalType === 'plan_approval' ? 'Execution plan approval required' : `${normalizedType} approval required`}
          timestamp={timestamp}
        />
        <p className="text-sm leading-relaxed text-foreground/80">
          {content || asString(metadata.description) || 'The runtime requested permission for a restricted operation.'}
        </p>
        {submitError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
            {submitError}
          </div>
        )}
        <div className="flex items-center gap-2">
          {decision ? (
            <Badge
              variant="outline"
              className={decision === 'approved'
                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
                : 'border-destructive/30 bg-destructive/5 text-destructive'}
            >
              {decision === 'approved' ? 'Approved' : 'Rejected'}
            </Badge>
          ) : (
            <>
              <Button size="sm" disabled={isSubmitting || !approvalId} onClick={() => void handleDecision('approved')}>
                <Check className="mr-1.5 h-4 w-4" /> Approve
              </Button>
              <Button size="sm" variant="outline" disabled={isSubmitting || !approvalId} onClick={() => void handleDecision('rejected')}>
                <X className="mr-1.5 h-4 w-4" /> Reject
              </Button>
            </>
          )}
        </div>
      </Card>
    );
  }

  if (eventType === 'revision_requested' || eventType === 'revision_started') {
    const attempt = asNumber(metadata.attempt);
    const maxAttempts = asNumber(metadata.maxAttempts);
    return (
      <Card accent="bg-amber-500" border="border-amber-500/30" background="bg-gradient-to-br from-amber-500/10 to-transparent">
        <CardHeader
          icon={<RotateCcw className="h-4 w-4 text-amber-400" />}
          iconClass="bg-amber-500/20"
          title="Revision returned to Builder"
          timestamp={timestamp}
          badge="Reviewer → same Builder"
        />
        {(attempt !== undefined || maxAttempts !== undefined) && (
          <Badge variant="secondary" className="w-fit text-[10px]">
            Attempt {attempt ?? '—'} / {maxAttempts ?? '—'}
          </Badge>
        )}
        <div className="rounded-lg border border-amber-500/20 bg-background/50 p-3 text-sm leading-relaxed text-amber-200">
          {content || asString(metadata.reason) || 'The Builder must revise and resubmit the same task.'}
        </div>
      </Card>
    );
  }

  if (eventType === 'file_changed' || eventType === 'changes_applied' || eventType === 'artifact_published') {
    const files = Array.isArray(metadata.files)
      ? metadata.files.filter((item): item is string => typeof item === 'string')
      : asString(metadata.path) ? [asString(metadata.path)!] : [];
    const diff = asString(metadata.diff);
    const checkpointId = asString(metadata.checkpointId);
    return (
      <Card accent="bg-primary" border="border-border" background="bg-card">
        <CardHeader
          icon={<Code2 className="h-4 w-4 text-primary" />}
          iconClass="bg-primary/10"
          title={eventType === 'changes_applied' ? 'Changes applied' : 'Workspace change'}
          timestamp={timestamp}
        />
        <p className="text-sm text-foreground/80">{content}</p>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((file) => <Badge key={file} variant="secondary" className="font-mono text-[10px]">{file}</Badge>)}
          </div>
        )}
        {diff && <pre className="max-h-52 overflow-auto rounded-lg border border-white/10 bg-zinc-950 p-3 text-[11px] text-zinc-300">{diff}</pre>}
        {checkpointId && <Badge variant="outline" className="w-fit text-[10px]">Checkpoint {checkpointId.slice(0, 8)}</Badge>}
      </Card>
    );
  }

  if (eventType === 'candidate_selected' || eventType === 'candidate_comparison' || eventType === 'candidate_evaluated') {
    const selectedCandidateId = asString(metadata.selectedCandidateId);
    const reason = asString(metadata.reason);
    return (
      <Card accent="bg-indigo-500" border="border-indigo-500/30" background="bg-indigo-500/5">
        <CardHeader
          icon={<GitCompare className="h-4 w-4 text-indigo-400" />}
          iconClass="bg-indigo-500/20"
          title={selectedCandidateId ? 'Candidate selected' : 'Candidate evaluation'}
          timestamp={timestamp}
          badge="Isolated worktrees"
        />
        <p className="text-sm text-foreground/80">{reason || content || 'Candidate results are being evaluated from persisted review data.'}</p>
        {selectedCandidateId && <Badge variant="outline" className="w-fit">Candidate {selectedCandidateId.slice(0, 8)}</Badge>}
        {!selectedCandidateId && (
          <p className="text-[11px] text-muted-foreground">Selection is performed by the Orchestrator and Merge Coordinator; the UI does not invent scores.</p>
        )}
      </Card>
    );
  }

  if (eventType === 'mission_completed' || eventType === 'final_summary') {
    const completed = asNumber(metadata.tasksCompleted);
    const total = asNumber(metadata.totalTasks);
    return (
      <Card accent="bg-emerald-500" border="border-emerald-500/30" background="bg-gradient-to-br from-emerald-500/10 to-transparent">
        <CardHeader
          icon={<Award className="h-4 w-4 text-emerald-400" />}
          iconClass="bg-emerald-500/20"
          title="Mission completed"
          timestamp={timestamp}
          badge="Verified workflow"
        />
        <p className="text-sm leading-relaxed text-foreground/90">{content || asString(metadata.summary) || 'The mission completed.'}</p>
        {completed !== undefined && total !== undefined && (
          <Badge variant="outline" className="w-fit border-emerald-500/30 text-emerald-400">{completed}/{total} tasks completed</Badge>
        )}
      </Card>
    );
  }

  const eventConfig: Record<string, { icon: ReactNode; color: string; label: string }> = {
    agent_started: { icon: <Rocket className="h-3.5 w-3.5" />, color: 'text-emerald-400', label: 'Started' },
    agent_progressed: { icon: <Rocket className="h-3.5 w-3.5" />, color: 'text-primary', label: 'Progress' },
    check_completed: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: 'text-emerald-400', label: 'Check' },
    mission_failed: { icon: <XCircle className="h-3.5 w-3.5" />, color: 'text-destructive', label: 'Failed' },
    task_failed: { icon: <XCircle className="h-3.5 w-3.5" />, color: 'text-destructive', label: 'Task failed' },
    approval_responded: { icon: <ShieldAlert className="h-3.5 w-3.5" />, color: 'text-primary', label: 'Approval' },
    tool_call_started: { icon: <Hammer className="h-3.5 w-3.5" />, color: 'text-muted-foreground', label: 'Tool' },
    tool_call_completed: { icon: <Hammer className="h-3.5 w-3.5" />, color: 'text-muted-foreground', label: 'Tool' },
  };
  const config = eventConfig[eventType] || {
    icon: <Rocket className="h-3.5 w-3.5" />,
    color: 'text-muted-foreground',
    label: eventType.replace(/_/g, ' '),
  };

  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <span className={config.color}>{config.icon}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span className="text-xs leading-5 text-foreground/80">{content}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60">{timestamp}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          {agentRole && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{ROLE_LABELS[agentRole] || agentRole}</Badge>}
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] capitalize">{config.label}</Badge>
        </div>
      </div>
    </div>
  );
}

function Card({ children, accent, border, background }: { children: ReactNode; accent: string; border: string; background: string }) {
  return (
    <div className={cn('relative flex flex-col gap-3 overflow-hidden rounded-xl border p-4 shadow-sm', border, background)}>
      <div className={cn('absolute inset-y-0 left-0 w-1', accent)} />
      {children}
    </div>
  );
}

function CardHeader({ icon, iconClass, title, timestamp, badge }: { icon: ReactNode; iconClass: string; title: string; timestamp: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconClass)}>{icon}</div>
      <div className="min-w-0 flex-1">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="truncate">{title}</span>
          {badge && <Badge variant="outline" className="h-4 shrink-0 text-[10px] font-normal">{badge}</Badge>}
        </h4>
        <span className="text-xs text-muted-foreground">{timestamp}</span>
      </div>
    </div>
  );
}

function approvalIcon(approvalType: string): ReactNode {
  if (approvalType.includes('db') || approvalType.includes('migration')) return <Database className="h-4 w-4 text-amber-400" />;
  if (approvalType.includes('package') || approvalType.includes('install')) return <Package className="h-4 w-4 text-amber-400" />;
  if (approvalType.includes('file') || approvalType.includes('write')) return <FileEdit className="h-4 w-4 text-amber-400" />;
  return <AlertTriangle className="h-4 w-4 text-amber-400" />;
}
