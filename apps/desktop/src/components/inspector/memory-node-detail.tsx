import { useEffect, useState } from 'react';
import { Loader2, Pin, PinOff, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { memoryStatusClass, memoryTypeIcon, memoryTypeLabel } from './memory-notes-view';
import { useMemoryStore, type MemoryNode, type MemoryNodeStatus } from '@/stores/memory-store';

interface EditorState {
  title: string;
  summary: string;
  body: string;
  status: MemoryNodeStatus;
  confidence: number;
  importance: number;
  tags: string;
}

function formatDate(value?: string | null): string {
  if (!value) return 'Not verified';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function fromNode(node: MemoryNode): EditorState {
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

export function MemoryNodeDetail({ node, compact }: { node: MemoryNode; compact: boolean }) {
  const { updateMemory, deleteMemory, mutating } = useMemoryStore();
  const [editor, setEditor] = useState<EditorState>(() => fromNode(node));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isRoot = node.type === 'project';

  useEffect(() => setEditor(fromNode(node)), [node]);

  const dirty = editor.title !== node.title
    || editor.summary !== node.summary
    || editor.body !== (node.body || '')
    || editor.status !== node.status
    || editor.confidence !== node.confidence
    || editor.importance !== node.importance
    || editor.tags !== node.tags.join(', ');

  const save = async () => {
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
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground">{memoryTypeIcon(node.type)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="h-5 text-[9px] uppercase tracking-wide">{memoryTypeLabel(node.type)}</Badge>
                <Badge variant="outline" className={cn('h-5 text-[9px]', memoryStatusClass(node.status))}>{node.status}</Badge>
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">Updated {formatDate(node.updatedAt)}</div>
            </div>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  disabled={isRoot || mutating}
                  onClick={() => void updateMemory(node.id, { pinned: !node.pinned })}
                  aria-label={node.pinned ? 'Unpin memory' : 'Pin memory'}
                >
                  {node.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{isRoot ? 'Project root remains pinned' : node.pinned ? 'Unpin' : 'Pin for recall'}</TooltipContent>
            </Tooltip>
          </div>

          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Title</span>
            <Input value={editor.title} onChange={(event) => setEditor((state) => ({ ...state, title: event.target.value }))} disabled={isRoot} />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Summary</span>
            <textarea value={editor.summary} onChange={(event) => setEditor((state) => ({ ...state, summary: event.target.value }))} className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs outline-none focus:border-ring" disabled={isRoot} />
          </label>

          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Details</span>
            <textarea value={editor.body} onChange={(event) => setEditor((state) => ({ ...state, body: event.target.value }))} className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:border-ring" disabled={isRoot} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Status</span>
              <select value={editor.status} onChange={(event) => setEditor((state) => ({ ...state, status: event.target.value as MemoryNodeStatus }))} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none" disabled={isRoot}>
                <option value="active">Active</option>
                <option value="stale">Stale</option>
                <option value="superseded">Superseded</option>
                <option value="disputed">Disputed</option>
                <option value="archived">Archived</option>
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
            {!isRoot ? (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="h-7 text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)} disabled={mutating}><Trash2 className="mr-1.5 h-3 w-3" />Delete</Button>
                <Button size="sm" className="h-7" onClick={() => void save()} disabled={!dirty || mutating}>{mutating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}Save</Button>
              </div>
            ) : null}
          </div>
        </div>
      </ScrollArea>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-[430px]">
          <DialogHeader>
            <DialogTitle>Delete memory node?</DialogTitle>
            <DialogDescription>The curated node and graph edges will be removed. Historical evidence remains immutable.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void deleteMemory(node.id).then((ok) => ok && setDeleteOpen(false))} disabled={mutating}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete node</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
