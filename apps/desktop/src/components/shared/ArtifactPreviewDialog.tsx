import { useState } from 'react';
import { FileText } from 'lucide-react';
import { MarkdownContent, normalizeFileUri } from '@/components/chat/markdown-content';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface SharedToolArtifact {
  title: string;
  summary?: string;
  path?: string;
  content?: string;
}

export interface SharedToolItem {
  id: string;
  name: string;
  summary: string;
  detail?: string;
  output?: string;
  status: 'running' | 'completed' | 'failed';
  artifact?: SharedToolArtifact;
  subagent?: {
    conversationId?: string;
    role?: string;
    typeName?: string;
    model?: string;
  };
}

function normalizeArtifactLookupPath(raw: string): string {
  const cleaned = normalizeFileUri(raw)
    .replace(/#L\d+(?:-L?\d+)?$/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(cleaned) ? cleaned.toLowerCase() : cleaned;
}

export function findMatchingArtifact<T extends SharedToolItem>(
  tools: T[] | undefined,
  clickedPath: string,
): NonNullable<T['artifact']> | undefined {
  if (!tools?.length || !clickedPath.trim()) return undefined;
  const targetNorm = normalizeArtifactLookupPath(clickedPath);
  const targetBase = targetNorm.split('/').pop()?.toLowerCase() || '';
  const withArtifacts = [...tools].reverse().filter((item) => Boolean(item.artifact?.content));

  for (const item of withArtifacts) {
    const artifact = item.artifact!;
    if (artifact.path && normalizeArtifactLookupPath(artifact.path) === targetNorm) {
      return artifact as NonNullable<T['artifact']>;
    }
  }
  if (!targetBase) return undefined;
  for (const item of withArtifacts) {
    const artifact = item.artifact!;
    const artifactBase = normalizeArtifactLookupPath(artifact.path || '').split('/').pop()?.toLowerCase();
    if (artifactBase === targetBase || artifact.title.toLowerCase() === targetBase) {
      return artifact as NonNullable<T['artifact']>;
    }
  }
  return undefined;
}

export function ArtifactPreviewDialog({
  artifact,
  cwd,
  onClose,
  onLocalFileLink,
}: {
  artifact: SharedToolArtifact | null;
  cwd?: string;
  onClose: () => void;
  onLocalFileLink?: (path: string) => void;
}) {
  return (
    <Dialog open={Boolean(artifact)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] w-[min(900px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="pr-8 text-base">{artifact?.title}</DialogTitle>
          {artifact?.path && (
            <DialogDescription className="truncate text-xs">{artifact.path}</DialogDescription>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 text-sm leading-relaxed">
          {artifact?.content ? (
            <MarkdownContent
              content={artifact.content}
              cwd={cwd}
              onLocalFileLink={onLocalFileLink}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
              <FileText className="h-8 w-8 opacity-40" />
              <p className="text-xs">No inline document content available.</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Convenience hook for managing artifact preview dialog state alongside a tool list.
 */
export function useArtifactPreviewState<T extends SharedToolItem>(tools?: T[]) {
  const [openArtifact, setOpenArtifact] = useState<SharedToolArtifact | null>(null);
  const handleLocalFileLink = (path: string) => {
    const match = findMatchingArtifact(tools, path);
    if (match) setOpenArtifact(match);
  };
  return { openArtifact, setOpenArtifact, handleLocalFileLink };
}
