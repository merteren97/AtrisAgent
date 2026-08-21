import { Loader2, Sparkles } from 'lucide-react';
import type { TimelineItem } from '@/stores/mission-store';

interface ThinkingStripProps {
  item: TimelineItem;
}

export function ThinkingStrip({ item }: ThinkingStripProps) {
  const detail = item.content.trim() || 'Working through the next step...';

  return (
    <div
      role="status"
      aria-live="polite"
      title={detail}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-primary/15 bg-primary/[0.035] px-3 py-1.5 text-[11px] text-muted-foreground"
    >
      <Sparkles className="h-3 w-3 shrink-0 text-primary" />
      <span className="shrink-0 font-medium text-foreground/75">Thinking</span>
      <span className="min-w-0 flex-1 truncate">{detail}</span>
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/70" />
    </div>
  );
}
