import { Sparkles, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './markdown-content';

interface MessageCardProps {
  role: 'user' | 'orchestrator';
  content: string;
  timestamp: string;
}

export function MessageCard({ role, content, timestamp }: MessageCardProps) {
  const isUser = role === 'user';

  return (
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
        </div>
        <div className={cn(
          'w-full min-w-0 px-4 py-3 text-sm leading-relaxed shadow-sm',
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
  );
}
