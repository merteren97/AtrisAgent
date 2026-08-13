import { useEffect, useMemo, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import {
  Archive,
  Brain,
  FileDown,
  Loader2,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
  ListTree,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { MemoryGraphView } from './memory-graph-view';
import { MemoryNodeDetail } from './memory-node-detail';
import { MemoryNotesView } from './memory-notes-view';
import {
  useMemoryStore,
  type CreateMemoryInput,
  type MemoryNodeStatus,
  type MemoryNodeType,
} from '@/stores/memory-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

type ViewMode = 'graph' | 'notes';

const FILTER_TYPES: Array<{ value: MemoryNodeType; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'decision', label: 'Decision' },
  { value: 'research_finding', label: 'Research' },
  { value: 'requirement', label: 'Requirement' },
  { value: 'user_constraint', label: 'Constraint' },
  { value: 'change', label: 'Change' },
  { value: 'file', label: 'File' },
  { value: 'bug', label: 'Bug' },
  { value: 'issue', label: 'Issue' },
  { value: 'lesson', label: 'Lesson' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'task', label: 'Task' },
  { value: 'verification', label: 'Verification' },
  { value: 'test', label: 'Test' },
  { value: 'artifact', label: 'Artifact' },
  { value: 'component', label: 'Component' },
  { value: 'symbol', label: 'Symbol' },
  { value: 'external_source', label: 'External source' },
  { value: 'mistake', label: 'Mistake' },
  { value: 'session', label: 'Session' },
  { value: 'turn', label: 'Turn' },
  { value: 'agent_run', label: 'Agent run' },
];

const FILTER_STATUSES: Array<{ value: MemoryNodeStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'stale', label: 'Stale' },
  { value: 'superseded', label: 'Superseded' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'archived', label: 'Archived' },
];

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';
}

function emptyDraft(): CreateMemoryInput {
  return {
    type: 'decision',
    title: '',
    summary: '',
    body: '',
    tags: [],
    importance: 0.75,
    confidence: 0.9,
    pinned: false,
  };
}

