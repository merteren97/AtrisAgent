import { useRef, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';
import { PlanTab } from './plan-tab';
import { BoardTab } from './board-tab';
import { AgentsTab } from './agents-tab';
import { ContextTab } from './context-tab';
import { ChangesTab } from './changes-tab';
import { ChecksTab } from './checks-tab';
import { ArtifactsTab } from './artifacts-tab';
import { ActivityTab } from './activity-tab';
import { useSettingsStore, type InspectorTab } from '@/stores/settings-store';
import { Maximize2, Minimize2, MoreHorizontal, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const PRIMARY_TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'agents', label: 'Agents' },
  { id: 'changes', label: 'Changes' },
  { id: 'checks', label: 'Review' },
  { id: 'activity', label: 'Activity' },
];

const MORE_TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'board', label: 'Task board' },
  { id: 'context', label: 'Context' },
  { id: 'artifacts', label: 'Artifacts' },
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
  const moreActive = MORE_TABS.some((tab) => tab.id === inspectorTab);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current || inspectorExpanded) return;
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
  }, [inspectorExpanded, setInspectorWidth]);

  useEffect(() => {
    if (!inspectorExpanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInspectorExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [inspectorExpanded, setInspectorExpanded]);

  if (inspectorCollapsed) {
    return (
      <div className="absolute right-0 top-1/2 z-10 -translate-y-1/2">
        <Button
          variant="outline"
          size="icon"
          className="h-12 w-8 rounded-l-md rounded-r-none border-r-0 bg-card shadow-sm hover:bg-accent"
          onClick={toggleInspector}
          aria-label="Open inspector"
        >
          <PanelRightOpen className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <aside
      className={cn(
        'flex min-w-0 flex-col overflow-hidden border-l border-border bg-card',
        inspectorExpanded
          ? 'fixed inset-0 z-[70] border-l-0 shadow-2xl'
          : 'relative shrink-0 transition-[width] duration-0',
      )}
      style={inspectorExpanded
        ? { width: '100vw', minWidth: '100vw' }
        : { width: inspectorWidth, minWidth: inspectorWidth }}
    >
      {!inspectorExpanded && (
        <div
          className="absolute bottom-0 left-0 top-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-primary/50 active:bg-primary"
          onMouseDown={() => {
            isResizing.current = true;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
          }}
        />
      )}

      <div className="flex h-12 min-w-0 shrink-0 items-center gap-1 border-b border-border bg-muted/10 px-2">
        {inspectorExpanded && (
          <div className="hidden shrink-0 items-center gap-2 px-1 lg:flex">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Inspector</span>
            <span className="h-4 w-px bg-border" />
          </div>
        )}

        <Tabs.Root value={inspectorTab} onValueChange={(value) => setInspectorTab(value as InspectorTab)} className="min-w-0 flex-1">
          <Tabs.List className="no-scrollbar flex h-12 min-w-0 items-center gap-0.5 overflow-x-auto pr-1">
            {PRIMARY_TABS.map((tab) => (
              <Tabs.Trigger
                key={tab.id}
                value={tab.id}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] transition-colors',
                  inspectorTab === tab.id
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={moreActive ? 'secondary' : 'ghost'}
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground"
              aria-label="More inspector views"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {MORE_TABS.map((tab) => (
              <DropdownMenuItem key={tab.id} onClick={() => setInspectorTab(tab.id)}>
                {tab.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip delayDuration={0}>
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
        </Tooltip>

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

      <Tabs.Root value={inspectorTab} onValueChange={(value) => setInspectorTab(value as InspectorTab)} className="min-h-0 flex-1 overflow-hidden">
        <Tabs.Content value="plan" className="m-0 h-full min-w-0 border-none outline-none"><PlanTab /></Tabs.Content>
        <Tabs.Content value="board" className="m-0 h-full min-w-0 border-none outline-none"><BoardTab /></Tabs.Content>
        <Tabs.Content value="agents" className="m-0 h-full min-w-0 border-none outline-none"><AgentsTab /></Tabs.Content>
        <Tabs.Content value="context" className="m-0 h-full min-w-0 border-none outline-none"><ContextTab /></Tabs.Content>
        <Tabs.Content value="changes" className="m-0 h-full min-w-0 border-none outline-none"><ChangesTab /></Tabs.Content>
        <Tabs.Content value="checks" className="m-0 h-full min-w-0 border-none outline-none"><ChecksTab /></Tabs.Content>
        <Tabs.Content value="artifacts" className="m-0 h-full min-w-0 border-none outline-none"><ArtifactsTab /></Tabs.Content>
        <Tabs.Content value="activity" className="m-0 h-full min-w-0 border-none outline-none"><ActivityTab /></Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
