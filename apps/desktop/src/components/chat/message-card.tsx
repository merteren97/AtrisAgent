import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Sparkles, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './markdown-content';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

interface MessageCardProps {
  role: 'user' | 'orchestrator';
  content: string;
  timestamp: string;
  deliveryState?: 'queued' | 'starting' | 'cancelled' | 'failed';
}

export function MessageCard({ role, content, timestamp, deliveryState }: MessageCardProps) {
  const isUser = role === 'user';
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetCopyStateTimer = useRef<number | null>(null);

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
}
