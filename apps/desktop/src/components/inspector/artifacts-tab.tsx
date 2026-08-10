import { useEffect, useState } from 'react';
import { Package, FileText, FileCode2, FileBarChart, File, Loader2, RefreshCw } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { useMissionStore } from '@/stores/mission-store';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface Artifact { id: string; name: string; type: string; sizeBytes?: number | null; createdAt: string; missionId: string; path?: string | null; content?: string | null }

export function ArtifactsTab() {
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!activeMissionId) { setArtifacts([]); return; }
    setLoading(true); setError(null);
    try {
      const items = await apiRequest<Artifact[]>(`/missions/${activeMissionId}/artifacts`);
      setArtifacts(items); setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id || null);
    } catch (cause: any) { setError(cause?.message || 'Artifacts could not be loaded.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [activeMissionId]);
  const selected = artifacts.find((artifact) => artifact.id === selectedId);

  if (!activeMissionId || artifacts.length === 0) return <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-foreground"><Package className="mb-3 h-10 w-10 opacity-20" /><p className="mb-4 max-w-xs text-xs">{error || (activeMissionId ? 'No persisted artifact has been published by the agents yet.' : 'Select a mission to see its artifacts.')}</p>{activeMissionId && <Button size="sm" variant="outline" onClick={() => void load()}>{loading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}Refresh</Button>}</div>;

  return <div className="flex h-full min-h-0"><ScrollArea className="w-2/5 border-r border-border"><div className="space-y-1.5 p-2">{artifacts.map((artifact) => <button key={artifact.id} onClick={() => setSelectedId(artifact.id)} className={cn('flex w-full items-center gap-2 rounded-lg border p-2 text-left', selectedId === artifact.id ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-muted/50')}>{getIcon(artifact.type)}<div className="min-w-0"><div className="truncate text-xs font-medium">{artifact.name}</div><div className="text-[10px] text-muted-foreground">{formatBytes(artifact.sizeBytes)} · {new Date(artifact.createdAt).toLocaleString()}</div></div></button>)}</div></ScrollArea><ScrollArea className="flex-1"><div className="p-3"><h3 className="text-sm font-medium">{selected?.name}</h3>{selected?.path && <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{selected.path}</p>}<pre className="mt-4 whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground">{selected?.content || 'This artifact references a local file. Open it from the workspace or Developer Mode.'}</pre></div></ScrollArea></div>;
}
function getIcon(type: string) { if (type.includes('plan')) return <FileText className="h-4 w-4" />; if (type.includes('code') || type.includes('diff')) return <FileCode2 className="h-4 w-4" />; if (type.includes('report')) return <FileBarChart className="h-4 w-4" />; return <File className="h-4 w-4" />; }
function formatBytes(value?: number | null) { if (!value) return 'Size unknown'; if (value < 1024) return `${value} B`; return `${(value / 1024).toFixed(1)} KB`; }
