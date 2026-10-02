import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AtSign, ChevronDown, Clock3, Loader2, Paperclip, Send, Settings2, Sparkles, Terminal, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TeamTemplateSelector } from './team-template-selector';
import { AgentProfileSelector } from './agent-profile-selector';
import { OrchestratorModelSelector } from '@/components/orchestrator/orchestrator-model-selector';
import { OrchestratorPreferenceFields } from '@/components/orchestrator/orchestrator-defaults';
import { OrchestratorAttachmentTray, useOrchestratorAttachments } from '@/components/orchestrator/orchestrator-attachments';
import { useOrchestratorPreferences, useOrchestratorPreferencesStore } from '@/stores/orchestrator-preferences-store';
import { useMissionStore, type StartMissionOptions, type TurnDelivery } from '@/stores/mission-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore } from '@/stores/account-store';
import { AGENT_ROLES, parseAgentDirective } from '@/lib/agent-directive';
import { resolveOrchestratorRoute } from '@/lib/orchestrator-route';
import { cn } from '@/lib/utils';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const COMMANDS = [{ id: 'plan', label: 'Plan without launching workers' }, { id: 'agent', label: 'Delegate a focused task' }, { id: 'review', label: 'Request a focused review' }, { id: 'summarize', label: 'Summarize the current work' }];
const MODE_LABELS = { auto: 'Auto', research: 'Research · read-only', plan: 'Plan · no execution', execute: 'Execute & verify' };

