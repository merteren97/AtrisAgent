import { forwardRef, useLayoutEffect, useRef, type ComponentProps, type UIEvent } from 'react';
import { cn } from '@/lib/utils';

const MENTION = /(^|\s)(@(github|playwright|unity-cli|unity|blender|godot))(?![\w-])/gi;

/** A normal textarea remains the accessible editing surface; the mirror only paints mentions. */
export const MentionTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>(function MentionTextarea({ value, className, style, onScroll, ...props }, ref) {
  const mirror = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const text = typeof value === 'string' ? value : '';
  const parts: Array<string | { mention:string; key:number }> = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION)) {
    const start = (match.index || 0) + match[1].length;
    parts.push(text.slice(cursor, start), {mention:match[2],key:start});
    cursor = start + match[2].length;
  }
  parts.push(text.slice(cursor));
  const hasMentions = parts.some(part => typeof part !== 'string');
  useLayoutEffect(() => {
    const textarea = input.current;
    if (!textarea || !hasMentions) return;
    const sync = () => {
      const paint = mirror.current;
      if (!paint) return;
      const computed = getComputedStyle(textarea);
      // The textarea may have been resized imperatively by its composer. Use
      // its real dimensions and exclude the native scrollbar from text wrapping.
      for (const property of ['font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-indent','text-transform','word-break','overflow-wrap','tab-size','padding-top','padding-right','padding-bottom','padding-left','border-top-width','border-right-width','border-bottom-width','border-left-width']) paint.style.setProperty(property,computed.getPropertyValue(property));
      paint.style.width = `${textarea.clientWidth + parseFloat(computed.borderLeftWidth || '0') + parseFloat(computed.borderRightWidth || '0')}px`;
      paint.style.height = `${textarea.offsetHeight}px`;
      paint.scrollTop = textarea.scrollTop;
      paint.scrollLeft = textarea.scrollLeft;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [text, hasMentions]);
  const scroll = (event:UIEvent<HTMLTextAreaElement>) => {
    if (mirror.current) { mirror.current.scrollTop = event.currentTarget.scrollTop; mirror.current.scrollLeft = event.currentTarget.scrollLeft; }
    onScroll?.(event);
  };
  return <div className="relative min-w-0">
    {hasMentions && <div ref={mirror} aria-hidden="true" style={style} className={cn(className, 'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-foreground forced-colors:hidden')}>
      {parts.map(part => typeof part === 'string' ? part : <mark key={part.key} className="rounded-sm bg-primary/25 text-foreground underline decoration-primary underline-offset-2">{part.mention}</mark>)}{'\n'}
    </div>}
    <textarea {...props} ref={element => { input.current = element; if (typeof ref === 'function') ref(element); else if (ref) ref.current = element; }} value={value} style={style} onScroll={scroll} className={cn(className, 'relative bg-transparent', hasMentions && 'text-transparent caret-foreground forced-colors:text-foreground')} />
  </div>;
});
