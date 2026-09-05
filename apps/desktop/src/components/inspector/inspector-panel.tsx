import { Fragment, useRef, useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';
import { PlanTab } from './plan-tab';
import { BoardTab } from './board-tab';
import { AgentsTab } from './agents-tab';
import { ContextTab } from './context-tab';
import { ChangesTab } from './changes-tab';
import { ChecksTab } from './checks-tab';
import { MemoryTab } from './memory-tab';
import { ArtifactsTab } from './artifacts-tab';
import { ActivityTab } from './activity-tab';
import { useSettingsStore, type InspectorTab } from '@/stores/settings-store';
import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type WorkbenchSection = 'plan' | 'team' | 'output';

const WORKBENCH_SECTIONS: Array<{ id: WorkbenchSection; label: string; views: Array<{ id: InspectorTab; label: string }> }> = [
  { id: 'plan', label: 'Plan', views: [{ id: 'plan', label: 'Overview' }, { id: 'board', label: 'Tasks' }] },
  { id: 'team', label: 'Team', views: [{ id: 'agents', label: 'Agents' }, { id: 'activity', label: 'Activity' }] },
  { id: 'output', label: 'Output', views: [
    { id: 'changes', label: 'Changes' },
    { id: 'checks', label: 'Checks' },
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'context', label: 'Context' },
    { id: 'memory', label: 'Memory' },
  ] },
];

