import { useEffect, useState, type ReactNode } from 'react';
import { Shield, CheckCircle2, XCircle, Loader2, RefreshCw } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { useMissionStore } from '@/stores/mission-store';
import { apiRequest } from '@/lib/api-client';

interface CheckEvent { id: string; type: 'check_completed'; taskId: string; checkName: string; passed: boolean; summary: string; timestamp: string }

export function ChecksTab() {
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const [checks, setChecks] = useState<CheckEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!activeMissionId) { setChecks([]); return; }
    setLoading(true); setError(null);
    try {
      const events = await apiRequest<Array<Record<string, unknown>>>(`/missions/${activeMissionId}/events`);
      setChecks(events.filter((event) => event.type === 'check_completed').map((event) => event as unknown as CheckEvent));
    } catch (cause: any) {
      setError(cause?.message || 'Check results could not be loaded.');
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [activeMissionId]);
  const passed = checks.filter((check) => check.passed).length;

  if (!activeMissionId) return <Empty text="Select a mission to see its QA checks." />;
  if (!checks.length) return <Empty text={error || 'No real check result has been emitted yet. QA and runtime checks will appear here; AtrisAgent does not simulate test output.'} action={<Button size="sm" variant="outline" onClick={() => void load()}>{loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}Refresh</Button>} />;

  return <div className="flex h-full flex-col"><div className="flex items-center justify-between border-b border-border bg-muted/20 p-3 text-xs"><span>{passed}/{checks.length} checks passed</span><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void load()}><RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /></Button></div><ScrollArea className="flex-1"><div className="space-y-2 p-3">{checks.map((check) => <div key={check.id} className="rounded-lg border border-border bg-card p-3"><div className="flex items-center gap-2 text-sm font-medium">{check.passed ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-rose-400" />}{check.checkName}</div><p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{check.summary}</p><div className="mt-2 text-[10px] text-muted-foreground">{new Date(check.timestamp).toLocaleString()}</div></div>)}</div></ScrollArea></div>;
}

function Empty({ text, action }: { text: string; action?: ReactNode }) { return <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-foreground"><Shield className="mb-3 h-10 w-10 opacity-20" /><p className="mb-4 max-w-xs text-xs">{text}</p>{action}</div>; }
