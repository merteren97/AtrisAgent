import { memo, useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, Loader2, Sparkles, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './markdown-content';
import type { AttachmentRef } from '@atris-agent-code/domain';
import { apiRequest } from '@/lib/api-client';
import { AttachmentLightbox } from '@/components/orchestrator/orchestrator-attachments';
import { canPreviewAttachment } from '@/stores/orchestrator-attachments-store';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

export interface MessageCardProps {
  role: 'user' | 'orchestrator';
  content: string;
  timestamp: string;
  deliveryState?: 'queued' | 'starting' | 'cancelled' | 'failed';
  metadata?: Record<string, unknown>;
  workspaceId?: string | null;
}

type MessageAttachment = Pick<AttachmentRef, 'id' | 'workspaceId'> & Partial<Pick<AttachmentRef, 'name' | 'mimeType'>>;

export function messageAttachments(metadata?: Record<string, unknown>, workspaceId?: string | null): MessageAttachment[] {
  const refs = new Map<string, MessageAttachment>();
  const workspace = workspaceId || (typeof metadata?.workspaceId === 'string' ? metadata.workspaceId : '');
  for (const value of Array.isArray(metadata?.attachments) ? metadata.attachments : []) {
    if (!value || typeof value !== 'object') continue;
    const ref = value as Record<string, unknown>;
    const refWorkspace = typeof ref.workspaceId === 'string' ? ref.workspaceId : workspace;
    if (typeof ref.id !== 'string' || !ref.id.trim() || !refWorkspace) continue;
    refs.set(ref.id, { id: ref.id, workspaceId: refWorkspace,
      name: typeof ref.name === 'string' ? ref.name : undefined, mimeType: typeof ref.mimeType === 'string' ? ref.mimeType : undefined });
  }
  for (const id of Array.isArray(metadata?.attachmentIds) ? metadata.attachmentIds : []) {
    if (typeof id === 'string' && id.trim() && workspace && !refs.has(id)) refs.set(id, { id, workspaceId: workspace });
  }
  return [...refs.values()].slice(0, 10);
}

function SentAttachment({ id, workspaceId, name: initialName, mimeType: initialMime }: MessageAttachment) {
  const [url, setUrl] = useState<string>();
  const [details, setDetails] = useState({ name: initialName || 'Attached file', mimeType: initialMime || '' });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const image = canPreviewAttachment({ name: details.name, type: details.mimeType });
  useEffect(() => {
    // Known documents need bytes only when opened. ID-only history resolves metadata via the same authenticated GET.
    const shouldLoad = !initialMime || canPreviewAttachment({ name: initialName || '', type: initialMime }) || requested;
    if (!shouldLoad) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setError(null);
    setLoaded(false);
    setUrl(undefined);
    void apiRequest<AttachmentRef & { dataBase64: string }>(`/attachments/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { signal: controller.signal })
      .then((ref) => {
        if (controller.signal.aborted) return;
        if (ref.id !== id || ref.workspaceId !== workspaceId) throw new Error('Attachment workspace does not match.');
        const bytes = Uint8Array.from(atob(ref.dataBase64), (char) => char.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: ref.mimeType }));
        setDetails({ name: ref.name, mimeType: ref.mimeType });
        setUrl(objectUrl);
        setLoaded(true);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Attachment unavailable.');
      });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, workspaceId, initialName, initialMime, requested, retry]);
  return <div className="max-w-full">
    <button ref={trigger} type="button" aria-label={`Preview ${details.name}`} title={error || details.name} onClick={() => { setOpen(true); if (initialMime && !image) setRequested(true); if (error) setRetry((value) => value + 1); }} className="flex max-w-full flex-col gap-1 overflow-hidden rounded-lg border border-border bg-card p-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {image && url ? <img src={url} alt={details.name} className="max-h-40 max-w-52 object-contain" /> : <span className="flex items-center gap-2 px-2 py-1"><FileText className="h-4 w-4 shrink-0" /><span className="truncate text-xs">{details.name}</span></span>}
      {error ? <span role="status" className="px-2 pb-1 text-xs text-destructive">Unavailable · click to retry</span>
        : !loaded && (!initialMime || image) ? <span role="status" className="px-2 pb-1 text-xs text-muted-foreground">Loading attachment…</span> : null}
    </button>
    <AttachmentLightbox name={details.name} url={url} image={image} open={open} onOpenChange={setOpen} status={error || (!loaded ? 'Loading attachment…' : undefined)} returnFocusRef={trigger} />
  </div>;
}

export const MessageCard = memo(function MessageCard({ role, content, timestamp, deliveryState, metadata, workspaceId }: MessageCardProps) {
  const isUser = role === 'user';
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetCopyStateTimer = useRef<number | null>(null);
  const attachments = messageAttachments(metadata, workspaceId);

  useEffect(() => () => {
    if (resetCopyStateTimer.current !== null) window.clearTimeout(resetCopyStateTimer.current);
  }, []);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = content;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!copied) throw new Error('Clipboard copy was rejected.');
      }

      setCopyState('copied');
    } catch {
      setCopyState('error');
    }

    if (resetCopyStateTimer.current !== null) window.clearTimeout(resetCopyStateTimer.current);
    resetCopyStateTimer.current = window.setTimeout(() => setCopyState('idle'), 2_200);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={cn('flex w-full gap-3 py-2', isUser ? 'justify-end' : 'justify-start')}>
          {!isUser && (
            <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/10 shadow-sm">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
          )}

          <div className={cn(
            'flex min-w-0 flex-col gap-1 overflow-hidden',
            isUser ? 'max-w-[82%] items-end' : 'w-full max-w-[94%] items-start',
          )}>
            <div className="flex items-center gap-2 px-1">
              <span className="text-xs font-semibold text-foreground/80">{isUser ? 'You' : 'Orchestrator'}</span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
              {deliveryState && <span className="flex items-center gap-1 text-[9px] capitalize text-muted-foreground">
                {(deliveryState === 'queued' || deliveryState === 'starting') && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                {deliveryState === 'starting' ? 'starting' : deliveryState}
              </span>}
            </div>
            <div className={cn(
              'w-full min-w-0 select-text px-4 py-3 text-sm leading-relaxed shadow-sm',
              isUser
                ? 'rounded-2xl rounded-tr-sm bg-primary text-primary-foreground'
                : 'rounded-xl rounded-tl-sm border border-border/55 bg-card/70 text-foreground/90',
            )}>
              {isUser
                ? <div className="whitespace-pre-wrap break-words">{content}</div>
                : <MarkdownContent content={content} />}
              {attachments.length > 0 && <div aria-label="Sent attachments" className="mt-2 flex flex-wrap gap-2">
                {attachments.map((attachment) => <SentAttachment key={`${attachment.workspaceId}:${attachment.id}`} {...attachment} />)}
              </div>}
            </div>
          </div>

          {isUser && (
            <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-secondary shadow-sm">
              <User className="h-4 w-4 text-secondary-foreground" />
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuLabel>{isUser ? 'Your message' : 'Orchestrator message'}</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void handleCopy()}>
          {copyState === 'copied' ? <Check className="text-emerald-400" /> : <Copy />}
          <span>{copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Try copy again' : 'Copy message'}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

MessageCard.displayName = 'MessageCard';
