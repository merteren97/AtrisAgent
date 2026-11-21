import { memo, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, Bot, Brain, Check, ChevronRight, FileText, ImageIcon, Loader2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarkdownContent, normalizeFileUri } from '@/components/chat/markdown-content';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { extractChatImages, loadLocalImagePreviewBlob, normalizeImagePath } from '@/components/chat/chat-image-preview';
import { useWorkspaceStore } from '@/stores/workspace-store';
import type { ManualToolArtifact, ManualToolItem } from '@/stores/manual-store';

interface Attachment { name: string; path: string }
interface ProjectImage { name: string; path: string }

export function assistantProjectImages(text: string): ProjectImage[] {
  return extractChatImages(text);
}

function normalizeArtifactLookupPath(raw: string): string {
  const cleaned = normalizeFileUri(raw)
    .replace(/#L\d+(?:-L?\d+)?$/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(cleaned) ? cleaned.toLowerCase() : cleaned;
}

export function findMatchingArtifact(
  tools: ManualToolItem[] | undefined,
  clickedPath: string,
): ManualToolArtifact | undefined {
  if (!tools?.length || !clickedPath.trim()) return undefined;
  const targetNorm = normalizeArtifactLookupPath(clickedPath);
  const targetBase = targetNorm.split('/').pop()?.toLowerCase() || '';
  const withArtifacts = [...tools].reverse().filter(item => Boolean(item.artifact?.content));

  for (const item of withArtifacts) {
    const artifact = item.artifact!;
    if (artifact.path && normalizeArtifactLookupPath(artifact.path) === targetNorm) {
      return artifact;
    }
  }
  if (!targetBase) return undefined;
  for (const item of withArtifacts) {
    const artifact = item.artifact!;
    const artifactBase = normalizeArtifactLookupPath(artifact.path || '').split('/').pop()?.toLowerCase();
    if (artifactBase === targetBase || artifact.title.toLowerCase() === targetBase) {
      return artifact;
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
  artifact: ManualToolArtifact | null;
  cwd?: string;
  onClose: () => void;
  onLocalFileLink?: (path: string) => void;
}) {
  return (
    <Dialog open={Boolean(artifact)} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] w-[min(900px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="pr-8 text-base">{artifact?.title}</DialogTitle>
          {artifact?.path && (
            <DialogDescription className="truncate text-xs">{artifact.path}</DialogDescription>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 text-sm leading-relaxed">
          {artifact?.content && (
            <MarkdownContent
              content={artifact.content}
              cwd={cwd}
              onLocalFileLink={onLocalFileLink}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
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

function ToolStatusIcon({ status }: { status: ManualToolItem['status'] }) {
  if (status === 'running') return <Loader2 aria-label="Running" className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  if (status === 'failed') return <AlertCircle aria-label="Failed" className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  return <Check aria-label="Completed" className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
}

export function AssistantTurnProcess({
  thinking,
  thinkingTokens,
  tools,
  cwd,
  openArtifact: controlledArtifact,
  onOpenArtifact,
}: {
  thinking?: string;
  thinkingTokens?: number;
  tools?: ManualToolItem[];
  cwd?: string;
  openArtifact?: ManualToolArtifact | null;
  onOpenArtifact?: (artifact: ManualToolArtifact | null) => void;
}) {
  const [internalArtifact, setInternalArtifact] = useState<ManualToolArtifact | null>(null);
  const isControlled = onOpenArtifact !== undefined;
  const activeArtifact = isControlled ? (controlledArtifact ?? null) : internalArtifact;
  const setActiveArtifact = isControlled ? onOpenArtifact : setInternalArtifact;

  const trimmedThinking = thinking?.trim() ? thinking : undefined;
  const subagents = (tools || []).filter(t => t.name === 'invoke_subagent' || Boolean(t.subagent));
  const artifacts = (tools || []).filter(t => Boolean(t.artifact));
  const otherTools = (tools || []).filter(t => t.name !== 'invoke_subagent' && !t.subagent && !t.artifact);

  if (!trimmedThinking && !subagents.length && !otherTools.length && !artifacts.length) {
    return null;
  }

  const firstThinkingLine = trimmedThinking
    ? trimmedThinking.split(/\r?\n/).map(line => line.trim()).find(Boolean) || ''
    : '';
  const tokenLabel = thinkingTokens
    ? ` · ${thinkingTokens >= 1000 ? `${(thinkingTokens / 1000).toFixed(1)}k` : thinkingTokens} tokens`
    : '';

  return (
    <div className="mb-3 space-y-2">
      {trimmedThinking && (
        <details className="group rounded-xl border border-border/60 bg-muted/25 px-3 py-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 select-none text-muted-foreground hover:text-foreground">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
            <Brain className="h-3.5 w-3.5 shrink-0 text-primary/80" />
            <span className="shrink-0 font-medium text-foreground/90">
              Thought{tokenLabel}
            </span>
            {firstThinkingLine && (
              <span className="min-w-0 flex-1 truncate text-muted-foreground/80 group-open:hidden">
                {firstThinkingLine}
              </span>
            )}
          </summary>
          <div className="mt-2 border-l-2 border-primary/30 pl-3 whitespace-pre-wrap leading-relaxed text-muted-foreground">
            {trimmedThinking}
          </div>
        </details>
      )}

      {subagents.length > 0 && (
        <div className="space-y-1.5" aria-label="Subagents">
          {subagents.map(t => {
            const badge = [t.subagent?.typeName, t.subagent?.model].filter(Boolean).join(' · ');
            return (
              <div
                key={t.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-card/70 px-3 py-2 text-xs"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="truncate font-medium text-foreground">
                    {t.subagent?.role || t.summary}
                  </span>
                  {badge && (
                    <span className="shrink-0 rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {badge}
                    </span>
                  )}
                </div>
                <ToolStatusIcon status={t.status} />
              </div>
            );
          })}
        </div>
      )}

      {otherTools.length > 0 && (
        otherTools.length <= 2 ? (
          <div className="space-y-1 rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs" aria-label="Tool calls">
            {otherTools.map(t => (
              <div key={t.id} className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <Wrench className="h-3 w-3 shrink-0" />
                  <span className="truncate">{t.summary || t.name}</span>
                </div>
                <ToolStatusIcon status={t.status} />
              </div>
            ))}
          </div>
        ) : (
          <details className="group rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-2 select-none text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
              <Wrench className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium text-foreground/90">{otherTools.length} tool calls</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground/80 group-open:hidden">
                {otherTools.map(t => t.summary || t.name).join(' · ')}
              </span>
            </summary>
            <div className="mt-2 space-y-1 border-l-2 border-border/60 pl-3">
              {otherTools.map(t => (
                <div key={t.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-muted-foreground">{t.summary || t.name}</span>
                  <ToolStatusIcon status={t.status} />
                </div>
              ))}
            </div>
          </details>
        )
      )}

      {artifacts.length > 0 && (
        <div className="space-y-2" aria-label="Artifacts">
          {artifacts.map(t => {
            const artifact = t.artifact!;
            return (
              <div key={t.id} className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{artifact.title}</p>
                      {artifact.summary && (
                        <p className="mt-1 leading-relaxed text-muted-foreground">{artifact.summary}</p>
                      )}
                    </div>
                  </div>
                  {artifact.content && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 px-2.5 text-xs"
                      onClick={() => setActiveArtifact(artifact)}
                    >
                      View document
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isControlled && (
        <ArtifactPreviewDialog
          artifact={activeArtifact}
          cwd={cwd}
          onClose={() => setActiveArtifact(null)}
          onLocalFileLink={path => {
            const match = findMatchingArtifact(tools, path);
            if (match) setActiveArtifact(match);
          }}
        />
      )}
    </div>
  );
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
    else void findOlderArtifact?.(path).then(found => {
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