export function ChatComposer() {
  const { preferences, updatePreferences, scopeKey, workspaceId, missionId, draft: message, setDraft: setMessage, customized } = useOrchestratorPreferences();
  const attachmentState = useOrchestratorAttachments(scopeKey, workspaceId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveNotice, setSaveNotice] = useState('');
  const [delivery, setDelivery] = useState<TurnDelivery>('queue');
  const [picker, setPicker] = useState<'mention' | 'command' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const { missions, loading, pendingMissionStart, composerInput, setComposerInput, queuedTurns, error } = useMissionStore();
  const { discoveredModels, serviceOnline } = useAccountStore();
  const mission = missions.find(item => item.id === missionId);
  const busy = Boolean(mission && !TERMINAL.has(mission.status));
  const locked = sending || attachmentState.uploading || loading || Boolean(pendingMissionStart) || !workspaceId;
  const directive = useMemo(() => parseAgentDirective(message, discoveredModels, 'Orchestrator'), [message, discoveredModels]);
  const route = useMemo(() => resolveOrchestratorRoute(directive, preferences, discoveredModels), [directive, preferences, discoveredModels]);
  const hasModel = discoveredModels.some(model => model.available && (!model.suitableRoles.length || model.suitableRoles.some(role => role.toLowerCase() === 'orchestrator')));
  const selectedSpecialists = Object.values(preferences.agentProfileIds).filter(Boolean).length;
  const filter = message.match(/@(\w*)$/)?.[1]?.toLowerCase() || '';
  const commandFilter = message.match(/^\/(\w*)$/)?.[1]?.toLowerCase() || '';
  const queued = queuedTurns.filter(turn => turn.missionId === missionId).length;
  const resize = () => {
    const input = textareaRef.current;
    if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 170)}px`; }
  };
  useEffect(() => { resize(); }, [message, scopeKey]);
  useEffect(() => { setPicker(null); setLocalError(null); setSaveNotice(''); setDelivery('queue'); }, [scopeKey]);
  useEffect(() => {
    if (!composerInput) return;
    setMessage(composerInput); setComposerInput('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [composerInput, setComposerInput, setMessage]);

  const submit = async () => {
    if (locked || !serviceOnline || !hasModel || route.error || (!message.trim() && !attachmentState.files.length)) return;
    setSending(true); setLocalError(null);
    const submittedKey = scopeKey;
    const submittedPreferences = preferences;
    const submittedMessage = message;
    try {
      const uploaded = await attachmentState.upload();
      const liveModels = useAccountStore.getState().discoveredModels;
      const liveRoute = resolveOrchestratorRoute(parseAgentDirective(submittedMessage, liveModels, 'Orchestrator'), submittedPreferences, liveModels);
      if (liveRoute.error) throw new Error(liveRoute.error);
      const options: StartMissionOptions = {
        teamTemplate: preferences.teamTemplate, agentProfileIds: preferences.agentProfileIds,
        trustMode: preferences.trustMode, automationSettings: preferences.automationSettings,
        ...liveRoute.options, ...uploaded,
        // Pure guidance must not create a new turn just because defaults are serialized.
        ...(!busy || delivery !== 'steer' || uploaded.attachmentIds.length ? { workMode: preferences.workMode, teamLaunch: preferences.teamLaunch } : {}),
      };
      const store = useMissionStore.getState();
      if (missionId && busy) await store.sendMissionCommand(missionId, message, delivery, options);
      else if (missionId) await store.continueMission(missionId, message, options);
      else await store.startMission(message, workspaceId || undefined, options);
      const result = useMissionStore.getState();
      if (result.error) throw new Error(result.error);
      const prefStore = useOrchestratorPreferencesStore.getState();
      const destination = missionId || result.activeMissionId;
      const destinationKey = destination ? `conversation:${destination}` : submittedKey;
      if (!missionId && !prefStore.conversations[destinationKey]) prefStore.setConversation(destinationKey, submittedPreferences);
      if (prefStore.drafts[submittedKey] === submittedMessage) prefStore.setDraft(submittedKey, '');
      attachmentState.clearFiles();
      setPicker(null);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Message could not be delivered. Your draft and attachments are retained.');
    } finally { setSending(false); }
  };
  const chooseMention = (role: string) => { setMessage(message.replace(/@\w*$/, `@${role} `)); setPicker(null); textareaRef.current?.focus(); };
  const chooseCommand = (command: string) => { setMessage(message.replace(/^\/\w*$/, `/${command} `)); setPicker(null); textareaRef.current?.focus(); };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const role = AGENT_ROLES.find(value => value.toLowerCase().includes(filter));
    const command = COMMANDS.find(value => value.id.includes(commandFilter));
    if (picker === 'mention' && role) chooseMention(role);
    else if (picker === 'command' && command) chooseCommand(command.id);
    else void submit();
  };
  const visibleError = localError || attachmentState.error || route.error || error;
  return <div className="shrink-0 border-t border-border bg-background">
    <div className="mx-auto max-w-4xl px-4 py-3">
      {busy && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" /><span>Work is in progress. Keep the conversation going.</span>{queued > 0 && <span className="ml-auto">{queued} queued</span>}</div>}
      {(directive.dynamicAgent || directive.teamWideModel) && <div className="mb-2 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /><span>{directive.teamWideModel ? `Worker override: ${directive.modelName || 'selected model'} · coordinator unchanged` : `Delegate to ${directive.targetRole || 'a specialist'}`}</span></div>}
      <div className={cn('relative rounded-xl border bg-card px-3 pb-2 pt-3 transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10', dragging ? 'border-primary bg-primary/5' : 'border-border')} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (!locked) setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (!locked) attachmentState.addFiles(Array.from(event.dataTransfer.files)); }}>
        {dragging && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/95 text-sm font-medium">Drop files into this conversation</div>}
        {picker && <div className="absolute bottom-full left-0 z-20 mb-2 w-[min(300px,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-1 shadow-lg">
          {picker === 'mention' ? AGENT_ROLES.filter(role => role.toLowerCase().includes(filter)).map(role => <button key={role} type="button" onClick={() => chooseMention(role)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-accent"><AtSign className="h-3.5 w-3.5" />{role}</button>) : COMMANDS.filter(command => command.id.includes(commandFilter)).map(command => <button key={command.id} type="button" onClick={() => chooseCommand(command.id)} className="block w-full rounded-md px-3 py-2 text-left hover:bg-accent"><span className="block text-xs font-medium">/{command.id}</span><span className="text-xs text-muted-foreground">{command.label}</span></button>)}
        </div>}
        <OrchestratorAttachmentTray files={attachmentState.files} onRemove={attachmentState.removeFile} />
        <textarea ref={textareaRef} aria-label="Mission message" rows={1} value={message} disabled={locked} placeholder={!workspaceId ? 'Open a project to begin…' : busy ? 'Add a follow-up or guide the current work…' : 'Describe your goal. AtrisAgent will assemble the right team…'} onChange={event => { const value = event.target.value; setMessage(value); setPicker(/@\w*$/.test(value) ? 'mention' : /^\/\w*$/.test(value) ? 'command' : null); setLocalError(null); }} onKeyDown={keyDown} onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length && !locked) { event.preventDefault(); attachmentState.addFiles(files); } }} className="block max-h-[170px] min-h-[48px] w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-60" />
        <input ref={fileRef} type="file" multiple tabIndex={-1} className="hidden" aria-label="Attach files" onChange={event => { attachmentState.addFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <div className="flex items-center gap-0.5"><Button type="button" variant="ghost" size="icon" aria-label="Attach files" className="h-8 w-8 text-muted-foreground" disabled={locked} onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="Target a specialist" className="h-8 w-8 text-muted-foreground" disabled={locked} onClick={() => { setMessage(`${message}${message ? ' ' : ''}@`); setPicker('mention'); textareaRef.current?.focus(); }}><AtSign className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="Mission commands" className="hidden h-8 w-8 text-muted-foreground sm:flex" disabled={locked} onClick={() => { setMessage('/'); setPicker('command'); textareaRef.current?.focus(); }}><Terminal className="h-4 w-4" /></Button></div>
          <div className="flex min-w-0 items-center gap-1"><OrchestratorModelSelector /><Button size="icon" className="h-8 w-8 shrink-0" aria-label={busy ? `Send with ${delivery} delivery` : missionId ? 'Continue conversation' : 'Send mission'} disabled={locked || !serviceOnline || !hasModel || Boolean(route.error) || (!message.trim() && !attachmentState.files.length)} onClick={() => void submit()}>{sending || attachmentState.uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button></div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Team selection" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"><UsersRound className="h-3.5 w-3.5" />Team: {selectedSpecialists ? `${selectedSpecialists} specialists` : 'Auto'}<ChevronDown className="h-3 w-3" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-[min(360px,calc(100vw-2rem))] space-y-3 p-4"><div><h3 className="text-sm font-semibold">Your team</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">The orchestrator chooses the expertise each task needs. Saved specialists and templates are optional.</p></div><div className="flex flex-wrap gap-2"><TeamTemplateSelector /><AgentProfileSelector /></div><label className="block text-xs font-medium">Team launch<select aria-label="Conversation team launch" value={preferences.teamLaunch} onChange={event => updatePreferences({ teamLaunch: event.target.value as 'automatic' | 'confirm' })} className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-xs"><option value="automatic">Choose and launch automatically</option><option value="confirm">Show team plan before launching</option></select></label><Button variant="outline" size="sm" className="w-full" onClick={() => useSettingsStore.getState().setActiveView('agents')}>Manage teams &amp; specialists</Button></DropdownMenuContent></DropdownMenu>
          <Button variant="ghost" size="sm" aria-label="Conversation settings" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={() => { setSaveNotice(''); setSettingsOpen(true); }}><Settings2 className="h-3.5 w-3.5" />Work settings</Button>
          <span className="px-1 text-[11px] text-muted-foreground">{MODE_LABELS[preferences.workMode]}{preferences.teamLaunch === 'confirm' ? ' · team approval' : ''}{preferences.modelScope === 'all' ? ' · model for everyone' : ''}</span>
        </div>
        {busy ? <select aria-label="Message delivery" className="h-7 max-w-full rounded-md border border-input bg-background px-2 text-xs" value={delivery} onChange={event => setDelivery(event.target.value as TurnDelivery)}><option value="queue">Queue for next turn</option><option value="steer">Guide current work</option><option value="stop_and_replan">Stop and replan</option></select> : <span className="hidden text-[11px] text-muted-foreground sm:inline">Enter to send · Shift+Enter for a new line</span>}
      </div>
      {visibleError && <p role="alert" className="mt-2 break-words text-xs text-destructive">{visibleError}</p>}
      {(!serviceOnline || !hasModel) && <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{!serviceOnline ? 'Connecting to the local service…' : 'Connect a compatible model to start.'}</span><Button variant="link" size="sm" className="h-6 text-xs" onClick={() => useSettingsStore.getState().setActiveView('accounts')}>Connections</Button></div>}
      {busy && delivery === 'steer' && <p className="mt-1 text-[11px] text-muted-foreground">Guidance reaches the next safe boundary. Attachments start a new turn; other settings apply to queued work.</p>}
      {pendingMissionStart && <p role="status" className="mt-2 text-xs text-muted-foreground">Checking durable start acceptance before another request can be sent…</p>}
    </div>
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>Conversation settings</DialogTitle><DialogDescription>These choices apply to this conversation and its next turns. Active workers keep their current settings.</DialogDescription></DialogHeader><OrchestratorPreferenceFields value={preferences} onChange={updatePreferences} /><div className="flex flex-wrap gap-2 border-t border-border pt-4"><Button variant="outline" size="sm" disabled={!workspaceId} onClick={() => { useOrchestratorPreferencesStore.getState().saveDefaults(preferences, workspaceId || undefined); setSaveNotice('Saved as this project’s defaults.'); }}>Save as project defaults</Button><Button variant="ghost" size="sm" onClick={() => { useOrchestratorPreferencesStore.getState().saveDefaults(preferences); setSaveNotice('Saved as application defaults.'); }}>Save as application defaults</Button>{customized && <Button variant="ghost" size="sm" onClick={() => { useOrchestratorPreferencesStore.getState().resetConversation(scopeKey); setSaveNotice('Using inherited defaults.'); }}>Reset to defaults</Button>}</div>{saveNotice && <p role="status" className="text-xs text-muted-foreground">{saveNotice}</p>}</DialogContent></Dialog>
  </div>;
}
