import { useEffect, useMemo, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import {
  Archive,
  BadgeCheck,
  Brain,
  Bug,
  CircleDot,
  FileCode2,
  FileDown,
  FolderGit2,
  GitCommitHorizontal,
  Lightbulb,
  ListFilter,
  ListTree,
  Loader2,
  MoreHorizontal,
  Network,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { buildMemoryGraphLayout, connectedMemoryNodeIds } from '@/lib/memory-graph';
import {
  useMemoryStore,
  type CreateMemoryInput,
  type MemoryNode,
  type MemoryNodeStatus,
  type MemoryNodeType,
} from '@/stores/memory-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

type MemoryViewMode = 'graph' | 'notes';

const NODE_TYPES: Array<{ value: MemoryNodeType; label: string }> = [
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

const NODE_STATUSES: Array<{ value: MemoryNodeStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'stale', label: 'Stale' },
  { value: 'superseded', label: 'Superseded' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'archived', label: 'Archived' },
];

function nodeTypeLabel(type: MemoryNodeType): string {
  if (type === 'project') return 'Project';
  return NODE_TYPES.find((item) => item.value === type)?.label || type.replaceAll('_', ' ');
}

function nodeTypeClasses(type: MemoryNodeType): string {
  if (type === 'project') return 'fill-primary stroke-primary';
  if (type === 'research_finding') return 'fill-emerald-400 stroke-emerald-300';
  if (type === 'decision') return 'fill-violet-400 stroke-violet-300';
  if (type === 'requirement' || type === 'user_constraint') return 'fill-amber-400 stroke-amber-300';
  if (type === 'change' || type === 'file' || type === 'symbol' || type === 'component') return 'fill-blue-400 stroke-blue-300';
  if (type === 'bug' || type === 'issue' || type === 'mistake') return 'fill-rose-400 stroke-rose-300';
  if (type === 'verification' || type === 'test') return 'fill-cyan-400 stroke-cyan-300';
  if (type === 'lesson' || type === 'pattern') return 'fill-lime-400 stroke-lime-300';
  return 'fill-muted-foreground stroke-foreground/50';
}

function memoryIcon(type: MemoryNodeType) {
  const className = 'h-3.5 w-3.5 shrink-0';
  if (type === 'project') return <FolderGit2 className={className} />;
  if (type === 'research_finding') return <Search className={className} />;
  if (type === 'decision') return <Brain className={className} />;
  if (type === 'change') return <GitCommitHorizontal className={className} />;
  if (type === 'file' || type === 'symbol' || type === 'component') return <FileCode2 className={className} />;
  if (type === 'bug' || type === 'issue' || type === 'mistake') return <Bug className={className} />;
  if (type === 'verification' || type === 'test') return <BadgeCheck className={className} />;
  if (type === 'user_constraint') return <ShieldCheck className={className} />;
  if (type === 'lesson' || type === 'pattern') return <Lightbulb className={className} />;
  return <CircleDot className={className} />;
}

function statusClass(status: MemoryNodeStatus): string {
  if (status === 'active') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400';
  if (status === 'disputed') return 'border-rose-500/25 bg-rose-500/10 text-rose-400';
  if (status === 'stale') return 'border-amber-500/25 bg-amber-500/10 text-amber-400';
  return 'border-border bg-muted/60 text-muted-foreground';
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project';
}

function formatDate(value?: string | null): string {
  if (!value) return 'Not verified';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

interface NodeEditorState {
  title: string;
  summary: string;
  body: string;
  status: MemoryNodeStatus;
  confidence: number;
  importance: number;
  tags: string;
}

function editorFromNode(node: MemoryNode): NodeEditorState {
  return {
    title: node.title,
    summary: node.summary,
    body: node.body || '',
    status: node.status,
    confidence: node.confidence,
    importance: node.importance,
    tags: node.tags.join(', '),
  };
}

function MemoryNodeDetail({ node, compact }: { node: MemoryNode; compact: boolean }) {
  const { updateMemory, deleteMemory, mutating } = useMemoryStore();
  const [editor, setEditor] = useState<NodeEditorState>(() => editorFromNode(node));
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => setEditor(editorFromNode(node)), [node]);

  const dirty = editor.title !== node.title
    || editor.summary !== node.summary
    || editor.body !== (node.body || '')
    || editor.status !== node.status
    || editor.confidence !== node.confidence
    || editor.importance !== node.importance
    || editor.tags !== node.tags.join(', ');
  const isRoot = node.type === 'project';

  const saveChanges = async () => {
    await updateMemory(node.id, {
      title: editor.title.trim() || node.title,
      summary: editor.summary.trim(),
      body: editor.body.trim() || null,
      status: editor.status,
      confidence: editor.confidence,
      importance: editor.importance,
      tags: editor.tags.split(',').map((item) => item.trim()).filter(Boolean),
    });
  };

  return (
    <div className={cn('min-h-0 border-border bg-card/70', compact ? 'border-t' : 'h-full border-l')}>
      <ScrollArea className="h-full">
        <div className="space-y-4 p-4">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
              {memoryIcon(node.type)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="h-5 text-[9px] uppercase tracking-wide">{nodeTypeLabel(node.type)}</Badge>
                <Badge variant="outline" className={cn('h-5 text-[9px]', statusClass(node.status))}>{node.status}</Badge>
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">Updated {formatDate(node.updatedAt)}</div>
            </div>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  disabled={mutating}
                  onClick={() => void updateMemory(node.id, { pinned: !node.pinned })}
                  aria-label={node.pinned ? 'Unpin memory' : 'Pin memory'}
                >
                  {node.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{node.pinned ? 'Unpin' : 'Pin for recall'}</TooltipContent>
            </Tooltip>
          </div>

          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Title</span>
            <Input value={editor.title} onChange={(event) => setEditor((state) => ({ ...state, title: event.target.value }))} disabled={isRoot} />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Summary</span>
            <textarea
              value={editor.summary}
              onChange={(event) => setEditor((state) => ({ ...state, summary: event.target.value }))}
              className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs outline-none focus:border-ring"
              disabled={isRoot}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Details</span>
            <textarea
              value={editor.body}
              onChange={(event) => setEditor((state) => ({ ...state, body: event.target.value }))}
              className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:border-ring"
              disabled={isRoot}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status</span>
              <select
                value={editor.status}
                onChange={(event) => setEditor((state) => ({ ...state, status: event.target.value as MemoryNodeStatus }))}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                disabled={isRoot}
              >
                {NODE_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
              </select>
            </label>
            <label className="space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</span>
              <Input value={editor.tags} onChange={(event) => setEditor((state) => ({ ...state, tags: event.target.value }))} placeholder="architecture, auth" disabled={isRoot} />
            </label>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
            <label className="block space-y-1.5">
              <span className="flex justify-between text-[10px] font-medium text-muted-foreground"><span>Importance</span><span>{Math.round(editor.importance * 100)}%</span></span>
              <input type="range" min="0" max="1" step="0.05" value={editor.importance} onChange={(event) => setEditor((state) => ({ ...state, importance: Number(event.target.value) }))} className="w-full accent-primary" disabled={isRoot} />
            </label>
            <label className="block space-y-1.5">
              <span className="flex justify-between text-[10px] font-medium text-muted-foreground"><span>Confidence</span><span>{Math.round(editor.confidence * 100)}%</span></span>
              <input type="range" min="0" max="1" step="0.05" value={editor.confidence} onChange={(event) => setEditor((state) => ({ ...state, confidence: Number(event.target.value) }))} className="w-full accent-primary" disabled={isRoot} />
            </label>
          </div>

          <div className="rounded-lg border border-border bg-muted/15 p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Provenance</div>
            <div className="space-y-2">
              {node.provenance.length === 0 ? <p className="text-[11px] text-muted-foreground">No provenance recorded.</p> : node.provenance.map((source, index) => (
                <div key={`${source.sourceId || source.sourceType}-${index}`} className="rounded-md border border-border/70 bg-background/50 p-2 text-[10px] leading-relaxed text-muted-foreground">
                  <div className="font-medium text-foreground/80">{source.sourceType} · {source.createdBy}</div>
                  {source.path ? <div className="break-all font-mono">{source.path}</div> : null}
                  {source.missionId ? <div className="font-mono">mission:{source.missionId.slice(0, 12)}</div> : null}
                  {source.taskId ? <div className="font-mono">task:{source.taskId.slice(0, 12)}</div> : null}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <div className="text-[10px] text-muted-foreground">Last verified: {formatDate(node.lastVerifiedAt)}</div>
            <div className="flex gap-2">
              {!isRoot && (
                <Button variant="ghost" size="sm" className="h-7 text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)} disabled={mutating}>
                  <Trash2 className="mr-1.5 h-3 w-3" />Delete
                </Button>
              )}
              {!isRoot && (
                <Button size="sm" className="h-7" onClick={() => void saveChanges()} disabled={!dirty || mutating}>
                  {mutating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}Save
                </Button>
              )}
            </div>
          </div>
        </div>
      </ScrollArea>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-[430px]">
          <DialogHeader>
            <DialogTitle>Delete memory node?</DialogTitle>
            <DialogDescription>This removes the curated node and its graph edges. The immutable historical evidence ledger is retained.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void deleteMemory(node.id).then((ok) => ok && setDeleteOpen(false))} disabled={mutating}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete node
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MemoryGraph({ nodes, edges, selectedNodeId, onSelect }: {
  nodes: MemoryNode[];
  edges: Array<{ id: string; fromNodeId: string; toNodeId: string; type: string }>;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const [zoom, setZoom] = useState(0.92);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const layout = useMemo(() => buildMemoryGraphLayout(nodes, edges, 500), [nodes, edges]);
  const pointById = useMemo(() => new Map(layout.points.map((point) => [point.id, point])), [layout.points]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighborhood = useMemo(() => selectedNodeId ? connectedMemoryNodeIds(selectedNodeId, edges) : null, [edges, selectedNodeId]);

  const resetView = () => {
    setZoom(0.92);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div className="relative h-full min-h-[240px] overflow-hidden bg-[radial-gradient(circle_at_center,hsl(var(--muted)/0.35),transparent_68%)]">
      <svg
        className="h-full w-full touch-none"
        viewBox="-560 -560 1120 1120"
        onWheel={(event) => {
          event.preventDefault();
          const direction = event.deltaY > 0 ? -0.08 : 0.08;
          setZoom((value) => Math.max(0.35, Math.min(2.4, value + direction)));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const scale = 1120 / Math.max(1, event.currentTarget.clientWidth);
          setPan({
            x: drag.current.panX + (event.clientX - drag.current.x) * scale,
            y: drag.current.panY + (event.clientY - drag.current.y) * scale,
          });
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {edges.map((edge) => {
            const from = pointById.get(edge.fromNodeId);
            const to = pointById.get(edge.toNodeId);
            if (!from || !to) return null;
            const active = !selectedNodeId || edge.fromNodeId === selectedNodeId || edge.toNodeId === selectedNodeId;
            return (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={cn('stroke-border transition-opacity', active ? 'opacity-70' : 'opacity-15')}
                strokeWidth={active && selectedNodeId ? 1.8 : 1.1}
              />
            );
          })}
          {layout.points.map((point) => {
            const node = nodeById.get(point.id);
            if (!node) return null;
            const selected = selectedNodeId === node.id;
            const related = !neighborhood || neighborhood.has(node.id);
            return (
              <g
                key={node.id}
                transform={`translate(${point.x} ${point.y})`}
                className={cn('cursor-pointer transition-opacity', related ? 'opacity-100' : 'opacity-20')}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}
              >
                {selected ? <circle r={point.radius + 7} className="fill-primary/10 stroke-primary/60" strokeWidth="2" /> : null}
                <circle r={point.radius} className={cn('stroke-[1.5] transition-all', nodeTypeClasses(node.type))} />
                {node.pinned ? <circle r="2.3" cy={-(point.radius + 5)} className="fill-amber-300" /> : null}
                {(selected || point.radius >= 11) && (
                  <text y={point.radius + 14} textAnchor="middle" className="pointer-events-none fill-foreground text-[10px] font-medium">
                    {node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md border border-border bg-background/85 p-1 shadow-sm backdrop-blur">
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6" onClick={resetView}><RotateCcw className="h-3 w-3" /></Button></TooltipTrigger>
          <TooltipContent>Reset graph view</TooltipContent>
        </Tooltip>
        <span className="px-1 text-[9px] tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
      </div>
      {layout.truncated ? (
        <div className="absolute bottom-2 left-2 right-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[9px] text-amber-300">
          Showing the 500 highest-value/most-connected nodes. Use search or filters to narrow the graph.
        </div>
      ) : null}
    </div>
  );
}

function NotesList({ nodes, selectedNodeId, onSelect }: { nodes: MemoryNode[]; selectedNodeId: string | null; onSelect: (nodeId: string) => void }) {
  const ordered = useMemo(() => [...nodes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return b.updatedAt.localeCompare(a.updatedAt);
  }), [nodes]);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 p-3">
        {ordered.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center text-center text-muted-foreground">
            <ListTree className="mb-2 h-6 w-6 opacity-50" />
            <p className="text-xs font-medium">No memory nodes match this view.</p>
            <p className="mt-1 max-w-56 text-[10px]">Clear search or filters, or add a manual memory note.</p>
          </div>
        ) : ordered.slice(0, 750).map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelect(node.id)}
            className={cn(
              'w-full rounded-lg border p-3 text-left transition-colors',
              selectedNodeId === node.id ? 'border-primary/50 bg-primary/8' : 'border-border bg-card/45 hover:bg-accent/40',
            )}
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 text-muted-foreground">{memoryIcon(node.type)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{node.title}</span>
                  {node.pinned ? <Pin className="h-3 w-3 shrink-0 text-amber-300" /> : null}
                </div>
                <div className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-muted-foreground">{node.summary}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <Badge variant="outline" className="h-4 px-1.5 text-[8px]">{nodeTypeLabel(node.type)}</Badge>
                  <Badge variant="outline" className={cn('h-4 px-1.5 text-[8px]', statusClass(node.status))}>{node.status}</Badge>
                  {node.tags.slice(0, 3).map((tag) => <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[8px] text-muted-foreground">#{tag}</span>)}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

export function MemoryTab() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
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
  const [viewMode, setViewMode] = useState<MemoryViewMode>('graph');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<MemoryNodeType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<MemoryNodeStatus | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateMemoryInput>({
    type: 'decision',
    title: '',
    summary: '',
    body: '',
    tags: [],
    importance: 0.75,
    confidence: 0.9,
    pinned: false,
  });

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

  const selectedProjectOverview = projects.find((item) => item.project.id === selectedProjectId) || (snapshot ? snapshot : null);
  const selectedNode = snapshot?.nodes.find((node) => node.id === selectedNodeId) || null;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
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
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => (snapshot?.edges || []).filter((edge) => visibleNodeIds.has(edge.fromNodeId) && visibleNodeIds.has(edge.toNodeId)), [snapshot, visibleNodeIds]);

  const selectProject = async (projectId: string) => {
    setQuery('');
    clearSearch();
    await loadProject(projectId);
  };

  const handleExport = async () => {
    if (!snapshot) return;
    try {
      const targetPath = await save({
        title: 'Export AtrisAgent project memory',
        defaultPath: `${safeFilename(snapshot.project.displayName)}-atris-memory.json`,
        filters: [{ name: 'AtrisAgent Memory Backup', extensions: ['json'] }],
      });
      if (!targetPath) return;
      await exportProject(snapshot.project.id, targetPath);
    } catch (exportError) {
      console.error('[MemoryTab] Export dialog failed:', exportError);
    }
  };

  const handleCreate = async () => {
    if (!createDraft.title?.trim() || !createDraft.summary?.trim()) return;
    const node = await createMemory(createDraft);
    if (!node) return;
    setCreateOpen(false);
    setCreateDraft({ type: 'decision', title: '', summary: '', body: '', tags: [], importance: 0.75, confidence: 0.9, pinned: false });
  };

  if (!snapshot && loading) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading project memory…</div>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-card">
      <div className="shrink-0 border-b border-border bg-muted/10 p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary"><Brain className="h-3.5 w-3.5" /></div>
          <select
            value={selectedProjectId || ''}
            onChange={(event) => void selectProject(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[11px] font-medium outline-none"
          >
            {projects.length === 0 ? <option value="">No project memory yet</option> : projects.map((item) => (
              <option key={item.project.id} value={item.project.id}>{item.project.displayName} · {item.project.status}</option>
            ))}
          </select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0"><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => selectedProjectId && void loadProject(selectedProjectId)}><RefreshCw className="h-3.5 w-3.5" />Refresh memory</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleExport()} disabled={!snapshot}><FileDown className="h-3.5 w-3.5" />Export backup</DropdownMenuItem>
              <DropdownMenuSeparator />
              {snapshot?.project.status === 'archived' ? (
                <DropdownMenuItem onClick={() => void restoreProject(snapshot.project.id)}><RotateCcw className="h-3.5 w-3.5" />Restore project memory</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => snapshot && void archiveProject(snapshot.project.id)} disabled={!snapshot}><Archive className="h-3.5 w-3.5" />Archive from recall</DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteProjectOpen(true)}
                disabled={!snapshot || snapshot.activeWorkspaceIds.length > 0}
              >
                <Trash2 className="h-3.5 w-3.5" />Delete memory permanently
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search project memory…" className="h-8 pl-7 pr-7 text-[11px]" />
            {query ? <button type="button" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button> : null}
          </div>
          <Button variant="outline" size="sm" className="h-8 shrink-0 px-2" onClick={() => setCreateOpen(true)} disabled={!snapshot || snapshot.project.status === 'archived'}>
            <Plus className="h-3.5 w-3.5" /><span className="ml-1 hidden 2xl:inline">Memory</span>
          </Button>
        </div>

        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <div className="flex shrink-0 items-center rounded-md border border-border bg-background p-0.5">
            <button type="button" onClick={() => setViewMode('graph')} className={cn('flex h-6 items-center gap-1 rounded px-2 text-[9px]', viewMode === 'graph' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground')}><Network className="h-3 w-3" />Graph</button>
            <button type="button" onClick={() => setViewMode('notes')} className={cn('flex h-6 items-center gap-1 rounded px-2 text-[9px]', viewMode === 'notes' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground')}><ListTree className="h-3 w-3" />Notes</button>
          </div>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as MemoryNodeType | 'all')} className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[9px] outline-none">
            <option value="all">All types</option>
            <option value="project">Project</option>
            {NODE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as MemoryNodeStatus | 'all')} className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[9px] outline-none">
            <option value="all">All states</option>
            {NODE_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
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

      {error ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/8 px-3 py-2 text-[10px] text-destructive">
          <span className="min-w-0 flex-1">{error}</span><button onClick={clearError}><X className="h-3 w-3" /></button>
        </div>
      ) : null}

      {!snapshot ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-muted-foreground">
          <Brain className="mb-3 h-8 w-8 opacity-40" />
          <p className="text-xs font-medium text-foreground">No project memory selected</p>
          <p className="mt-1 max-w-64 text-[10px] leading-relaxed">Open a project workspace or select a retained memory backup above.</p>
        </div>
      ) : (
        <div className={cn('min-h-0 flex-1', inspectorExpanded ? 'flex' : 'flex flex-col')}>
          <div className="min-h-0 min-w-0 flex-1">
            {viewMode === 'graph' ? (
              <MemoryGraph nodes={visibleNodes} edges={visibleEdges} selectedNodeId={selectedNodeId} onSelect={selectNode} />
            ) : (
              <NotesList nodes={visibleNodes} selectedNodeId={selectedNodeId} onSelect={selectNode} />
            )}
          </div>
          {selectedNode ? (
            <div className={cn(inspectorExpanded ? 'w-[380px] min-w-[340px] max-w-[440px]' : 'max-h-[46%] min-h-[220px]')}>
              <MemoryNodeDetail node={selectedNode} compact={!inspectorExpanded} />
            </div>
          ) : (
            inspectorExpanded ? (
              <div className="flex w-[340px] shrink-0 items-center justify-center border-l border-border bg-muted/10 px-8 text-center text-[11px] text-muted-foreground">
                Select a graph node or note to inspect provenance, confidence, status, tags, and editable memory details.
              </div>
            ) : null
          )}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Add project memory</DialogTitle>
            <DialogDescription>Add a durable human-authored fact, decision, constraint, or lesson. Manual memory is stored with user provenance.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Type</span><select value={createDraft.type} onChange={(event) => setCreateDraft((state) => ({ ...state, type: event.target.value as MemoryNodeType }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="decision">Decision</option><option value="user_constraint">Constraint</option><option value="requirement">Requirement</option><option value="lesson">Lesson</option><option value="pattern">Pattern</option><option value="research_finding">Research finding</option><option value="issue">Issue</option></select></label>
              <label className="space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Tags</span><Input value={(createDraft.tags || []).join(', ')} onChange={(event) => setCreateDraft((state) => ({ ...state, tags: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) }))} placeholder="architecture, ui" /></label>
            </div>
            <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Title</span><Input value={createDraft.title} onChange={(event) => setCreateDraft((state) => ({ ...state, title: event.target.value }))} /></label>
            <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Summary</span><textarea value={createDraft.summary} onChange={(event) => setCreateDraft((state) => ({ ...state, summary: event.target.value }))} className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs outline-none" /></label>
            <label className="block space-y-1"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Details</span><textarea value={createDraft.body || ''} onChange={(event) => setCreateDraft((state) => ({ ...state, body: event.target.value }))} className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-xs outline-none" /></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(createDraft.pinned)} onChange={(event) => setCreateDraft((state) => ({ ...state, pinned: event.target.checked }))} className="accent-primary" />Pin this memory for higher recall priority</label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleCreate()} disabled={mutating || !createDraft.title?.trim() || !createDraft.summary?.trim()}>{mutating ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-2 h-3.5 w-3.5" />}Add memory</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteProjectOpen} onOpenChange={setDeleteProjectOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Delete retained project memory?</DialogTitle>
            <DialogDescription>
              This permanently removes the project memory graph, curated notes, and evidence ledger. This is only allowed after every local workspace attachment has been removed. Export a JSON backup first if you may need the memory later.
            </DialogDescription>
          </DialogHeader>
          {snapshot ? <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs"><strong>{snapshot.project.displayName}</strong><div className="mt-1 text-muted-foreground">{snapshot.nodes.length} nodes · {snapshot.edges.length} links · {snapshot.evidenceCount} evidence records</div></div> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteProjectOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={!snapshot || snapshot.activeWorkspaceIds.length > 0 || mutating} onClick={() => snapshot && void deleteProjectMemory(snapshot.project.id).then((ok) => ok && setDeleteProjectOpen(false))}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete memory permanently</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeWorkspace && selectedProjectOverview && snapshot?.activeWorkspaceIds.includes(activeWorkspace.id) ? null : null}
    </div>
  );
}
