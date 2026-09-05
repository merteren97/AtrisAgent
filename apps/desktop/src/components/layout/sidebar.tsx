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
  MoreHorizontal,
  Trash2,
  LogOut,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MissionHistoryDialog } from '../history/MissionHistoryDialog';
import { ConversationDeleteDialog } from '../history/ConversationDeleteDialog';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useMissionStore, type Mission } from '../../stores/mission-store';
import { useAgentStore, type AgentInstance } from '../../stores/agent-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useAccountStore } from '../../stores/account-store';
import { CreateWorkspaceDialog } from '../workspace/create-workspace-dialog';
import { ThemeToggle } from '../theme-toggle';
import { useAuthSession } from '@/lib/auth-session';
import { needsMissionAttention } from '@/lib/mission-display';

interface SidebarItemProps {
  icon: ReactNode;
  label: string;
  badge?: ReactNode;
  isActive?: boolean;
  onClick: () => void;
  collapsed: boolean;
}

function SidebarItem({ icon, label, badge, isActive, onClick, collapsed }: SidebarItemProps) {
  const content = (
    <button
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${isActive ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-foreground'} ${collapsed ? 'justify-center' : ''}`}
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
  const [isWorkspaceDialogOpen, setIsWorkspaceDialogOpen] = useState(false);
  const [isHistoryDialogOpen, setIsHistoryDialogOpen] = useState(false);
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
    setCommandPaletteOpen,
    openInspector,
  } = useSettingsStore();

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
        setActiveMission(preferredMissionId);
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
    setActiveWorkspace(workspaceId);
    setActiveView('chat');
  };

  const handleNewChat = (workspaceId = activeWorkspaceId) => {
    if (!workspaceId) return;
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
    if (activeWorkspaceId) rememberMission(activeWorkspaceId, missionId);
    setActiveMission(missionId);
    setActiveView('chat');
  };

  const handleAgentSelect = (agent: AgentInstance) => {
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

  const currentWidth = sidebarCollapsed ? 48 : sidebarWidth;

  return (
    <aside
      aria-label="Project navigation"
      className="relative flex flex-col select-none border-r border-sidebar-border bg-sidebar transition-[width] duration-300 ease-in-out"
      style={{ width: currentWidth, minWidth: currentWidth }}
    >
      <div className="absolute bottom-0 right-0 top-0 z-50 w-1 cursor-col-resize transition-colors hover:bg-primary/50" onMouseDown={handleDrag} />

      <div data-tauri-drag-region className={`flex items-center border-b border-sidebar-border ${sidebarCollapsed ? 'h-auto flex-col justify-center gap-2 py-2' : 'h-12 justify-between px-3'}`}>
        <div data-tauri-drag-region className="flex items-center gap-2">
          <img
            data-tauri-drag-region
            src="/logo.svg"
            alt="AtrisAgent"
            draggable={false}
            className="h-6 w-6 shrink-0 object-contain"
          />
          {!sidebarCollapsed && <span data-tauri-drag-region className="whitespace-nowrap text-sm font-semibold text-sidebar-foreground">AtrisAgent</span>}
        </div>
        <div className={`flex items-center gap-1 ${sidebarCollapsed ? 'flex-col' : ''}`}>
          {!sidebarCollapsed && <ThemeToggle compact />}
          <Button variant="ghost" size="icon" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="h-7 w-7 text-sidebar-muted hover:text-sidebar-foreground" onClick={toggleSidebar}>
            {sidebarCollapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      <div className="px-2 py-2">
        <button
          type="button"
          aria-label="Search workspaces and missions"
          onClick={() => setCommandPaletteOpen(true)}
          className={`flex w-full items-center rounded-md border border-sidebar-border/70 bg-sidebar-accent py-1.5 text-xs text-sidebar-muted transition-colors hover:text-sidebar-foreground ${sidebarCollapsed ? 'justify-center' : 'gap-2 px-2.5'}`}
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          {!sidebarCollapsed && <><span>Search</span><kbd className="ml-auto rounded border border-sidebar-border bg-sidebar px-1 py-0.5 font-sans text-[9px]">⌘K</kbd></>}
        </button>
      </div>

      <div className="px-2 pb-2">
        <div className="space-y-0.5">
          <SidebarItem
            collapsed={sidebarCollapsed}
            icon={<BarChart2 className="h-3.5 w-3.5 text-primary" />}
            label="Home"
            isActive={activeView === 'dashboard'}
            onClick={() => setActiveView('dashboard')}
            badge={attentionCount > 0 ? <Badge variant="secondary" className="ml-auto h-4 min-w-4 px-1 text-[9px]">{attentionCount}</Badge> : undefined}
          />
          <SidebarItem collapsed={sidebarCollapsed} icon={<FolderGit2 className="h-3.5 w-3.5 text-primary" />} label="Projects" isActive={activeView === 'projects'} onClick={() => setActiveView('projects')} />
          <SidebarItem collapsed={sidebarCollapsed} icon={<History className="h-3.5 w-3.5 text-muted-foreground" />} label="History" onClick={() => setIsHistoryDialogOpen(true)} />
        </div>
      </div>

      <Separator className="bg-sidebar-border" />

      <div className={`mb-1 mt-2 flex items-center ${sidebarCollapsed ? 'justify-center' : 'justify-between px-3'}`}>
        {!sidebarCollapsed && <p className="px-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-sidebar-muted">Workspaces</p>}
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open project" onClick={() => setIsWorkspaceDialogOpen(true)} className="h-6 w-6 text-sidebar-muted hover:text-sidebar-foreground">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Open project</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1 px-2">
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
              <div
                className={`group/workspace flex w-full items-center rounded-md text-xs font-medium transition-colors ${sidebarCollapsed ? 'justify-center' : ''} ${isActiveWorkspace ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-sidebar-foreground/85 hover:bg-sidebar-accent'}`}
                title={workspace.path}
              >
                <button
                  type="button"
                  onClick={() => handleWorkspaceSelect(workspace.id)}
                  aria-label={sidebarCollapsed ? workspace.name : undefined}
                  className={`flex min-w-0 flex-1 items-center ${sidebarCollapsed ? 'justify-center py-1.5' : 'gap-1.5 py-1.5 pl-1.5'}`}
                >
                  {!sidebarCollapsed && <ChevronRight className={`h-3 w-3 shrink-0 text-sidebar-muted transition-transform ${isActiveWorkspace ? 'rotate-90' : ''}`} />}
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-sidebar-muted" />
                  {!sidebarCollapsed && <span className="min-w-0 flex-1 truncate text-left">{workspace.name}</span>}
                </button>

                {!sidebarCollapsed && (
                  <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); handleNewChat(workspace.id); }}
                        className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sidebar-muted opacity-0 transition-all hover:bg-sidebar hover:text-primary focus:opacity-100 focus:outline-none group-hover/workspace:opacity-100"
                        aria-label={`New chat in ${workspace.name}`}
                      >
                        <SquarePen className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">New chat · Ctrl/Cmd+N</TooltipContent>
                  </Tooltip>
                )}

                {!sidebarCollapsed && isActiveWorkspace && (
                  <span className="mr-1 shrink-0 rounded-full bg-sidebar px-1.5 py-0.5 text-[8px] font-medium text-sidebar-muted">{workspaceMissions.length}</span>
                )}
              </div>

              {!sidebarCollapsed && isActiveWorkspace && (
                <div className="ml-3 mt-1 border-l border-sidebar-border/70 pl-2">
                  <div className="mb-1 flex items-center justify-between px-2">
                    <span className="text-[8px] font-semibold uppercase tracking-[0.14em] text-sidebar-muted/80">Conversations</span>
                    {workspaceMissions.length > 0 && <span className="text-[8px] tabular-nums text-sidebar-muted/70">{workspaceMissions.length}</span>}
                  </div>

                  {workspaceMissions.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => handleNewChat(workspace.id)}
                      className="w-full rounded-md border border-dashed border-sidebar-border/70 px-2 py-2 text-left text-[10px] leading-relaxed text-sidebar-muted transition-colors hover:border-primary/30 hover:text-sidebar-foreground"
                    >
                      No conversations yet. Hover the project and use the compose icon to start one.
                    </button>
                  ) : workspaceMissions.map((mission) => {
                    const isActiveMission = mission.id === activeMissionId;
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
                               className={`flex items-center rounded-md transition-colors ${isActiveMission ? 'bg-primary/[0.07] text-sidebar-foreground' : 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground'}`}
                               aria-busy={deletionPending || undefined}
                             >
                          <button
                            type="button"
                            onClick={() => handleMissionSelect(mission.id)}
                             disabled={deletionPending}
                             className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-[11px] disabled:cursor-wait disabled:opacity-80"
                             title={`${mission.title} · ${deletionStatusLabel || mission.status}`}
                          >
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">{missionStateIcon(mission)}</span>
                            <span className="min-w-0 flex-1 truncate text-left">{mission.title}</span>
                             {deletionStatusLabel ? (
                               <span className={`shrink-0 text-[9px] ${mission.deletionState?.status === 'retryable' ? 'text-destructive' : 'text-amber-400'}`}>
                                 {deletionStatusLabel}
                               </span>
                             ) : isActiveMission && missionAgents.length > 0 ? (
                               <span className="shrink-0 text-[9px] text-sidebar-muted">
                                 {runningAgents > 0 ? `${runningAgents} active` : `${missionAgents.length} agents`}
                               </span>
                             ) : null}
                          </button>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                 className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sidebar-muted opacity-70 transition-all hover:bg-sidebar hover:text-sidebar-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-sidebar data-[state=open]:text-sidebar-foreground data-[state=open]:opacity-100 group-hover/conversation:opacity-100"
                                aria-label={`Conversation actions for ${mission.title}`}
                                title="Conversation actions"
                              >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent side="right" align="start" className="w-52">
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                  setPendingDeleteMission(mission);
                                }}
                               >
                                 <Trash2 className="h-3.5 w-3.5" />
                                 {deletionActionLabel}
                              </DropdownMenuItem>
                           </DropdownMenuContent>
                         </DropdownMenu>
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
                          <div className="ml-2 mt-0.5 border-l border-sidebar-border/50 pl-1">
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
                          </div>
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

      <Separator className="bg-sidebar-border" />
      <div className="space-y-0.5 px-2 py-2">
        <SidebarItem collapsed={sidebarCollapsed} icon={<UsersRound className="h-3.5 w-3.5 text-violet-400" />} label="Agents" isActive={activeView === 'agents'} onClick={() => setActiveView('agents')} />
        <SidebarItem collapsed={sidebarCollapsed} icon={<KeyRound className="h-3.5 w-3.5 text-amber-500" />} label="Accounts" isActive={activeView === 'accounts'} onClick={() => setActiveView('accounts')} />
        <SidebarItem collapsed={sidebarCollapsed} icon={<Settings className="h-3.5 w-3.5 text-muted-foreground" />} label="Settings" isActive={activeView === 'settings'} onClick={() => setActiveView('settings')} />
      </div>

      <div className={`border-t border-sidebar-border ${sidebarCollapsed ? 'p-2' : 'p-3'} overflow-hidden`}>
        {!sidebarCollapsed ? (
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-sidebar-border bg-sidebar-accent">
              {session.user?.avatarUrl ? (
                <img src={session.user.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-sidebar-foreground" title={session.user?.email || undefined}>
                {session.user?.name || session.user?.username || session.user?.email || 'AtrisHub account'}
              </p>
              <p className="flex items-center gap-1.5 text-[9px] text-sidebar-muted">
                <span className={`h-1.5 w-1.5 rounded-full ${serviceOnline ? 'bg-emerald-400' : 'bg-destructive'}`} />
                {serviceOnline ? 'Local service ready' : 'Local service offline'}
              </p>
            </div>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-sidebar-muted hover:text-sidebar-foreground"
                  onClick={() => void logout()}
                  disabled={isLoggingOut}
                  aria-label="Sign out of AtrisAgent"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{isLoggingOut ? 'Signing out…' : 'Sign out'}</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-sidebar-muted hover:text-sidebar-foreground"
                onClick={() => void logout()}
                disabled={isLoggingOut}
                aria-label="Sign out of AtrisAgent"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {isLoggingOut ? 'Signing out…' : `${session.user?.email || 'Account'} · Sign out (${serviceOnline ? 'service ready' : 'service offline'})`}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <CreateWorkspaceDialog open={isWorkspaceDialogOpen} onOpenChange={setIsWorkspaceDialogOpen} />
      <MissionHistoryDialog open={isHistoryDialogOpen} onOpenChange={setIsHistoryDialogOpen} />
      <ConversationDeleteDialog mission={dialogMission} onOpenChange={(open) => !open && setPendingDeleteMission(null)} onDeleted={handleConversationDeleted} />
    </aside>
  );
}
