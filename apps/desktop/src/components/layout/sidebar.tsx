import {
  Search,
  FolderGit2,
  Plus,
  ChevronRight,
  Loader2,
  Check,
  AlertCircle,
  Eye,
  Settings,
  User,
  Bot,
  PanelLeftClose,
  PanelLeftOpen,
  KeyRound,
  UsersRound,
  History,
  BarChart2,
  Brain,
  Hammer,
  Shield,
  Circle,
  Ban,
  SquarePen,
  Trash2,
  LogOut,
  House,
  Laptop,
  Moon,
  Sun,
  TerminalSquare,
  Workflow,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { NavigationDeleteAction } from './navigation-row-actions';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MissionHistoryDialog } from '../history/MissionHistoryDialog';
import { ConversationDeleteDialog } from '../history/ConversationDeleteDialog';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useMissionStore, type Mission } from '../../stores/mission-store';
import { useAgentStore, type AgentInstance } from '../../stores/agent-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useManualStore } from '@/stores/manual-store';
import { NavigationDeleteDialog, type NavigationDeleteTarget } from './navigation-delete-dialog';
import { ManualConversationRow } from '@/components/manual/manual-conversation-row';
import { useManualActivityMonitor } from '@/components/manual/manual-activity';
import { useAccountStore } from '../../stores/account-store';
import { CreateWorkspaceDialog } from '../workspace/create-workspace-dialog';
import { useTheme } from 'next-themes';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuthSession } from '@/lib/auth-session';
import { needsMissionAttention, missionStatusLabel } from '@/lib/mission-display';
import { COLOR_PALETTES, normalizeColorPalette } from '@/lib/theme-palettes';

interface SidebarItemProps {
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  isActive?: boolean;
  expanded?: boolean;
  controls?: string;
  onClick: () => void;
  collapsed: boolean;
}

