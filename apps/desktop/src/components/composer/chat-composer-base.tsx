import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import {
  AlertCircle,
  AtSign,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RuntimeBrandIcon, RUNTIME_BRANDS } from '@/components/runtime/runtime-brand-icon';
import { TeamTemplateSelector } from './team-template-selector';
import { TrustModeSelector } from './trust-mode-selector';
import { useMissionStore } from '@/stores/mission-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore, type DiscoveredModel } from '@/stores/account-store';
import { cn } from '@/lib/utils';
import { AGENT_ROLES, buildComposerRouteOptions, parseAgentDirective } from '@/lib/agent-directive';

const ROLES = AGENT_ROLES;
const COMMANDS = [
  { id: 'plan', label: 'Create or revise the mission plan' },
  { id: 'agent', label: 'Delegate a focused task to a specialist agent' },
  { id: 'review', label: 'Request a focused review' },
  { id: 'summarize', label: 'Summarize current mission state' },
] as const;
const TERMINAL_CONVERSATION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function titleCase(value: string): string {
  return value === 'xhigh' ? 'Extra High' : value.charAt(0).toUpperCase() + value.slice(1);
}

function modelSupportsRole(model: DiscoveredModel, role: string): boolean {
  return model.suitableRoles.length === 0
    || model.suitableRoles.some((candidate) => candidate.toLowerCase() === role.toLowerCase());
}

