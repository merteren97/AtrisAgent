import { useRef, type PointerEvent } from 'react';
import { GripHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ComposerResizeHandle({
  height,
  onHeightChange,
  minHeight = 72,
  maxHeight = 320,
  expandedHeight = 216,
  collapseThreshold = 150,
  className,
}: {
  height: number;
  onHeightChange: (nextHeight: number) => void;
  minHeight?: number;
  maxHeight?: number;
  expandedHeight?: number;
  collapseThreshold?: number;
  className?: string;
}) {
  const drag = useRef<{ start: number; height: number } | null>(null);
  const ignoreClick = useRef(false);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    drag.current = { start: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <button
      type="button"
      aria-label="Resize message area"
      title="Drag to resize · click to expand or collapse"
      onClick={() => {
        if (ignoreClick.current) {
          ignoreClick.current = false;
          return;
        }
        onHeightChange(height < collapseThreshold ? expandedHeight : minHeight);
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const next = Math.max(minHeight, Math.min(maxHeight, drag.current.height + drag.current.start - event.clientY));
        onHeightChange(next);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        ignoreClick.current = Math.abs(event.clientY - drag.current.start) > 4;
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      className={cn(
        'mx-auto flex h-5 w-16 shrink-0 cursor-ns-resize items-center justify-center rounded-full text-muted-foreground/60 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <GripHorizontal className="h-4 w-4" />
    </button>
  );
}