export function MemoryTab() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const inspectorExpanded = useSettingsStore((state) => state.inspectorExpanded);
  const {
    projects,
    snapshot,
    selectedProjectId,
    selectedNodeId,
    searchHits,
    loading,
    mutating,
    error,
    fetchProjects,
    loadWorkspaceMemory,
    loadProject,
    selectNode,
    search: searchMemory,
    clearSearch,
    createMemory,
    archiveProject,
    restoreProject,
    deleteProjectMemory,
    exportProject,
    clearError,
  } = useMemoryStore();

  const [viewMode, setViewMode] = useState<ViewMode>('graph');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<MemoryNodeType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<MemoryNodeStatus | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false);
  const [draft, setDraft] = useState<CreateMemoryInput>(emptyDraft);
  const [draftTags, setDraftTags] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const known = await fetchProjects();
      if (cancelled) return;
      if (activeWorkspaceId) {
        await loadWorkspaceMemory(activeWorkspaceId);
        return;
      }
      const current = useMemoryStore.getState().selectedProjectId;
      const fallback = current || known[0]?.project.id;
      if (fallback) await loadProject(fallback);
    })();
    return () => { cancelled = true; };
  }, [activeWorkspaceId, fetchProjects, loadProject, loadWorkspaceMemory]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (!query.trim()) {
        clearSearch();
        return;
      }
      void searchMemory(
        query,
        typeFilter === 'all' ? [] : [typeFilter],
        statusFilter === 'all' ? [] : [statusFilter],
      );
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [clearSearch, query, searchMemory, statusFilter, typeFilter]);

  const selectedNode = snapshot?.nodes.find((node) => node.id === selectedNodeId) || null;
  const hitIds = useMemo(() => new Set(searchHits.map((hit) => hit.node.id)), [searchHits]);
  const visibleNodes = useMemo(() => {
    if (!snapshot) return [];
    let nodes = snapshot.nodes.filter((node) =>
      (typeFilter === 'all' || node.type === typeFilter)
      && (statusFilter === 'all' || node.status === statusFilter),
    );
    if (query.trim()) {
      const expanded = new Set(hitIds);
      for (const edge of snapshot.edges) {
        if (hitIds.has(edge.fromNodeId)) expanded.add(edge.toNodeId);
        if (hitIds.has(edge.toNodeId)) expanded.add(edge.fromNodeId);
      }
      nodes = nodes.filter((node) => expanded.has(node.id));
    }
    return nodes;
  }, [hitIds, query, snapshot, statusFilter, typeFilter]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => (snapshot?.edges || []).filter((edge) => visibleIds.has(edge.fromNodeId) && visibleIds.has(edge.toNodeId)),
    [snapshot, visibleIds],
  );

  const chooseProject = async (projectId: string) => {
    if (!projectId) return;
    setQuery('');
    clearSearch();
    selectNode(null);
    await loadProject(projectId);
  };

  const exportBackup = async () => {
    if (!snapshot) return;
    try {
      const targetPath = await save({
        title: 'Export AtrisAgent project memory',
        defaultPath: `${safeFilename(snapshot.project.displayName)}-atris-memory.json`,
        filters: [{ name: 'AtrisAgent Memory Backup', extensions: ['json'] }],
      });
      if (!targetPath) return;
      const result = await exportProject(snapshot.project.id, targetPath);
      if (result) setNotice(`Memory backup exported (${Math.ceil(result.bytes / 1024)} KB).`);
    } catch (dialogError) {
      console.error('[MemoryTab] Native save dialog failed:', dialogError);
      setNotice('Could not open the native backup dialog.');
    }
  };

  const addMemory = async () => {
    if (!draft.title.trim() || !draft.summary.trim()) return;
    const created = await createMemory({
      ...draft,
      tags: draftTags.split(',').map((item) => item.trim()).filter(Boolean),
    });
    if (!created) return;
    setDraft(emptyDraft());
    setDraftTags('');
    setCreateOpen(false);
    setNotice('Project memory added.');
  };

  if (!snapshot && loading) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading project memory…</div>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-card">
      <div className="shrink-0 border-b border-border bg-muted/10 p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary"><Brain className="h-3.5 w-3.5" /></div>
          <select value={selectedProjectId || ''} onChange={(event) => void chooseProject(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[11px] font-medium outline-none">
            {projects.length === 0 ? <option value="">No project memory yet</option> : projects.map((item) => (
              <option key={item.project.id} value={item.project.id}>{item.project.displayName} · {item.project.status}</option>
            ))}
          </select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Memory actions"><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => selectedProjectId && void loadProject(selectedProjectId)}><RefreshCw className="h-3.5 w-3.5" />Refresh memory</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportBackup()} disabled={!snapshot}><FileDown className="h-3.5 w-3.5" />Export JSON backup</DropdownMenuItem>
              <DropdownMenuSeparator />
              {snapshot?.project.status === 'archived' ? (
                <DropdownMenuItem onClick={() => void restoreProject(snapshot.project.id).then((ok) => ok && setNotice('Project memory restored to recall.'))}><RotateCcw className="h-3.5 w-3.5" />Restore to recall</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => snapshot && void archiveProject(snapshot.project.id).then((ok) => ok && setNotice('Project memory archived from normal recall.'))} disabled={!snapshot}><Archive className="h-3.5 w-3.5" />Archive from recall</DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteProjectOpen(true)} disabled={!snapshot || snapshot.activeWorkspaceIds.length > 0}><Trash2 className="h-3.5 w-3.5" />Delete memory permanently</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search project memory…" className="h-8 pl-7 pr-7 text-[11px]" />
            {query ? <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear memory search"><X className="h-3 w-3" /></button> : null}
          </div>
          <Button variant="outline" size="sm" className="h-8 shrink-0 px-2" onClick={() => setCreateOpen(true)} disabled={!snapshot || snapshot.project.status === 'archived'}><Plus className="h-3.5 w-3.5" /><span className="ml-1 hidden 2xl:inline">Memory</span></Button>
        </div>

        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <div className="flex shrink-0 items-center rounded-md border border-border bg-background p-0.5">
            <button type="button" onClick={() => setViewMode('graph')} className={cn('flex h-6 items-center gap-1 rounded px-2 text-[9px]', viewMode === 'graph' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground')}><Network className="h-3 w-3" />Graph</button>
            <button type="button" onClick={() => setViewMode('notes')} className={cn('flex h-6 items-center gap-1 rounded px-2 text-[9px]', viewMode === 'notes' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground')}><ListTree className="h-3 w-3" />Notes</button>
          </div>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as MemoryNodeType | 'all')} className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[9px] outline-none">
            <option value="all">All types</option>{FILTER_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as MemoryNodeStatus | 'all')} className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[9px] outline-none">
            <option value="all">All states</option>{FILTER_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>

        {snapshot ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
            <span><strong className="text-foreground">{snapshot.space?.nodeCount ?? snapshot.nodes.length}</strong> nodes</span>
            <span><strong className="text-foreground">{snapshot.space?.edgeCount ?? snapshot.edges.length}</strong> links</span>
            <span><strong className="text-foreground">{snapshot.evidenceCount}</strong> evidence</span>
            <span className="ml-auto flex items-center gap-1"><Sparkles className="h-2.5 w-2.5 text-primary" />{snapshot.project.status}</span>
          </div>
        ) : null}
      </div>

      {notice ? <div className="flex shrink-0 items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/8 px-3 py-2 text-[10px] text-emerald-400"><span className="min-w-0 flex-1">{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss notification"><X className="h-3 w-3" /></button></div> : null}
      {error ? <div className="flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/8 px-3 py-2 text-[10px] text-destructive"><span className="min-w-0 flex-1">{error}</span><button onClick={clearError} aria-label="Dismiss memory error"><X className="h-3 w-3" /></button></div> : null}

      {!snapshot ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-muted-foreground">
          <Brain className="mb-3 h-8 w-8 opacity-40" />
          <p className="text-xs font-medium text-foreground">No project memory selected</p>
          <p className="mt-1 max-w-64 text-[10px] leading-relaxed">Open a project workspace or select a retained memory backup above.</p>
        </div>
      ) : (
        <div className={cn(
          'min-h-0 flex-1 overflow-hidden',
          inspectorExpanded
            ? 'flex'
            : selectedNode
              ? 'grid grid-rows-[minmax(0,1fr)_minmax(220px,46%)]'
              : 'flex flex-col',
        )}>
          <div className="min-h-0 min-w-0 overflow-hidden">
            {viewMode === 'graph'
              ? <MemoryGraphView nodes={visibleNodes} edges={visibleEdges} selectedNodeId={selectedNodeId} onSelect={selectNode} />
              : <MemoryNotesView nodes={visibleNodes} selectedNodeId={selectedNodeId} onSelect={selectNode} />}
          </div>
          {selectedNode ? (
            <div className={cn(
              'min-h-0 overflow-hidden [&>div]:h-full [&>div]:min-h-0',
              inspectorExpanded ? 'w-[380px] min-w-[340px] max-w-[440px] shrink-0' : 'h-full',
            )}>
              <MemoryNodeDetail node={selectedNode} compact={!inspectorExpanded} />
            </div>
          ) : inspectorExpanded ? (
            <div className="flex w-[340px] shrink-0 items-center justify-center border-l border-border bg-muted/10 px-8 text-center text-[11px] text-muted-foreground">Select a graph node or note to inspect provenance, confidence, status, tags, and editable details.</div>
          ) : null}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader><DialogTitle>Add project memory</DialogTitle><DialogDescription>Add a durable human-authored decision, constraint, requirement, lesson, or research note. It will be stored with user provenance.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Type</span><select value={draft.type} onChange={(event) => setDraft((state) => ({ ...state, type: event.target.value as MemoryNodeType }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="decision">Decision</option><option value="user_constraint">Constraint</option><option value="requirement">Requirement</option><option value="lesson">Lesson</option><option value="pattern">Pattern</option><option value="research_finding">Research finding</option><option value="issue">Issue</option></select></label>
              <label className="space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Tags</span><Input value={draftTags} onChange={(event) => setDraftTags(event.target.value)} placeholder="architecture, ui" /></label>
            </div>
            <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Title</span><Input value={draft.title} onChange={(event) => setDraft((state) => ({ ...state, title: event.target.value }))} /></label>
            <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Summary</span><textarea value={draft.summary} onChange={(event) => setDraft((state) => ({ ...state, summary: event.target.value }))} className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs outline-none" /></label>
            <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Details</span><textarea value={draft.body || ''} onChange={(event) => setDraft((state) => ({ ...state, body: event.target.value }))} className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-xs outline-none" /></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(draft.pinned)} onChange={(event) => setDraft((state) => ({ ...state, pinned: event.target.checked }))} className="accent-primary" />Pin for higher recall priority</label>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button><Button onClick={() => void addMemory()} disabled={mutating || !draft.title.trim() || !draft.summary.trim()}>{mutating ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-2 h-3.5 w-3.5" />}Add memory</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteProjectOpen} onOpenChange={setDeleteProjectOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader><DialogTitle>Delete retained project memory?</DialogTitle><DialogDescription>This permanently removes the graph, curated notes, and immutable evidence ledger. It is only allowed after all workspace attachments have been removed. Export a JSON backup first if you may need it later.</DialogDescription></DialogHeader>
          {snapshot ? <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs"><strong>{snapshot.project.displayName}</strong><div className="mt-1 text-muted-foreground">{snapshot.nodes.length} nodes · {snapshot.edges.length} links · {snapshot.evidenceCount} evidence records</div></div> : null}
          <DialogFooter><Button variant="outline" onClick={() => setDeleteProjectOpen(false)}>Cancel</Button><Button variant="destructive" disabled={!snapshot || snapshot.activeWorkspaceIds.length > 0 || mutating} onClick={() => snapshot && void deleteProjectMemory(snapshot.project.id).then((ok) => ok && setDeleteProjectOpen(false))}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete memory permanently</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