export function InspectorPanel() {
  const {
    inspectorCollapsed,
    inspectorWidth,
    inspectorExpanded,
    inspectorTab,
    toggleInspector,
    setInspectorWidth,
    toggleInspectorExpanded,
    setInspectorExpanded,
    setInspectorTab,
  } = useSettingsStore();
  const isResizing = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [constrained, setConstrained] = useState(() => window.matchMedia('(max-width: 1099px)').matches);
  const overlay = inspectorExpanded || constrained;
  const activeSection = WORKBENCH_SECTIONS.find((section) => section.views.some((view) => view.id === inspectorTab)) || WORKBENCH_SECTIONS[0];

  const focusSection = (index: number) => {
    const nextIndex = (index + WORKBENCH_SECTIONS.length) % WORKBENCH_SECTIONS.length;
    setInspectorTab(WORKBENCH_SECTIONS[nextIndex].views[0].id);
    requestAnimationFrame(() => document.getElementById(`workbench-section-${WORKBENCH_SECTIONS[nextIndex].id}`)?.focus());
  };

  const focusView = (index: number) => {
    const views = activeSection.views;
    const nextIndex = (index + views.length) % views.length;
    setInspectorTab(views[nextIndex].id);
    requestAnimationFrame(() => document.getElementById(`workbench-view-${views[nextIndex].id}`)?.focus());
  };

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1099px)');
    const update = () => {
      setConstrained(query.matches);
      useSettingsStore.setState({ inspectorCollapsed: true, inspectorExpanded: false });
    };
    if (query.matches) useSettingsStore.setState({ inspectorCollapsed: true, inspectorExpanded: false });
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current || overlay) return;
      const newWidth = window.innerWidth - e.clientX;
      const maxWidth = Math.min(720, Math.max(360, window.innerWidth * 0.55));
      if (newWidth >= 300 && newWidth <= maxWidth) setInspectorWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = 'default';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [overlay, setInspectorWidth]);

  useEffect(() => {
    if (!overlay) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusable = () => panelRef.current
      ? Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      : [];
    getFocusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') constrained ? toggleInspector() : setInspectorExpanded(false);
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = getFocusable();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [constrained, inspectorCollapsed, overlay, setInspectorExpanded, toggleInspector]);

  if (inspectorCollapsed) {
    return (
      <div className="absolute right-0 top-1/2 z-10 -translate-y-1/2">
        <Button
          variant="outline"
          size="icon"
          className="h-12 w-8 rounded-l-md rounded-r-none border-r-0 bg-card shadow-sm hover:bg-accent"
          onClick={toggleInspector}
          aria-label={constrained ? 'Open Mission Workbench overlay' : 'Open Mission Workbench'}
        >
          <PanelRightOpen className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <Fragment>
    {overlay && (
      <button type="button" className="fixed inset-0 z-[69] cursor-default bg-background/55 backdrop-blur-[1px]" onClick={() => constrained ? toggleInspector() : setInspectorExpanded(false)} aria-label="Close inspector overlay" />
    )}
    <aside
      ref={panelRef}
       tabIndex={overlay ? -1 : undefined}
       role={overlay ? 'dialog' : undefined}
       aria-modal={overlay || undefined}
      aria-label="Mission Workbench"
      className={cn(
        'flex min-w-0 flex-col overflow-hidden border-l border-border bg-card',
         overlay
          ? 'fixed bottom-3 right-3 top-3 z-[70] rounded-xl border border-border shadow-2xl outline-none'
          : 'relative shrink-0 transition-[width] duration-0',
      )}
        style={overlay
        ? { width: constrained ? 'min(480px, calc(100vw - 24px))' : 'min(960px, calc(100vw - 24px))', maxWidth: 'calc(100vw - 24px)' }
        : { width: inspectorWidth, minWidth: 'min(300px, 100vw)', maxWidth: '55vw' }}
    >
       {!overlay && (
        <div
          className="absolute bottom-0 left-0 top-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-primary/50 active:bg-primary"
          onMouseDown={() => {
            isResizing.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
        />
      )}

      <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border bg-muted/10 px-2">
        <div className="min-w-0 flex-1">
          <div className="px-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Mission Workbench</div>
          <nav aria-label="Workbench sections" className="no-scrollbar flex h-10 min-w-0 items-center gap-0.5 overflow-x-auto pr-1">
            {WORKBENCH_SECTIONS.map((section) => (
              <button
                type="button"
                id={`workbench-section-${section.id}`}
                aria-current={activeSection.id === section.id ? 'page' : undefined}
                tabIndex={activeSection.id === section.id ? 0 : -1}
                key={section.id}
                onClick={() => setInspectorTab(section.views[0].id)}
                onKeyDown={(event) => {
                  const index = WORKBENCH_SECTIONS.findIndex((item) => item.id === section.id);
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); focusSection(index + 1); }
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); focusSection(index - 1); }
                  if (event.key === 'Home') { event.preventDefault(); focusSection(0); }
                  if (event.key === 'End') { event.preventDefault(); focusSection(WORKBENCH_SECTIONS.length - 1); }
                }}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 text-[10px] transition-colors',
                  activeSection.id === section.id
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {section.label}
              </button>
            ))}
          </nav>
        </div>

        {!constrained && <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={toggleInspectorExpanded}
              aria-label={inspectorExpanded ? 'Restore inspector' : 'Expand inspector'}
            >
              {inspectorExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{inspectorExpanded ? 'Restore inspector (Esc)' : 'Focus inspector'}</TooltipContent>
        </Tooltip>}

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={toggleInspector}
          aria-label="Close inspector"
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>

      {activeSection.views.length > 1 && (
        <div role="tablist" className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-border bg-muted/5 px-3 py-1.5" aria-label={`${activeSection.label} views`}>
          {activeSection.views.map((view) => (
            <button
              key={view.id}
              id={`workbench-view-${view.id}`}
              type="button"
              role="tab"
              aria-selected={inspectorTab === view.id}
              aria-controls={`workbench-content-${view.id}`}
              tabIndex={inspectorTab === view.id ? 0 : -1}
              onClick={() => setInspectorTab(view.id)}
              onKeyDown={(event) => {
                const index = activeSection.views.findIndex((item) => item.id === view.id);
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); focusView(index + 1); }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); focusView(index - 1); }
                if (event.key === 'Home') { event.preventDefault(); focusView(0); }
                if (event.key === 'End') { event.preventDefault(); focusView(activeSection.views.length - 1); }
              }}
              className={cn('rounded px-2 py-1 text-[10px]', inspectorTab === view.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {view.label}
            </button>
          ))}
        </div>
      )}

      <Tabs.Root value={inspectorTab} onValueChange={(value) => setInspectorTab(value as InspectorTab)} className="min-h-0 flex-1 overflow-hidden">
        <Tabs.Content id="workbench-content-plan" aria-labelledby="workbench-view-plan" value="plan" className="m-0 h-full min-w-0 border-none outline-none"><PlanTab /></Tabs.Content>
        <Tabs.Content id="workbench-content-board" aria-labelledby="workbench-view-board" value="board" className="m-0 h-full min-w-0 border-none outline-none"><BoardTab /></Tabs.Content>
        <Tabs.Content id="workbench-content-agents" aria-labelledby="workbench-view-agents" value="agents" className="m-0 h-full min-w-0 border-none outline-none"><AgentsTab /></Tabs.Content>
        <Tabs.Content id="workbench-content-context" aria-labelledby="workbench-view-context" value="context" className="m-0 h-full min-w-0 border-none outline-none"><ContextTab /></Tabs.Content>
        <Tabs.Content id="workbench-content-changes" aria-labelledby="workbench-view-changes" value="changes" className="m-0 h-full min-w-0 border-none outline-none"><ChangesTab /></Tabs.Content>
        <Tabs.Content id="workbench-content-checks" aria-labelledby="workbench-view-checks" value="checks" className="m-0 h-full min-w-0 border-none outline-none"><ChecksTab /></Tabs.Content>
        <Tabs.Content id="workbench-content-memory" aria-labelledby="workbench-view-memory" value="memory" className="m-0 h-full min-w-0 border-none outline-none"><MemoryTab /></Tabs.Content>
        <Tabs.Content id="workbench-content-artifacts" aria-labelledby="workbench-view-artifacts" value="artifacts" className="m-0 h-full min-w-0 border-none outline-none"><ArtifactsTab /></Tabs.Content>
        <Tabs.Content id="workbench-content-activity" aria-labelledby="workbench-view-activity" value="activity" className="m-0 h-full min-w-0 border-none outline-none"><ActivityTab /></Tabs.Content>
      </Tabs.Root>
    </aside>
    </Fragment>
  );
}
