import { useEffect, useRef, useState } from 'react';
import { Activity, FileDiff, Globe, Maximize2, Minimize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ActivityPanel } from '@/components/activity/ActivityPanel';
import { LinkBrowser } from '@/components/browser/link-browser';
import { useActivityMonitor, useActivityStore } from '@/stores/activity-store';
import { useBrowserStore } from '@/stores/browser-store';
import {
  RIGHT_DOCK_MAX_WIDTH,
  RIGHT_DOCK_MIN_WIDTH,
  useRightDockStore,
} from '@/stores/right-dock-store';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';
import { DockChanges } from './ChangesPanel';
import { ChangesTab } from '@/components/inspector/changes-tab';

export function RightDock() {
  useActivityMonitor();

  const open = useRightDockStore((state) => state.open);
  const activeTab = useRightDockStore((state) => state.activeTab);
  const width = useRightDockStore((state) => state.width);
  const expanded = useRightDockStore((state) => state.expanded);
  const setTab = useRightDockStore((state) => state.setTab);
  const setWidth = useRightDockStore((state) => state.setWidth);
  const setExpanded = useRightDockStore((state) => state.setExpanded);
  const closeDock = useRightDockStore((state) => state.closeDock);

  const counts = useActivityStore((state) => state.counts);
  const browserUrl = useBrowserStore((state) => state.url);
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth);

  const [windowWidth, setWindowWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));
  const drag = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!open && !browserUrl) return null;

  const narrowOverlay = windowWidth < 1120;
  const isOverlay = expanded || narrowOverlay;
  const sidebarActualWidth = sidebarCollapsed ? 70 : (62 + sidebarWidth + 16);
  const maxSplitWidth = Math.max(260, windowWidth - sidebarActualWidth - 420);
  const splitWidth = Math.min(width, maxSplitWidth);
  const effectiveWidth = isOverlay ? 440 : splitWidth;
  const isCompact = effectiveWidth < 340;

  const keepBrowserMounted = Boolean(browserUrl) || (open && activeTab === 'browser');

  return (
    <aside
      aria-label="Side panel"
      aria-hidden={!open || undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]')) {
          return;
        }
        event.stopPropagation();
        if (expanded) setExpanded(false);
        else closeDock();
      }}
      className={cn(
        '@container/dock relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm',
        !open
          ? 'hidden'
          : expanded
            ? 'fixed inset-3 z-[90] shadow-2xl'
            : narrowOverlay
              ? 'fixed inset-y-14 right-2 z-[90] w-[min(460px,calc(100vw-1rem))] shadow-2xl'
              : 'my-2 mr-2',
      )}
      style={!open || isOverlay ? undefined : { width: splitWidth }}
    >
      {open && !isOverlay && (
        <div
          role="separator"
          aria-label="Resize side panel"
          aria-orientation="vertical"
          aria-valuemin={RIGHT_DOCK_MIN_WIDTH}
          aria-valuemax={RIGHT_DOCK_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          className="absolute bottom-0 left-0 top-0 z-20 w-2 cursor-col-resize touch-none transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none"
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, width: splitWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (drag.current) {
              setWidth(drag.current.width + drag.current.x - event.clientX);
            }
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              setWidth(width + (event.key === 'ArrowLeft' ? 20 : -20));
            }
          }}
        />
      )}

      <header className="flex min-w-0 shrink-0 items-center justify-between gap-1.5 border-b border-border bg-card px-2.5 py-1.5">
        <div
          role="tablist"
          aria-label="Right dock sections"
          className="inline-flex min-w-0 items-center rounded-lg border border-border bg-muted/40 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'activity'}
            onClick={() => setTab('activity')}
            className={cn(
              'inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              activeTab === 'activity'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Activity className="h-3.5 w-3.5 shrink-0" />
            <span className={cn('truncate', isCompact && activeTab !== 'activity' && 'sr-only')}>Activity</span>
            {counts.attention > 0 ? (
              <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500/20 px-1 text-[10px] font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                {counts.attention}
              </span>
            ) : counts.running > 0 ? (
              <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 px-1 text-[10px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {counts.running}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'browser'}
            onClick={() => setTab('browser')}
            className={cn(
              'inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              activeTab === 'browser'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span className={cn('truncate', isCompact && activeTab !== 'browser' && 'sr-only')}>Browser</span>
            {browserUrl && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-label="Page active" />
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'changes'}
            title="Changes"
            onClick={() => setTab('changes')}
            className={cn('inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              activeTab === 'changes' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}
          >
            <FileDiff className="h-3.5 w-3.5 shrink-0" />
            <span className={cn('truncate', isCompact && activeTab !== 'changes' && 'sr-only')}>Changes</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            aria-label={expanded ? 'Restore side panel size' : 'Expand side panel'}
            title={expanded ? 'Restore size' : 'Expand'}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            aria-label="Close side panel"
            title="Close"
            onClick={closeDock}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {open && activeTab === 'activity' && <ActivityPanel compact={isCompact} />}
        {open && activeTab === 'changes' && <DockChanges orchestrator={<ChangesTab />} />}
        {keepBrowserMounted && (
          <div
            className={cn(
              'min-h-0 min-w-0 flex-1 flex-col',
              open && activeTab === 'browser' ? 'flex' : 'hidden',
            )}
          >
            <LinkBrowser />
          </div>
        )}
      </div>
    </aside>
  );
}
