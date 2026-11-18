import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, ArrowRight, Globe, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isTauriRuntime } from '@/lib/secure-storage';
import { browserUrl, useBrowserStore } from '@/stores/browser-store';
import { useRightDockStore } from '@/stores/right-dock-store';
import { cn } from '@/lib/utils';

type NavigationEvent = { url: string; loading: boolean };

const QUICK_URLS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
] as const;

export function LinkBrowser() {
  const { url, requestId, open, close } = useBrowserStore();
  const dockOpen = useRightDockStore((state) => state.open);
  const activeTab = useRightDockStore((state) => state.activeTab);
  const expanded = useRightDockStore((state) => state.expanded);
  const width = useRightDockStore((state) => state.width);

  const [address, setAddress] = useState('');
  const [emptyAddress, setEmptyAddress] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [frameRevision, setFrameRevision] = useState(0);

  const host = useRef<HTMLDivElement>(null);
  const toolbarInput = useRef<HTMLInputElement>(null);
  const emptyInput = useRef<HTMLInputElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const native = isTauriRuntime();
  const visible = Boolean(url) && dockOpen && activeTab === 'browser';

  const enqueue = useCallback((command: string, args?: Record<string, unknown>) => {
    queue.current = queue.current
      .catch(() => {})
      .then(async () => { await invoke(command, args); })
      .catch((cause) => {
        setError(String(cause));
        setLoading(false);
      });
  }, []);

  const syncBounds = useCallback(() => {
    if (!native || !visible || !host.current) return;
    const rect = host.current.getBoundingClientRect();
    if (rect.width >= 1 && rect.height >= 1) {
      enqueue('browser_resize', {
        rect: {
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: rect.width,
          height: rect.height,
        },
      });
    }
  }, [native, visible, enqueue]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void Promise.all([
      listen<NavigationEvent>('link-browser-navigation', (event) => {
        if (!disposed) {
          setAddress(event.payload.url);
          setLoading(event.payload.loading);
        }
      }),
      listen<string>('link-browser-open', (event) => {
        if (!disposed) open(event.payload);
      }),
    ]).then((items) => {
      if (disposed) items.forEach((unlisten) => unlisten());
      else cleanups.push(...items);
    }).catch((cause) => {
      if (!disposed) setError(String(cause));
    });
    return () => {
      disposed = true;
      cleanups.forEach((unlisten) => unlisten());
    };
  }, [native, open]);

  useLayoutEffect(() => {
    if (!native || !visible || !host.current) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncBounds());
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host.current);
    window.addEventListener('resize', sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [native, visible, expanded, width, syncBounds]);

  useLayoutEffect(() => {
    if (!url) {
      if (native) enqueue('browser_close');
      setAddress('');
      setError('');
      setLoading(false);
      return;
    }
    setAddress(url);
    setError('');
    setLoading(true);
    if (!native) {
      setFrameRevision((value) => value + 1);
      return;
    }
    const openNative = () => {
      const rect = host.current?.getBoundingClientRect();
      if (rect && rect.width >= 1 && rect.height >= 1) {
        enqueue('browser_open', {
          url,
          rect: {
            x: Math.max(0, rect.left),
            y: Math.max(0, rect.top),
            width: rect.width,
            height: rect.height,
          },
        });
        return true;
      }
      return false;
    };
    if (!openNative()) {
      const frame = requestAnimationFrame(() => {
        openNative();
      });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [native, url, requestId, enqueue]);

  useEffect(() => {
    if (!native || !url) return;
    const syncVisibility = () => {
      const hasModal = Boolean(
        document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'),
      );
      const shouldShow = visible && !hasModal;
      enqueue('browser_visibility', { visible: shouldShow });
      if (shouldShow) {
        requestAnimationFrame(() => syncBounds());
      }
    };
    const observer = new MutationObserver(syncVisibility);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'role'],
    });
    syncVisibility();
    return () => observer.disconnect();
  }, [native, url, visible, enqueue, syncBounds]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setLoading(false), 15_000);
    return () => window.clearTimeout(timer);
  }, [loading, requestId]);

  useEffect(() => {
    if (dockOpen && activeTab === 'browser' && !url) {
      const frame = requestAnimationFrame(() => emptyInput.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [dockOpen, activeTab, url]);

  useEffect(() => () => {
    if (native) enqueue('browser_close');
  }, [native, enqueue]);

  const submitUrl = (rawValue: string) => {
    const raw = rawValue.trim();
    if (!raw) return;
    const next = browserUrl(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!next) {
      setError('Enter a valid HTTP or HTTPS address.');
      return;
    }
    setError('');
    setEmptyAddress('');
    open(next);
  };

  const navigate = (event: React.FormEvent) => {
    event.preventDefault();
    submitUrl(address);
  };

  const navigateEmpty = (event: React.FormEvent) => {
    event.preventDefault();
    submitUrl(emptyAddress);
  };

  const action = (value: 'back' | 'forward' | 'reload') => {
    if (!url) return;
    if (native) enqueue('browser_action', { action: value });
    else if (value === 'reload') {
      setLoading(true);
      setFrameRevision((revision) => revision + 1);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border px-2.5 py-2">
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Back"
            disabled={!native || !url}
            onClick={() => action('back')}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Forward"
            disabled={!native || !url}
            onClick={() => action('forward')}
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Reload"
            disabled={!url}
            onClick={() => action('reload')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin motion-reduce:animate-none')} />
          </Button>
        </div>

        <form
          onSubmit={navigate}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2"
        >
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref={toolbarInput}
            aria-label="Web address"
            placeholder="Enter http:// or https:// URL…"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.stopPropagation();
            }}
            className="h-7 min-w-0 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
          />
        </form>

        {url && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            aria-label="Close page"
            title="Close page"
            onClick={close}
          >
            <X className="h-3 w-3" />
            <span className="hidden sm:inline">Close page</span>
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="shrink-0 border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {!url ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground">
            <Globe className="h-5 w-5" />
          </div>
          <h2 className="text-sm font-semibold text-foreground">Built-in Browser</h2>
          <p className="mt-1 max-w-[260px] text-xs leading-relaxed text-muted-foreground">
            Open a local dev server, documentation page, or any link side-by-side with your workspace.
          </p>
          <form onSubmit={navigateEmpty} className="mt-4 flex w-full max-w-xs items-center gap-1.5">
            <Input
              ref={emptyInput}
              aria-label="Open URL"
              placeholder="http://localhost:3000"
              value={emptyAddress}
              onChange={(event) => setEmptyAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') event.stopPropagation();
              }}
              className="h-8 flex-1 text-xs"
            />
            <Button type="submit" size="sm" className="h-8 shrink-0 px-3 text-xs" disabled={!emptyAddress.trim()}>
              Open
            </Button>
          </form>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
            {QUICK_URLS.map((chipUrl) => (
              <button
                key={chipUrl}
                type="button"
                onClick={() => open(chipUrl)}
                className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
              >
                {chipUrl.replace('http://', '')}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="min-h-0 min-w-0 flex-1 p-2">
            <div ref={host} className="h-full w-full overflow-hidden rounded-md bg-background">
              {!native && (
                <iframe
                  key={frameRevision}
                  title="Web page"
                  src={url}
                  sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
                  onLoad={() => setLoading(false)}
                  className="h-full w-full border-0"
                />
              )}
            </div>
          </div>
          {!native && (
            <p className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
              Browser preview: some websites do not allow embedding.
            </p>
          )}
        </>
      )}
    </div>
  );
}
