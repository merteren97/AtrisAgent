import { useRef } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import * as Tabs from '@radix-ui/react-tabs';
import { ClipboardList, Layers3, PanelRightOpen, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useSettingsStore, type InspectorTab } from '@/stores/settings-store';
import { PlanTab } from './plan-tab';
import { BoardTab } from './board-tab';
import { AgentsTab } from './agents-tab';
import { ContextTab } from './context-tab';
import { ChangesTab } from './changes-tab';
import { ChecksTab } from './checks-tab';
import { MemoryTab } from './memory-tab';
import { ArtifactsTab } from './artifacts-tab';
import { ActivityTab } from './activity-tab';

const sections = [
  { label: 'Plan', icon: ClipboardList, description: 'Direction and execution', views: [{ id: 'plan', label: 'Overview', component: PlanTab }, { id: 'board', label: 'Tasks', component: BoardTab }] },
  { label: 'Team', icon: Users, description: 'Agents and live activity', views: [{ id: 'agents', label: 'Agents', component: AgentsTab }, { id: 'activity', label: 'Activity', component: ActivityTab }] },
  { label: 'Output', icon: Layers3, description: 'Changes and verification', views: [{ id: 'changes', label: 'Changes', component: ChangesTab }, { id: 'checks', label: 'Checks', component: ChecksTab }, { id: 'artifacts', label: 'Artifacts', component: ArtifactsTab }, { id: 'context', label: 'Context', component: ContextTab }, { id: 'memory', label: 'Memory', component: MemoryTab }] },
] as const;

export function InspectorPanel() {
  const { inspectorCollapsed, inspectorTab, setInspectorTab } = useSettingsStore();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const section = sections.find(item => item.views.some(view => view.id === inspectorTab)) || sections[0];
  const setOpen = (open: boolean) => useSettingsStore.setState({ inspectorCollapsed: !open, inspectorExpanded: open });

  return <DialogPrimitive.Root open={!inspectorCollapsed} onOpenChange={setOpen}>
    <DialogPrimitive.Trigger asChild>
      <Button ref={triggerRef} variant="outline" size="icon" className="absolute right-0 top-1/2 z-10 h-12 w-8 -translate-y-1/2 rounded-l-lg rounded-r-none border-r-0 bg-card shadow-sm" aria-label="Open Mission Workbench">
        <PanelRightOpen className="h-4 w-4 text-muted-foreground" />
      </Button>
    </DialogPrimitive.Trigger>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-background/60 backdrop-blur-md data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
      <DialogPrimitive.Content id="mission-workbench" aria-describedby="workbench-description" onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }} className="fixed inset-3 z-[110] flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl outline-none sm:inset-5 lg:inset-6">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-5 sm:px-8">
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Orchestrator</p>
            <DialogPrimitive.Title className="text-xl font-semibold tracking-tight sm:text-2xl">Mission Workbench</DialogPrimitive.Title>
            <DialogPrimitive.Description id="workbench-description" className="mt-1 text-sm text-muted-foreground">Follow the plan, coordinate your team, and review the results.</DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close asChild><Button variant="outline" size="icon" className="h-10 w-10 shrink-0 rounded-xl" aria-label="Close inspector"><X className="h-4 w-4" /></Button></DialogPrimitive.Close>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label="Workbench sections" className="flex shrink-0 gap-1 border-b border-border bg-muted/15 p-3 sm:w-56 sm:flex-col sm:border-b-0 sm:border-r sm:p-4">
            {sections.map(item => <button type="button" key={item.label} aria-current={section.label === item.label ? 'page' : undefined} onClick={() => setInspectorTab(item.views[0].id)} className={cn('flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none', section.label === item.label ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
              <item.icon className="h-5 w-5 shrink-0" /><span className="min-w-0"><span className="block text-sm font-medium">{item.label}</span><span className="mt-0.5 hidden text-xs leading-5 text-muted-foreground sm:block">{item.description}</span></span>
            </button>)}
          </nav>
          <Tabs.Root value={inspectorTab} onValueChange={value => setInspectorTab(value as InspectorTab)} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Tabs.List aria-label={section.label + ' views'} className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 py-3 sm:px-6">
              {section.views.map(view => <Tabs.Trigger key={view.id} value={view.id} className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-accent data-[state=active]:text-foreground">{view.label}</Tabs.Trigger>)}
            </Tabs.List>
            {sections.flatMap(item => item.views.map(view => <Tabs.Content key={view.id} value={view.id} className="m-0 min-h-0 min-w-0 flex-1 overflow-auto p-2 outline-none sm:p-4"><view.component /></Tabs.Content>))}
          </Tabs.Root>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
