import { useMemo } from 'react';
import { BadgeCheck, Brain, Bug, CircleDot, FileCode2, FolderGit2, GitCommitHorizontal, Lightbulb, ListTree, Pin, Search, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { MemoryNode, MemoryNodeStatus, MemoryNodeType } from '@/stores/memory-store';

export function memoryTypeLabel(type: MemoryNodeType): string {
  return type === 'project'
    ? 'Project'
    : type.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function memoryTypeIcon(type: MemoryNodeType) {
  const className = 'h-3.5 w-3.5 shrink-0';
  if (type === 'project') return <FolderGit2 className={className} />;
  if (type === 'research_finding') return <Search className={className} />;
  if (type === 'decision') return <Brain className={className} />;
  if (type === 'change') return <GitCommitHorizontal className={className} />;
  if (['file', 'symbol', 'component'].includes(type)) return <FileCode2 className={className} />;
  if (['bug', 'issue', 'mistake'].includes(type)) return <Bug className={className} />;
  if (type === 'verification' || type === 'test') return <BadgeCheck className={className} />;
  if (type === 'user_constraint') return <ShieldCheck className={className} />;
  if (type === 'lesson' || type === 'pattern') return <Lightbulb className={className} />;
  return <CircleDot className={className} />;
}

export function memoryStatusClass(status: MemoryNodeStatus): string {
  if (status === 'active') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400';
  if (status === 'disputed') return 'border-rose-500/25 bg-rose-500/10 text-rose-400';
  if (status === 'stale') return 'border-amber-500/25 bg-amber-500/10 text-amber-400';
  return 'border-border bg-muted/60 text-muted-foreground';
}

export function MemoryNotesView({
  nodes,
  selectedNodeId,
  onSelect,
}: {
  nodes: MemoryNode[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
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
            <p className="text-xs font-medium text-foreground">No memory nodes match this view</p>
            <p className="mt-1 max-w-56 text-[10px]">Clear search or filters, or add a manual project memory.</p>
          </div>
        ) : ordered.slice(0, 750).map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelect(node.id)}
            className={cn(
              'w-full rounded-lg border p-3 text-left transition-colors',
              selectedNodeId === node.id
                ? 'border-primary/50 bg-primary/10'
                : 'border-border bg-card/45 hover:bg-accent/40',
            )}
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 text-muted-foreground">{memoryTypeIcon(node.type)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{node.title}</span>
                  {node.pinned ? <Pin className="h-3 w-3 shrink-0 text-amber-300" /> : null}
                </div>
                <div className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-muted-foreground">{node.summary}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <Badge variant="outline" className="h-4 px-1.5 text-[8px]">{memoryTypeLabel(node.type)}</Badge>
                  <Badge variant="outline" className={cn('h-4 px-1.5 text-[8px]', memoryStatusClass(node.status))}>{node.status}</Badge>
                  {node.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[8px] text-muted-foreground">#{tag}</span>
                  ))}
                </div>
              </div>
            </div>
          </button>
        ))}
        {ordered.length > 750 ? <p className="px-2 py-3 text-center text-[9px] text-muted-foreground">Showing the first 750 notes. Use search or filters to narrow the list.</p> : null}
      </div>
    </ScrollArea>
  );
}
