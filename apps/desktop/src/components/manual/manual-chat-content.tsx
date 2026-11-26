import { memo, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileText, ImageIcon, Loader2 } from 'lucide-react';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { extractChatImages, loadLocalImagePreviewBlob, normalizeImagePath } from '@/components/chat/chat-image-preview';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { ManualSwarmSummary, ManualToolArtifact, ManualToolItem } from '@/stores/manual-store';
import { ArtifactPreviewDialog, findMatchingArtifact } from '@/components/shared/ArtifactPreviewDialog';
import { TurnProcessView } from '@/components/shared/TurnProcessView';

export { ArtifactPreviewDialog, findMatchingArtifact };

interface Attachment { name: string; path: string }
interface ProjectImage { name: string; path: string }

export function assistantProjectImages(text: string): ProjectImage[] {
  return extractChatImages(text);
}

function ProjectImagePreview({ image, cwd, open, onOpenChange }: { image: ProjectImage; cwd: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  const activeWorkspace = useWorkspaceStore(s => s.workspaces.find(w => w.id === s.activeWorkspaceId));
  const effectiveCwd = cwd || activeWorkspace?.path || '';
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError(false);
    void loadLocalImagePreviewBlob({ cwd: effectiveCwd, path: image.path })
      .then(blob => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setError(false);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [effectiveCwd, image.path]);
  return <>
    <button type="button" onClick={() => onOpenChange(true)} aria-label={`Review ${image.name}`} title={image.path} className="group flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex h-28 w-full items-center justify-center overflow-hidden bg-muted/40">
        {url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" /> : error ? <ImageIcon className="h-6 w-6 text-muted-foreground" /> : <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      </div>
      <span className="truncate px-2 py-1.5 text-xs text-foreground">{image.name}</span>
      {error && <span className="px-2 pb-1.5 text-[11px] text-muted-foreground">Image unavailable</span>}
    </button>
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="w-[min(1100px,calc(100vw-2rem))] max-w-none gap-3 p-4 sm:max-w-none">
      <DialogTitle className="pr-8 text-sm">{image.name}</DialogTitle>
      {url && <img src={url} alt={image.name} className="mx-auto max-h-[calc(100vh-9rem)] max-w-full object-contain" />}
      {!url && <p role="status" className="py-12 text-center text-sm text-muted-foreground">{error ? 'Image unavailable' : 'Loading image…'}</p>}
      <p className="truncate text-xs text-muted-foreground" title={image.path}>{image.path}</p>
    </DialogContent></Dialog>
  </>;
}
export function displayManualPrompt(text: string): { text: string; attachments: Attachment[] } {
  const marker = 'Attached files (read these local paths to inspect their contents, including images):\n';
  const offset = text.lastIndexOf(marker);
  if (offset < 0 || (offset > 0 && text.slice(offset - 2, offset) !== '\n\n')) return { text, attachments: [] };
  const lines = text.slice(offset + marker.length).trimEnd().split('\n');
  const attachments: Attachment[] = [];
  for (const line of lines) {
    const match = /^- ("(?:\\.|[^"\\])*"): ("(?:\\.|[^"\\])*")$/.exec(line);
    if (!match) return { text, attachments: [] };
    try {
      const name = JSON.parse(match[1]); const path = JSON.parse(match[2]);
      if (typeof name !== 'string' || typeof path !== 'string') return { text, attachments: [] };
      attachments.push({ name, path });
    } catch { return { text, attachments: [] }; }
  }
  return attachments.length ? { text: text.slice(0, offset).trimEnd(), attachments } : { text, attachments: [] };
}

function SentAttachment({ attachment, agentId }: { attachment: Attachment; agentId: string }) {
  const [url, setUrl] = useState<string>();
  const image = /\.(png|jpe?g|webp|gif)$/i.test(attachment.name);
  useEffect(() => {
    if (!image) return;
    let active = true; let objectUrl: string | undefined;
    void invoke<number[]>('manual_attachment_preview', { id: agentId, path: attachment.path }).then(bytes => {
      if (!active) return;
      const extension = attachment.name.split('.').pop()?.toLowerCase();
      const mime = extension === 'jpg' ? 'jpeg' : extension;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: `image/${mime}` }));
      setUrl(objectUrl);
    }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [agentId, attachment.path, attachment.name, image]);
  return url ? <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`} className="block w-fit overflow-hidden rounded-lg border border-border focus-visible:ring-2 focus-visible:ring-ring"><img src={url} alt={attachment.name} className="max-h-52 max-w-full object-contain" /></a>
    : <span title={attachment.name} className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-background/50 px-2 py-1 text-xs text-muted-foreground">{image ? <ImageIcon className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}<span className="truncate">{attachment.name}</span></span>;
}

export function AssistantTurnProcess(props: {
  thinking?: string;
  thinkingTokens?: number;
  tools?: ManualToolItem[];
  cwd?: string;
  swarm?: ManualSwarmSummary;
  onOpenSubagent?: (conversationId: string, label?: string) => void;
  openArtifact?: ManualToolArtifact | null;
  onOpenArtifact?: (artifact: ManualToolArtifact | null) => void;
}) {
  return <TurnProcessView {...props} />;
}

export const ManualChatContent = memo(function ManualChatContent({
  text,
  agentId,
  cwd,
  user,
  thinking,
  thinkingTokens,
  tools,
  conversationTools,
  findOlderArtifact,
  swarm,
  readOnly,
  onOpenSubagent,
}: {
  text: string;
  agentId: string;
  cwd: string;
  user: boolean;
  thinking?: string;
  thinkingTokens?: number;
  tools?: ManualToolItem[];
  conversationTools?: ManualToolItem[];
  findOlderArtifact?: (path: string) => Promise<ManualToolArtifact | undefined>;
  swarm?: ManualSwarmSummary;
  readOnly?: boolean;
  onOpenSubagent?: (conversationId: string, label?: string) => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openArtifact, setOpenArtifact] = useState<ManualToolArtifact | null>(null);
  const artifactLookup = useRef(0);
  const content = user ? displayManualPrompt(text) : { text, attachments: [] };
  const images = user ? [] : assistantProjectImages(text);
  const openImage = (path: string) => {
    const clean = normalizeImagePath(path);
    const target = images.find(image => image.path === path || image.path === clean || normalizeImagePath(image.path) === clean);
    if (target) setSelectedPath(target.path);
  };
  const handleFileLink = (path: string) => {
    const lookup = ++artifactLookup.current;
    const matched = findMatchingArtifact(tools, path) ?? findMatchingArtifact(conversationTools, path);
    if (matched) setOpenArtifact(matched);
    else if (!readOnly) void findOlderArtifact?.(path).then(found => {
      if (found && artifactLookup.current === lookup) setOpenArtifact(found);
    }).catch(() => {});
  };
  return (
    <>
      {!user && (
        <AssistantTurnProcess
          thinking={thinking}
          thinkingTokens={thinkingTokens}
          tools={tools}
          cwd={cwd}
          swarm={swarm}
          onOpenSubagent={onOpenSubagent}
          openArtifact={openArtifact}
          onOpenArtifact={setOpenArtifact}
        />
      )}
      {content.text && (
        <MarkdownContent
          content={content.text}
          cwd={cwd}
          onLocalImageLink={images.length ? openImage : undefined}
          onLocalFileLink={!user ? handleFileLink : undefined}
        />
      )}
      {content.attachments.length > 0 && <div aria-label="Sent attachments" className="mt-2 flex flex-wrap gap-2">{content.attachments.map((attachment, index) => <SentAttachment key={`${attachment.path}:${index}`} attachment={attachment} agentId={agentId} />)}</div>}
      {images.length > 0 && <div aria-label="Generated image previews" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{images.map(image => <ProjectImagePreview key={image.path} image={image} cwd={cwd} open={selectedPath === image.path} onOpenChange={open => setSelectedPath(open ? image.path : null)} />)}</div>}
      <ArtifactPreviewDialog
        artifact={openArtifact}
        cwd={cwd}
        onClose={() => { artifactLookup.current++; setOpenArtifact(null); }}
        onLocalFileLink={handleFileLink}
      />
    </>
  );
});
