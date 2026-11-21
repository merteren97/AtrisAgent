import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ChevronUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t, useLanguageStore } from '@/stores/language-store';

export const CHAT_HISTORY_PAGE_SIZE = 30;

/** Keep the same message and pixel offset when history is prepended. */
export function useChatHistoryScroll(scope?: string) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const [detached, setDetached] = useState(false);

  useLayoutEffect(() => {
    following.current = true;
    anchor.current = null;
    setDetached(false);
    const node = viewport.current;
    if (!node || !content.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(content.current);
    observer.observe(node);
    return () => observer.disconnect();
  }, [scope]);

  useLayoutEffect(() => {
    const node = viewport.current;
    const saved = anchor.current;
    anchor.current = null;
    if (!node) return;
    if (saved && node.contains(saved.element)) {
      node.scrollTop += saved.element.getBoundingClientRect().top - saved.top;
    } else if (following.current) {
      node.scrollTop = node.scrollHeight;
    }
  });

  const preservePosition = useCallback(() => {
    const node = viewport.current;
    if (!node || !content.current) return;
    const top = node.getBoundingClientRect().top;
    const element = Array.from(content.current.querySelectorAll<HTMLElement>('[data-chat-message]'))
      .find(message => message.getBoundingClientRect().bottom > top);
    if (element) anchor.current = { element, top: element.getBoundingClientRect().top };
    following.current = false;
    setDetached(true);
  }, []);

  const onScroll = () => {
    const node = viewport.current;
    if (!node) return;
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    setDetached(!following.current);
  };
  const jumpToLatest = () => {
    following.current = true;
    setDetached(false);
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
  };

  return { viewport, content, following, detached, onScroll, preservePosition, jumpToLatest };
}

export function LoadOlderMessages({ onLoad, loading, error }: { onLoad: () => void; loading?: boolean; error?: boolean }) {
  useLanguageStore(state => state.language);
  return <div className="flex flex-col items-center gap-2">
    <Button type="button" size="sm" variant="outline" className="h-8 rounded-full text-xs" aria-disabled={loading || undefined} onClick={() => { if (!loading) onLoad(); }}>
      {loading ? <Loader2 aria-hidden="true" className="animate-spin" /> : <ChevronUp aria-hidden="true" />}
      {t(loading ? 'Loading older messages…' : 'Show older messages')}
    </Button>
    {error && <p role="alert" className="text-center text-xs text-destructive">{t('Older messages could not be loaded. Try again.')}</p>}
  </div>;
}

export function LatestMessagesButton({ onClick }: { onClick: () => void }) {
  useLanguageStore(state => state.language);
  return <Button type="button" variant="secondary" size="sm" className="h-8 rounded-full border border-border/80 bg-card px-3 text-xs shadow-sm" onClick={onClick}>
    <ArrowDown aria-hidden="true" />{t('Latest messages')}
  </Button>;
}