function SidebarItem({ icon, label, badge, isActive, expanded, controls, onClick, collapsed }: SidebarItemProps) {
  const content = (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      aria-current={isActive ? 'page' : undefined}
      aria-expanded={expanded}
      aria-controls={controls}
      className={`group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${isActive ? 'text-sidebar-foreground' : 'text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'} ${collapsed ? 'justify-center' : ''}`}
    >
      {icon}
      {!collapsed && <span>{label}</span>}
      {!collapsed && badge}
    </button>
  );

  if (!collapsed) return content;
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function missionStateIcon(mission: Mission) {
  if (mission.deletionState?.status === 'pending') return <Loader2 className="h-3 w-3 animate-spin text-amber-400" />;
  if (mission.deletionState?.status === 'retryable') return <AlertCircle className="h-3 w-3 text-destructive" />;
  if (['running', 'planning', 'applying', 'verifying', 'revising'].includes(mission.status)) {
    return <Loader2 className="h-3 w-3 animate-spin text-primary" />;
  }
  if (['waiting_for_approval', 'reviewing'].includes(mission.status)) return <Eye className="h-3 w-3 text-amber-400" />;
  if (mission.status === 'completed') return <Check className="h-3 w-3 text-emerald-400" />;
  if (mission.status === 'cancelled') return <Ban className="h-3 w-3 text-muted-foreground" />;
  if (['failed', 'blocked'].includes(mission.status)) return <AlertCircle className="h-3 w-3 text-destructive" />;
  return <Circle className="h-2.5 w-2.5 text-muted-foreground" />;
}

export function conversationDeleteActionLabel(mission: Pick<Mission, 'deletionState'>): string {
  if (mission.deletionState?.status === 'pending') return 'Check deletion status…';
  if (mission.deletionState?.status === 'retryable') return 'Retry conversation deletion…';
  return 'Delete conversation…';
}

export function conversationDeleteStatusLabel(mission: Pick<Mission, 'deletionState'>): string | null {
  if (mission.deletionState?.status === 'pending') return 'Deleting…';
  if (mission.deletionState?.status === 'retryable') return 'Delete failed · retry';
  return null;
}

function agentRoleIcon(role: string) {
  const value = role.toLowerCase();
  if (value === 'orchestrator') return <Brain className="h-3 w-3 text-violet-400" />;
  if (value === 'builder') return <Hammer className="h-3 w-3 text-blue-400" />;
  if (value === 'reviewer') return <Eye className="h-3 w-3 text-amber-400" />;
  if (value === 'researcher') return <Search className="h-3 w-3 text-emerald-400" />;
  if (value === 'qa') return <Shield className="h-3 w-3 text-cyan-400" />;
  return <Bot className="h-3 w-3 text-muted-foreground" />;
}

function agentStatusDot(agent: AgentInstance, missionCancelled = false) {
  if (missionCancelled && !['completed', 'failed'].includes(agent.status)) {
    return <Ban className="h-2.5 w-2.5 text-muted-foreground/70" />;
  }
  if (agent.status === 'running') return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />;
  if (agent.status === 'waiting') return <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />;
  if (agent.status === 'failed') return <span className="h-1.5 w-1.5 rounded-full bg-destructive" />;
  if (agent.status === 'completed') return <Check className="h-2.5 w-2.5 text-emerald-400" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />;
}

function agentTitle(agent: AgentInstance): string {
  if (agent.displayName) return agent.displayName;
  if (agent.specialty) return agent.specialty;
  if (agent.role.toLowerCase() === 'qa') return 'QA Agent';
  return `${agent.role.charAt(0).toUpperCase()}${agent.role.slice(1)}`;
}

function SidebarAgentTree({
  agent,
  allAgents,
  selectedAgentId,
  depth,
  missionCancelled,
  onSelect,
}: {
  agent: AgentInstance;
  allAgents: AgentInstance[];
  selectedAgentId: string | null;
  depth: number;
  missionCancelled: boolean;
  onSelect: (agent: AgentInstance) => void;
}) {
  const children = allAgents.filter((candidate) => candidate.parentAgentId === agent.id);
  return (
    <div>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onSelect(agent); }}
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-1.5 text-[11px] transition-colors ${selectedAgentId === agent.id ? 'bg-primary/10 text-sidebar-foreground' : 'text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground'}`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
        title={`${agentTitle(agent)} · ${missionCancelled && !['completed', 'failed'].includes(agent.status) ? 'cancelled' : agent.status}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{agentRoleIcon(agent.role)}</span>
        <span className="min-w-0 flex-1 truncate text-left">{agentTitle(agent)}</span>
        {agent.unreadMessages ? <span className="min-w-3.5 rounded-full bg-primary px-1 text-center text-[8px] font-semibold text-primary-foreground">{agent.unreadMessages}</span> : null}
        {agentStatusDot(agent, missionCancelled)}
      </button>
      {children.map((child) => (
        <SidebarAgentTree
          key={child.id}
          agent={child}
          allAgents={allAgents}
          selectedAgentId={selectedAgentId}
          depth={depth + 1}
          missionCancelled={missionCancelled}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function Sidebar() {
  const manual = useManualStore();
  const { theme, resolvedTheme, setTheme } = useTheme();
  useManualActivityMonitor();
  const [isWorkspaceDialogOpen, setIsWorkspaceDialogOpen] = useState(false);
  const [isHistoryDialogOpen, setIsHistoryDialogOpen] = useState(false);
  const [navigationDelete, setNavigationDelete] = useState<NavigationDeleteTarget | null>(null);
  const [pendingDeleteMission, setPendingDeleteMission] = useState<Mission | null>(null);
  const newChatWorkspaceIntent = useRef<string | null>(null);
  const { workspaces, activeWorkspaceId, setActiveWorkspace, rememberMission, loading: workspacesLoading, error: workspaceError, fetchWorkspaces } = useWorkspaceStore();
  const { missions, activeMissionId, fetchMissions, setActiveMission, clearActiveMission, setComposerInput } = useMissionStore();
  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const setSelectedAgent = useAgentStore((state) => state.setSelectedAgent);
  const serviceOnline = useAccountStore((state) => state.serviceOnline);
  const { session, logout, isLoggingOut } = useAuthSession();
  const {
    activeView,
    setActiveView,
    sidebarCollapsed,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth,
    colorPalette,
    setColorPalette,
    setCommandPaletteOpen,
    openInspector,
  } = useSettingsStore();

  useEffect(() => {
    if (sidebarCollapsed) return;
    const dismissOverlay = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !window.matchMedia('(max-width: 1180px)').matches) return;
      toggleSidebar();
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('button[aria-label="Workspaces"]')?.focus());
    };
    window.addEventListener('keydown', dismissOverlay);
    return () => window.removeEventListener('keydown', dismissOverlay);
  }, [sidebarCollapsed, toggleSidebar]);

  useEffect(() => {
    if (activeWorkspaceId) void useManualStore.getState().refresh(activeWorkspaceId);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      clearActiveMission();
      return;
    }

    let cancelled = false;
    void (async () => {
      await fetchMissions(activeWorkspaceId);
      if (cancelled) return;

      if (newChatWorkspaceIntent.current === activeWorkspaceId) {
        newChatWorkspaceIntent.current = null;
        clearActiveMission();
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus());
        return;
      }

      const currentMissions = useMissionStore.getState().missions;
      const preferredMissionId = useWorkspaceStore.getState().lastMissionByWorkspace[activeWorkspaceId];
      if (preferredMissionId && currentMissions.some((mission) => mission.id === preferredMissionId)) {
        setActiveMission(preferredMissionId, false);
        return;
      }
      const currentMissionId = useMissionStore.getState().activeMissionId;
      if (currentMissionId) rememberMission(activeWorkspaceId, currentMissionId);
    })();
    return () => { cancelled = true; };
  }, [activeWorkspaceId, clearActiveMission, fetchMissions, rememberMission, setActiveMission]);

  useEffect(() => {
    if (activeWorkspaceId && activeMissionId) rememberMission(activeWorkspaceId, activeMissionId);
  }, [activeMissionId, activeWorkspaceId, rememberMission]);

  const activeMissionAgents = useMemo(
    () => activeMissionId ? agents.filter((agent) => agent.missionId === activeMissionId) : [],
    [activeMissionId, agents],
  );
  const activeAgentIds = useMemo(() => new Set(activeMissionAgents.map((agent) => agent.id)), [activeMissionAgents]);
  const rootAgents = useMemo(
    () => activeMissionAgents.filter((agent) => !agent.parentAgentId || !activeAgentIds.has(agent.parentAgentId)),
    [activeAgentIds, activeMissionAgents],
  );
  const attentionCount = missions.filter((mission) => mission.workspaceId === activeWorkspaceId && needsMissionAttention(mission.status)).length;

  const handleDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.pageX;
    const startWidth = sidebarWidth;
    const onMouseMove = (moveEvent: MouseEvent) => setSidebarWidth(Math.max(200, Math.min(340, startWidth + moveEvent.pageX - startX)));
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const handleWorkspaceSelect = (workspaceId: string) => {
    useManualStore.getState().setCreating(false);
    if (workspaceId !== activeWorkspaceId) setActiveWorkspace(workspaceId);
    manual.setMode('choose');
    setActiveView('chat');
  };

  const handleNewChat = (workspaceId = activeWorkspaceId) => {
    if (!workspaceId) return;
    useManualStore.getState().setMode('choose');
    setComposerInput('');
    setActiveView('chat');

    if (workspaceId !== activeWorkspaceId) {
      newChatWorkspaceIntent.current = workspaceId;
      setActiveWorkspace(workspaceId);
      return;
    }

    clearActiveMission();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus());
  };

  const handleMissionSelect = (missionId: string) => {
    useManualStore.getState().setMode('orchestrator');
    if (activeWorkspaceId) rememberMission(activeWorkspaceId, missionId);
    setActiveMission(missionId);
    setActiveView('chat');
  };

  const handleAgentSelect = (agent: AgentInstance) => {
    useManualStore.getState().setMode('orchestrator');
    setSelectedAgent(agent.id);
    setActiveView('chat');
    openInspector('agents');
  };

  const handleConversationDeleted = (mission: Mission) => {
    if (mission.id === activeMissionId) {
      setComposerInput('');
      setActiveView('chat');
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus());
    }
  };

  const dialogMission = pendingDeleteMission
    ? missions.find((mission) => mission.id === pendingDeleteMission.id) || pendingDeleteMission
    : null;

  return (
    <aside
      aria-label="Project navigation"
      data-collapsed={sidebarCollapsed}
      className="workspace-sidebar relative z-40 flex shrink-0 select-none bg-sidebar"
      style={{ '--workspace-pane-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="workspace-rail flex w-[60px] shrink-0 flex-col items-center border-r border-sidebar-border/70 px-2 pb-3">
        <div data-tauri-drag-region className="flex h-14 w-full shrink-0 items-center justify-center">
          <img src="/logo.svg" alt="AtrisAgent" draggable={false} className="pointer-events-none h-6 w-6 object-contain" />
        </div>
        <nav aria-label="Main navigation" className="flex w-full flex-col gap-1">
          <SidebarItem collapsed icon={<SquarePen className="h-4 w-4" />} label="New conversation" onClick={() => activeWorkspaceId ? handleNewChat() : setIsWorkspaceDialogOpen(true)} />
          <SidebarItem collapsed icon={<Search className="h-4 w-4" />} label="Search conversations" onClick={() => setCommandPaletteOpen(true)} />
          <div className="my-1 border-t border-sidebar-border/70" />
          <SidebarItem collapsed icon={<House className="h-4 w-4" />} label="Home" isActive={activeView === 'chat' && manual.mode === 'choose'} onClick={() => { manual.setMode('choose'); setActiveView('chat'); }} />
          <SidebarItem collapsed icon={<FolderGit2 className="h-4 w-4" />} label="Projects" isActive={activeView === 'projects'} onClick={() => setActiveView('projects')} />
          <SidebarItem collapsed icon={<PanelLeftOpen className="h-4 w-4" />} label="Workspaces" expanded={!sidebarCollapsed} controls="workspace-list-pane" onClick={toggleSidebar} />
          <SidebarItem collapsed icon={<History className="h-4 w-4" />} label="History" onClick={() => setIsHistoryDialogOpen(true)} />
          <SidebarItem collapsed icon={<BarChart2 className="h-4 w-4" />} label="Insights" isActive={activeView === 'dashboard'} onClick={() => setActiveView('dashboard')} />
          <SidebarItem collapsed icon={<UsersRound className="h-4 w-4" />} label="Agents" isActive={activeView === 'agents'} onClick={() => setActiveView('agents')} />
        </nav>
        <div className="mt-auto flex w-full flex-col gap-1 border-t border-sidebar-border/70 pt-2">
          <DropdownMenu>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Account menu" className="relative mx-auto flex h-10 w-10 items-center justify-center rounded-lg text-sidebar-foreground hover:bg-sidebar-accent">
                    <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-sidebar-border bg-sidebar-accent">
                      {session.user?.avatarUrl ? <img src={session.user.avatarUrl} alt="" className="h-full w-full object-cover" /> : <User className="h-4 w-4" />}
                    </span>
                    <span className={`absolute bottom-1 right-1 h-2 w-2 rounded-full border border-sidebar ${serviceOnline ? 'bg-emerald-500' : 'bg-destructive'}`} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">Account and appearance</TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="right" align="end" className="w-56">
              <DropdownMenuLabel className="min-w-0">
                <span className="block truncate">{session.user?.name || session.user?.username || 'AtrisHub account'}</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">{session.user?.email || 'AtrisHub'}</span>
                <span className="mt-2 flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground"><span className={`h-1.5 w-1.5 rounded-full ${serviceOnline ? 'bg-emerald-500' : 'bg-destructive'}`} />{serviceOnline ? 'Local service ready' : 'Local service offline'}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setActiveView('accounts')}><KeyRound />Accounts & models</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setActiveView('settings')}><Settings />Settings</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><Sun />Appearance</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-48">
                  <DropdownMenuRadioGroup value={theme || 'system'} onValueChange={setTheme}>
                    <DropdownMenuRadioItem value="system"><Laptop className="mr-2 h-4 w-4" />System</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="light"><Sun className="mr-2 h-4 w-4" />Light</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark"><Moon className="mr-2 h-4 w-4" />Dark</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Color palette</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={colorPalette} onValueChange={(value) => setColorPalette(normalizeColorPalette(value))}>
                    {COLOR_PALETTES.map((palette) => (
                      <DropdownMenuRadioItem key={palette.id} value={palette.id}>
                        <span className="mr-2 h-3.5 w-3.5 rounded-full border border-border/60" style={{ backgroundColor: palette[resolvedTheme === 'light' ? 'light' : 'dark'].accent }} />
                        {palette.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setActiveView('settings')}>All appearance settings…</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={isLoggingOut} onSelect={() => void logout()} className="text-destructive focus:text-destructive"><LogOut />{isLoggingOut ? 'Signing out…' : 'Sign out'}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div id="workspace-list-pane" className="workspace-pane relative flex min-h-0 min-w-0 flex-1 flex-col border-r border-sidebar-border/70 bg-sidebar">
        <div className="absolute bottom-0 right-0 top-0 z-10 w-1 cursor-col-resize hover:bg-primary/40" onMouseDown={handleDrag} />
        <div data-tauri-drag-region className="flex h-14 shrink-0 items-center justify-between px-4">
          <span data-tauri-drag-region className="text-sm font-semibold text-sidebar-foreground">Workspaces</span>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-sidebar-muted" aria-label="Hide workspaces" onClick={toggleSidebar}><PanelLeftClose className="h-4 w-4" /></Button>
        </div>
        <div className="px-3 pb-2">
          <Button variant="ghost" className="h-9 w-full justify-start gap-2 bg-primary/10 px-3 text-xs font-medium text-sidebar-foreground hover:bg-primary/15" onClick={() => activeWorkspaceId ? handleNewChat() : setIsWorkspaceDialogOpen(true)}>
            <SquarePen className="h-4 w-4 text-primary" />New conversation<kbd className="ml-auto text-[10px] font-normal text-sidebar-muted">Ctrl N</kbd>
          </Button>
        </div>

      <div className="mb-1 mt-2 flex items-center justify-between px-3">
        <p className="flex items-center gap-2 px-1 text-[11px] font-semibold tracking-wide text-sidebar-muted">Projects <span className="text-[10px] font-normal tabular-nums">{workspaces.length}</span>{attentionCount > 0 && <Badge variant="secondary" className="h-4 px-1 text-[9px]">{attentionCount} need attention</Badge>}</p>
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open project" onClick={() => setIsWorkspaceDialogOpen(true)} className="h-6 w-6 text-sidebar-muted hover:text-sidebar-foreground">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Open project</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        {workspaceError && (
          <div role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">
            <p>{workspaceError}</p>
            <Button type="button" variant="outline" size="sm" className="mt-2 h-6 text-[10px]" onClick={() => void fetchWorkspaces()} disabled={workspacesLoading}>
              Retry
            </Button>
          </div>
        )}
        {workspacesLoading && workspaces.length === 0 && !sidebarCollapsed && (
          <div role="status" className="mt-2 flex items-center gap-2 rounded-lg border border-sidebar-border px-3 py-3 text-[10px] text-sidebar-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading projects…
          </div>
        )}
        {workspaces.length === 0 && !sidebarCollapsed && !workspacesLoading && !workspaceError && (
          <button type="button" onClick={() => setIsWorkspaceDialogOpen(true)} className="mt-2 w-full rounded-lg border border-dashed border-sidebar-border px-3 py-4 text-center text-[11px] text-sidebar-muted hover:border-primary/40 hover:text-sidebar-foreground">
            Open your first project
          </button>
        )}

        {workspaces.map((workspace) => {
          const isActiveWorkspace = workspace.id === activeWorkspaceId;
          const workspaceMissions = isActiveWorkspace ? missions.filter((mission) => mission.workspaceId === workspace.id) : [];
          return (
            <div key={workspace.id} className="mb-2">
              <ContextMenu><ContextMenuTrigger asChild><div
                className={`navigation-row group/workspace flex w-full items-center rounded-lg text-xs font-medium transition-colors ${sidebarCollapsed ? 'justify-center' : ''} ${isActiveWorkspace ? 'text-sidebar-foreground' : 'text-sidebar-foreground/85 hover:bg-sidebar-accent'}`}
                title={workspace.path}
              >
                <button
                  type="button"
                  onClick={() => handleWorkspaceSelect(workspace.id)}
                  aria-label={sidebarCollapsed ? workspace.name : undefined}
                  aria-current={isActiveWorkspace ? 'true' : undefined}
                   className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-1.5"
                >
                  {!sidebarCollapsed && <ChevronRight className={`h-3 w-3 shrink-0 text-sidebar-muted transition-transform ${isActiveWorkspace ? 'rotate-90' : ''}`} />}
                  <FolderGit2 className={`h-4 w-4 shrink-0 ${isActiveWorkspace ? 'text-primary' : 'text-sidebar-muted'}`} />
                  {!sidebarCollapsed && <span className="min-w-0 flex-1 truncate text-left">{workspace.name}</span>}
                </button>

                {!sidebarCollapsed && (
                  <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); handleNewChat(workspace.id); }}
                        className="mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-primary"
                        aria-label={`New chat in ${workspace.name}`}
                      >
                        <SquarePen className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">New chat · Ctrl/Cmd+N</TooltipContent>
                  </Tooltip>
                )}

                {!sidebarCollapsed && <NavigationDeleteAction label={`Remove workspace: ${workspace.name}`} onClick={() => setNavigationDelete({ kind: 'workspace', id: workspace.id, name: workspace.name })} />}
              </div></ContextMenuTrigger><ContextMenuContent><ContextMenuItem variant="destructive" onSelect={() => setNavigationDelete({ kind: 'workspace', id: workspace.id, name: workspace.name })}><Trash2 className="h-3.5 w-3.5" />Remove workspace…</ContextMenuItem></ContextMenuContent></ContextMenu>

              {!sidebarCollapsed && isActiveWorkspace && (
                <div className="ml-3 mb-3 pl-2">
                  <div className="mb-1 mt-2 flex h-7 items-center justify-between px-2">
                     <span className="navigation-section-title"><TerminalSquare className="h-3.5 w-3.5 text-primary" />Manual <span className="font-normal tabular-nums">{(manual.conversations[workspace.id] || []).length}</span></span>
                    <button type="button" aria-label="New manual conversation" className="rounded p-1 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { manual.setMode('manual'); manual.setCreating(true); setActiveView('chat'); }}><Plus className="h-3 w-3" /></button>
                  </div>
                  {(manual.conversations[workspace.id] || []).map(conversation => <ManualConversationRow key={conversation.id} conversation={conversation} onDelete={() => setNavigationDelete({kind:'manual',conversation})} active={manual.mode === 'manual' && manual.activeByWorkspace[workspace.id] === conversation.id} onSelect={() => { manual.select(conversation); setActiveView('chat'); }} />)}
                  {manual.error && <button className="px-2 py-1 text-left text-xs text-destructive" onClick={() => void manual.refresh(workspace.id)}>Manual history unavailable · Retry</button>}
                  <div className="mb-1 mt-3 flex h-7 items-center justify-between px-2">
                     <span className="navigation-section-title"><Workflow className="h-3.5 w-3.5 text-primary" />Orchestrator <span className="font-normal tabular-nums">{workspaceMissions.length}</span></span>
                    <button type="button" aria-label="New orchestrated conversation" className="rounded p-1 text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground" onClick={() => { handleNewChat(workspace.id); manual.setMode('orchestrator'); }}><Plus className="h-3 w-3" /></button>
                  </div>

                  {workspaceMissions.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => { handleNewChat(workspace.id); manual.setMode('orchestrator'); }}
                      className="w-full rounded-md border border-dashed border-sidebar-border/70 px-2 py-2 text-left text-[10px] leading-relaxed text-sidebar-muted transition-colors hover:border-primary/30 hover:text-sidebar-foreground"
                    >
                      Start an orchestrated conversation
                    </button>
                  ) : workspaceMissions.map((mission) => {
                    const isActiveMission = manual.mode === 'orchestrator' && mission.id === activeMissionId;
                    const missionAgents = isActiveMission ? activeMissionAgents : [];
                    const missionCancelled = mission.status === 'cancelled';
                     const runningAgents = missionCancelled ? 0 : missionAgents.filter((agent) => agent.status === 'running').length;
                     const deletionStatusLabel = conversationDeleteStatusLabel(mission);
                     const deletionActionLabel = conversationDeleteActionLabel(mission);
                     const deletionPending = mission.deletionState?.status === 'pending';
                     return (
                       <div key={mission.id} className="group/conversation mb-0.5">
                         <ContextMenu>
                           <ContextMenuTrigger asChild>
                             <div
                                data-active={isActiveMission}
                                className="navigation-row flex items-center rounded-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
                               aria-busy={deletionPending || undefined}
                             >
                          <button
                            type="button"
                            onClick={() => handleMissionSelect(mission.id)}
                             disabled={deletionPending}
                              aria-current={isActiveMission ? 'page' : undefined}
                              className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-xs disabled:cursor-wait disabled:opacity-80"
                             title={`${mission.title} · ${deletionStatusLabel || mission.status}`}
                          >
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">{missionStateIcon(mission)}</span>
                            <span className="min-w-0 flex-1 text-left">
                              <span className="block truncate">{mission.title}</span>
                              <span className={`mt-0.5 block truncate text-[11px] ${deletionStatusLabel ? 'text-destructive' : 'text-sidebar-muted'}`}>
                                {deletionStatusLabel || missionStatusLabel(mission.status)}
                                {!deletionStatusLabel && isActiveMission && missionAgents.length > 0 && ` · ${runningAgents > 0 ? `${runningAgents} active` : `${missionAgents.length} agents`}`}
                              </span>
                            </span>
                          </button>

                          <NavigationDeleteAction label={`${deletionActionLabel.replace('…', '')}: ${mission.title}`} onClick={() => setPendingDeleteMission(mission)} />
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent className="w-52">
                              <ContextMenuItem
                                variant="destructive"
                                onSelect={() => {
                                  setPendingDeleteMission(mission);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                {deletionActionLabel}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>

                        {isActiveMission && rootAgents.length > 0 && (
                          <details className="ml-3 mt-1 rounded-lg border border-sidebar-border/50 bg-sidebar-accent/20 px-2 py-1">
                            <summary className="cursor-pointer py-1 text-[11px] text-sidebar-muted hover:text-sidebar-foreground">Team · {activeMissionAgents.length} agents</summary>
                            {rootAgents.map((agent) => (
                              <SidebarAgentTree
                                key={agent.id}
                                agent={agent}
                                allAgents={activeMissionAgents}
                                selectedAgentId={selectedAgentId}
                                depth={0}
                                missionCancelled={missionCancelled}
                                onSelect={handleAgentSelect}
                              />
                            ))}
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </ScrollArea>

       <div className="shrink-0 border-t border-sidebar-border/70 px-4 py-3 text-[11px] text-sidebar-muted">
         <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${serviceOnline ? 'bg-emerald-500' : 'bg-destructive'}`} />
         {serviceOnline ? 'Local service ready' : 'Local service offline'}
       </div>
      </div>

      {navigationDelete && <NavigationDeleteDialog target={navigationDelete} onClose={() => setNavigationDelete(null)}/>}
      <CreateWorkspaceDialog open={isWorkspaceDialogOpen} onOpenChange={setIsWorkspaceDialogOpen} />
      <MissionHistoryDialog open={isHistoryDialogOpen} onOpenChange={setIsHistoryDialogOpen} />
      <ConversationDeleteDialog mission={dialogMission} onOpenChange={(open) => !open && setPendingDeleteMission(null)} onDeleted={handleConversationDeleted} />
    </aside>
  );
}