export function ChatComposer() {
  const [message, setMessage] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandFilter, setCommandFilter] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [modelRuntimeFilter, setModelRuntimeFilter] = useState<'all' | DiscoveredModel['runtimeType']>('all');
  const [attachments, setAttachments] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startMission = useMissionStore((state) => state.startMission);
  const continueMission = useMissionStore((state) => state.continueMission);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const missions = useMissionStore((state) => state.missions);
  const loading = useMissionStore((state) => state.loading);
  const composerInput = useMissionStore((state) => state.composerInput);
  const setComposerInput = useMissionStore((state) => state.setComposerInput);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const discoveredModels = useAccountStore((state) => state.discoveredModels);
  const serviceOnline = useAccountStore((state) => state.serviceOnline);
  const refreshModels = useAccountStore((state) => state.refreshModels);

  const {
    selectedModel,
    reasoningLevel,
    trustMode,
    automationSettings,
    teamTemplate,
    setSelectedRole,
    setSelectedModel,
    setReasoningLevel,
    setActiveView,
  } = useSettingsStore();

  useEffect(() => { setSelectedRole('Orchestrator'); }, [setSelectedRole]);

  const activeMission = useMemo(
    () => missions.find((mission) => mission.id === activeMissionId),
    [activeMissionId, missions],
  );
  const activeConversationCanContinue = Boolean(
    activeMission && TERMINAL_CONVERSATION_STATUSES.has(activeMission.status),
  );
  const activeConversationBusy = Boolean(activeMission && !activeConversationCanContinue);

  const selectedModelObject = useMemo(
    () => discoveredModels.find((model) => model.catalogId === selectedModel),
    [discoveredModels, selectedModel],
  );

  const directive = useMemo(
    () => parseAgentDirective(message, discoveredModels, 'Orchestrator'),
    [message, discoveredModels],
  );
  const directiveModel = useMemo(
    () => discoveredModels.find((model) => model.catalogId === directive.modelCatalogId),
    [discoveredModels, directive.modelCatalogId],
  );
  const directiveTargetRole = directive.targetRole || 'Orchestrator';
  const directiveModelRoleCompatible = !directiveModel || modelSupportsRole(directiveModel, directiveTargetRole);
  const directiveReasoningSupported = !directive.reasoningLevel
    || !directiveModel
    || directiveModel.supportedReasoning.length === 0
    || directiveModel.supportedReasoning.includes(directive.reasoningLevel as never);
  const routeResolution = useMemo(() => buildComposerRouteOptions(directive, {
    selectedModel: selectedModelObject?.available ? selectedModel : undefined,
    selectedReasoning: reasoningLevel,
    directiveModelDefaultReasoning: directiveModel?.defaultReasoning || directiveModel?.supportedReasoning[0],
    directiveReasoningSupported,
  }), [directive, directiveModel, directiveReasoningSupported, reasoningLevel, selectedModel, selectedModelObject]);

  useEffect(() => {
    if (!selectedModel) return;
    if (selectedModelObject?.available && modelSupportsRole(selectedModelObject, 'Orchestrator')) return;
    setSelectedModel('');
  }, [selectedModel, selectedModelObject, setSelectedModel]);

  useEffect(() => {
    if (!selectedModelObject) return;
    const supported = selectedModelObject.supportedReasoning;
    if (!supported.length) {
      if (reasoningLevel !== 'none') setReasoningLevel('none');
      return;
    }
    if (!supported.includes(reasoningLevel as never)) {
      setReasoningLevel(selectedModelObject.defaultReasoning || supported[0]);
    }
  }, [selectedModelObject, reasoningLevel, setReasoningLevel]);

  useEffect(() => {
    if (!composerInput) return;
    setMessage(composerInput);
    setComposerInput('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [composerInput, setComposerInput]);

  const filteredAgents = ROLES.filter((role) => role.toLowerCase().includes(mentionFilter));
  const filteredCommands = COMMANDS.filter((command) => command.id.includes(commandFilter));
  const reasoningOptions = selectedModelObject?.supportedReasoning.length ? selectedModelObject.supportedReasoning : [];

  const matchingModels = useMemo(() => {
    const search = modelSearch.trim().toLowerCase();
    return discoveredModels.filter((model) => {
      if (!modelSupportsRole(model, 'Orchestrator')) return false;
      if (modelRuntimeFilter !== 'all' && model.runtimeType !== modelRuntimeFilter) return false;
      return !search || [model.name, model.routeLabel, model.accountName, model.provider, model.runtimeModelId]
        .some((value) => value.toLowerCase().includes(search));
    });
  }, [discoveredModels, modelRuntimeFilter, modelSearch]);

  const recommendedModels = matchingModels.filter((model) => model.available && model.category === 'recommended');
  const connectedModels = matchingModels.filter((model) => model.available && !recommendedModels.includes(model));

  const resizeInput = () => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 170)}px`;
  };

  const submit = async () => {
    const prompt = message.trim();
    if (!prompt || loading || activeConversationBusy || !directiveModelRoleCompatible || routeResolution.error || !activeWorkspaceId) return;
    if (!serviceOnline) {
      setActiveView('accounts');
      return;
    }

    const options = {
      teamTemplate,
      trustMode,
      automationSettings,
      ...routeResolution.options,
    };

    setMessage('');
    setAttachments([]);
    setMentionOpen(false);
    setCommandOpen(false);
    if (activeMissionId && activeConversationCanContinue) {
      await continueMission(activeMissionId, prompt, options);
    } else {
      await startMission(prompt, activeWorkspaceId, options);
    }
    requestAnimationFrame(resizeInput);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setMessage(value);
    resizeInput();
    const mention = value.match(/@(\w*)$/);
    const command = value.match(/^\/(\w*)$/);
    setMentionOpen(Boolean(mention));
    setMentionFilter(mention?.[1]?.toLowerCase() || '');
    setCommandOpen(Boolean(command));
    setCommandFilter(command?.[1]?.toLowerCase() || '');
  };

  const insertMention = (role: string) => {
    setMessage((current) => current.replace(/@\w*$/, `@${role} `));
    setMentionOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const insertCommand = (command: string) => {
    setMessage((current) => current.replace(/^\/\w*$/, `/${command} `));
    setCommandOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const appendToken = (token: string) => {
    setMessage((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}${token}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (mentionOpen && filteredAgents[0]) insertMention(filteredAgents[0]);
    else if (commandOpen && filteredCommands[0]) insertCommand(filteredCommands[0].id);
    else void submit();
  };

  const pickAttachments = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => setAttachments(Array.from(input.files || []).map((file) => file.name));
    input.click();
  };

  const renderModelButton = (model: DiscoveredModel) => (
    <button
      key={model.catalogId}
      type="button"
      onClick={(event) => {
        event.preventDefault();
        setSelectedModel(model.catalogId);
        setReasoningLevel(model.defaultReasoning || model.supportedReasoning[0] || 'none');
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
        selectedModel === model.catalogId ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60',
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <RuntimeBrandIcon runtimeId={model.runtimeType} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium">{model.name}</span>
        <span className="block truncate text-[9px] text-muted-foreground">{model.accountName} · {model.routeLabel}</span>
      </span>
      {selectedModel === model.catalogId && <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
    </button>
  );

  const routeLabel = selectedModelObject?.name || 'Auto';
  const composerPlaceholder = !activeWorkspaceId
    ? 'Open a project before starting a mission…'
    : activeConversationBusy
      ? 'This mission is still running. Finish or stop it before sending the next turn…'
      : activeConversationCanContinue
        ? 'Continue this conversation with AtrisAgent…'
        : 'Ask AtrisAgent to build, investigate, or review…';

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto max-w-4xl px-4 py-3">
        {(directive.dynamicAgent || directive.teamWideModel) && (
          <div className={cn(
            'mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px]',
            directiveReasoningSupported && directiveModelRoleCompatible && !routeResolution.error ? 'border-primary/25 bg-primary/[0.04]' : 'border-amber-500/40 bg-amber-500/[0.04]',
          )}>
            <Sparkles className="h-3 w-3 shrink-0 text-primary" />
            <span className="font-medium">{directive.teamWideModel ? `All mission agents: ${directiveModel?.name || selectedModelObject?.name || 'model required'}` : `Delegate to ${directive.targetRole || 'specialist'}`}</span>
            {!directive.teamWideModel && <span className="truncate text-muted-foreground">{directive.modelName || 'role policy'}{directive.reasoningLevel ? ` · ${titleCase(directive.reasoningLevel)}` : ''}</span>}
            {!directiveModelRoleCompatible && <span className="ml-auto text-amber-400">Incompatible model</span>}
            {routeResolution.error && <span className="ml-auto text-amber-400">{routeResolution.error}</span>}
          </div>
        )}

        <div className="relative rounded-xl border border-border/70 bg-card/70 px-3 pb-2 pt-3 shadow-sm transition-all focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
          {mentionOpen && filteredAgents.length > 0 && (
            <div className="absolute bottom-full left-2 z-50 mb-2 w-52 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-xl">
              {filteredAgents.map((role) => (
                <button key={role} type="button" onClick={() => insertMention(role)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted">
                  <AtSign className="h-3 w-3 text-muted-foreground" />{role}
                </button>
              ))}
            </div>
          )}

          {commandOpen && filteredCommands.length > 0 && (
            <div className="absolute bottom-full left-2 z-50 mb-2 w-72 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-xl">
              {filteredCommands.map((command) => (
                <button key={command.id} type="button" onClick={() => insertCommand(command.id)} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted">
                  <div className="flex items-center gap-2 text-xs"><Terminal className="h-3 w-3 text-muted-foreground" />/{command.id}</div>
                  <div className="pl-5 text-[10px] text-muted-foreground">{command.label}</div>
                </button>
              ))}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {attachments.map((name) => <Badge key={name} variant="secondary" className="h-5 max-w-[180px] truncate px-1.5 text-[9px]">{name}</Badge>)}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={composerPlaceholder}
            aria-label="Mission message"
            disabled={loading || !activeWorkspaceId}
            className="block max-h-[170px] min-h-[42px] w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/75 disabled:cursor-not-allowed disabled:opacity-60"
          />

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Attach context" className="h-7 w-7 text-muted-foreground" onClick={pickAttachments} disabled={loading}>
                    <Paperclip className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Attach context</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Target a specialist" className="h-7 w-7 text-muted-foreground" onClick={() => appendToken('@')} disabled={loading}>
                    <AtSign className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Target a specialist</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Mission commands" className="h-7 w-7 text-muted-foreground" onClick={() => { setMessage('/'); setCommandOpen(true); setCommandFilter(''); }} disabled={loading}>
                    <Terminal className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Mission commands</TooltipContent>
              </Tooltip>
            </div>

            <div className="flex min-w-0 items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 max-w-[260px] gap-1.5 px-2 text-[10px] text-muted-foreground">
                    {selectedModelObject
                      ? <RuntimeBrandIcon runtimeId={selectedModelObject.runtimeType} className="h-3 w-3 shrink-0" />
                      : <Sparkles className="h-3 w-3 shrink-0 text-primary" />}
                    <span className="truncate">{routeLabel}</span>
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={8} className="w-[500px] overflow-hidden p-0" onCloseAutoFocus={(event) => event.preventDefault()}>
                  <div className="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-2.5">
                    <div>
                      <div className="flex items-center gap-1.5 text-xs font-semibold"><Settings2 className="h-3.5 w-3.5 text-primary" />Run settings</div>
                      <p className="mt-0.5 text-[9px] text-muted-foreground">{directive.teamWideModel && selectedModelObject ? `All mission agents: ${selectedModelObject.name}` : 'This picker overrides Orchestrator only. Child roles keep their role policies.'}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[9px] text-muted-foreground" onClick={(event) => { event.preventDefault(); void refreshModels(); }}>
                        <RefreshCw className="h-3 w-3" />Refresh routes
                      </Button>
                      <Badge variant="outline" className="text-[9px]">{trustMode}</Badge>
                    </div>
                  </div>

                  <div className="border-b border-border p-3">
                    <button
                      type="button"
                      onClick={(event) => { event.preventDefault(); setSelectedModel(''); }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors',
                        !selectedModel ? 'border-primary/40 bg-primary/[0.06]' : 'border-border hover:bg-muted/50',
                      )}
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10"><Sparkles className="h-4 w-4 text-primary" /></span>
                      <span className="min-w-0 flex-1"><span className="block text-xs font-semibold">Auto routing</span><span className="block text-[9px] text-muted-foreground">Atris chooses the best connected route for the orchestrator and each child agent.</span></span>
                      {!selectedModel && <CheckCircle2 className="h-4 w-4 text-primary" />}
                    </button>

                    <div className="mt-2 flex items-center gap-1">
                      <button type="button" onClick={(event) => { event.preventDefault(); setModelRuntimeFilter('all'); }} className={cn('rounded-md border px-2 py-1 text-[9px]', modelRuntimeFilter === 'all' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}>All</button>
                      {RUNTIME_BRANDS.map((runtime) => (
                        <Tooltip key={runtime.id}>
                          <TooltipTrigger asChild>
                            <button type="button" aria-label={`Filter ${runtime.label} routes`} aria-pressed={modelRuntimeFilter === runtime.id} onClick={(event) => { event.preventDefault(); setModelRuntimeFilter(runtime.id); }} className={cn('flex h-7 w-7 items-center justify-center rounded-md border', modelRuntimeFilter === runtime.id ? 'border-primary bg-primary/10' : 'border-border text-muted-foreground')}>
                              <RuntimeBrandIcon runtimeId={runtime.id} className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>{runtime.label}</TooltipContent>
                        </Tooltip>
                      ))}
                      <div className="relative ml-auto w-[190px]">
                        <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                        <input aria-label="Search connected routes" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search routes…" className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-[10px] outline-none focus:border-primary" />
                      </div>
                    </div>
                  </div>

                  <div className="max-h-[240px] overflow-y-auto p-2">
                    {!matchingModels.length && (
                      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-4 text-[10px] text-muted-foreground">
                        <AlertCircle className="h-4 w-4" />No compatible connected routes. <button type="button" className="ml-auto text-primary hover:underline" onClick={() => setActiveView('accounts')}>Accounts</button>
                      </div>
                    )}
                    {recommendedModels.length > 0 && <div className="mb-1 px-2 text-[8px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recommended</div>}
                    {recommendedModels.map(renderModelButton)}
                    {connectedModels.length > 0 && <div className="mb-1 mt-2 px-2 text-[8px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Connected</div>}
                    {connectedModels.map(renderModelButton)}
                  </div>

                  <div className="space-y-2 border-t border-border bg-muted/15 p-3" onClick={(event) => event.stopPropagation()}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Team & autonomy</span>
                      <div className="flex items-center gap-1"><TeamTemplateSelector /><TrustModeSelector /></div>
                    </div>
                    {selectedModelObject && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Reasoning</span>
                        <div className="flex flex-wrap justify-end gap-1">
                          {reasoningOptions.length > 0 ? reasoningOptions.map((level) => (
                            <Button key={level} variant={reasoningLevel === level ? 'default' : 'outline'} size="sm" className="h-6 rounded-full px-2 text-[9px]" onClick={(event) => { event.preventDefault(); setReasoningLevel(level); }}>
                              {titleCase(level)}
                            </Button>
                          )) : <Badge variant="outline" className="text-[9px]">Runtime default</Badge>}
                        </div>
                      </div>
                    )}
                    <div className="text-[9px] text-muted-foreground">Team: {teamTemplate} · {directive.teamWideModel && selectedModelObject ? `All mission agents: ${selectedModelObject.name}` : selectedModelObject ? `Orchestrator: ${selectedModelObject.name} · child role directives preserved` : 'Auto routing uses role policies.'}</div>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                size="icon"
                className="h-8 w-8 rounded-lg"
                disabled={!message.trim() || loading || activeConversationBusy || !serviceOnline || !activeWorkspaceId || !directiveModelRoleCompatible || Boolean(routeResolution.error)}
                onClick={() => void submit()}
                aria-label={activeConversationCanContinue ? 'Continue conversation' : 'Send mission'}
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-between px-1 text-[9px] text-muted-foreground/70">
          <span>{activeConversationBusy ? 'Mission is running · stop or finish it before the next turn' : activeWorkspaceId ? 'Enter to send · Shift+Enter for a new line' : 'Open a workspace to begin'}</span>
          {message.length > 0 && <span>~{Math.ceil(message.length / 4)} tokens</span>}
        </div>
      </div>
    </div>
  );
}
