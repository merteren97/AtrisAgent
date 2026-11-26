import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  AtSign,
  Clock3,
  FileText,
  Loader2,
  Paperclip,
  Send,
  Settings2,
  Sparkles,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { OrchestratorModelSelector } from '@/components/orchestrator/orchestrator-model-selector';
import { OrchestratorPreferenceFields } from '@/components/orchestrator/orchestrator-defaults';
import { TierRoutingPopover } from '@/components/orchestrator/tier-routing-popover';
import { useOrchestratorAttachments, canPreviewAttachment } from '@/stores/orchestrator-attachments-store';
import { useOrchestratorPreferences, useOrchestratorPreferencesStore } from '@/stores/orchestrator-preferences-store';
import { useMissionStore, type StartMissionOptions, type TurnDelivery } from '@/stores/mission-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore } from '@/stores/account-store';
import { AGENT_ROLES, parseAgentDirective } from '@/lib/agent-directive';
import { resolveOrchestratorRoute } from '@/lib/orchestrator-route';
import { cn } from '@/lib/utils';
import { IntegrationMentionOptions, matchingIntegrationMentions, useConnectedIntegrationMentions } from '@/components/integrations/integration-mentions';
import { MentionTextarea } from '@/components/integrations/mention-textarea';
import { extractClipboardFiles } from '@/lib/clipboard-files';
import { ComposerResizeHandle } from '@/components/shared/ComposerResizeHandle';
import { ImageLightbox } from '@/components/shared/ImageLightbox';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const COMMANDS = [
  { id: 'plan', label: 'Plan without launching workers' },
  { id: 'agent', label: 'Delegate a focused task' },
  { id: 'review', label: 'Request a focused review' },
  { id: 'summarize', label: 'Summarize the current work' },
];
const MODE_LABELS = {
  auto: 'Auto',
  research: 'Research · read-only',
  plan: 'Plan · no execution',
  execute: 'Execute & verify',
};

function ComposerAttachmentChip({
  file,
  onOpen,
  onRemove,
}: {
  file: File;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string>();
  const isImage = canPreviewAttachment(file);

  useEffect(() => {
    if (!isImage) {
      setUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, isImage]);

  return (
    <div
      className={cn(
        'group relative flex h-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/40',
        isImage ? 'w-16' : 'w-28',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Preview ${file.name}`}
        title={file.name}
        className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {isImage && url ? (
          <img src={url} alt={file.name} className="h-full w-full object-cover transition-transform group-hover:scale-105" />
        ) : (
          <>
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="w-full truncate text-[10px] text-muted-foreground">{file.name}</span>
          </>
        )}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-foreground shadow-sm hover:bg-destructive hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// A single mounted composer preserves drafts, attachments and controls throughout a turn.
export function ChatComposer() {
  const { preferences, updatePreferences, scopeKey, workspaceId, missionId, draft: message, setDraft: setMessage, customized } = useOrchestratorPreferences();
  const attachmentState = useOrchestratorAttachments(scopeKey, workspaceId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [height, setHeight] = useState(72);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveNotice, setSaveNotice] = useState('');
  const [delivery, setDelivery] = useState<TurnDelivery>('queue');
  const [deliveryFeedback, setDeliveryFeedback] = useState<{ effective: string; reason?: string } | null>(null);
  const [picker, setPicker] = useState<'mention' | 'command' | null>(null);
  const integrations = useConnectedIntegrationMentions(picker === 'mention');
  const [integrationNotice, setIntegrationNotice] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const { missions, loading, pendingMissionStart, composerInput, setComposerInput, queuedTurns, error } = useMissionStore();
  const { discoveredModels, runtimes, serviceOnline } = useAccountStore();

  const mission = missions.find((item) => item.id === missionId);
  const busy = Boolean(mission && !TERMINAL.has(mission.status));
  const locked = sending || attachmentState.uploading || loading || Boolean(pendingMissionStart) || !workspaceId;
  const directive = useMemo(() => parseAgentDirective(message, discoveredModels, 'Orchestrator'), [message, discoveredModels]);
  const route = useMemo(() => resolveOrchestratorRoute(directive, preferences, discoveredModels), [directive, preferences, discoveredModels]);
  const hasModel = discoveredModels.some(
    (model) => model.available && (!model.suitableRoles.length || model.suitableRoles.some((role) => role.toLowerCase() === 'orchestrator')),
  );
  const filter = message.match(/@([\w-]*)$/)?.[1]?.toLowerCase() || '';
  const commandFilter = message.match(/^\/(\w*)$/)?.[1]?.toLowerCase() || '';
  const queued = queuedTurns.filter((turn) => turn.missionId === missionId).length;

  // Determine live-steer capability for the active coordinator model/runtime
  const activeCoordinatorModel = discoveredModels.find((m) => m.catalogId === preferences.selectedModel)
    || discoveredModels.find((m) => m.available && (!m.suitableRoles.length || m.suitableRoles.some((r) => r.toLowerCase() === 'orchestrator')));
  const activeRuntimeStatus = activeCoordinatorModel
    ? runtimes.find((r) => r.runtimeType === activeCoordinatorModel.runtimeType)
    : undefined;
  const supportsLiveSteer = activeRuntimeStatus?.adapterCapabilities?.liveSteer ?? true;

  const steerDowngradePreview = useMemo(() => {
    if (!busy || delivery !== 'steer') return null;
    if (attachmentState.files.length > 0) {
      return 'Attachments start a new queued turn rather than steering mid-turn.';
    }
    if (directive.modelCatalogId || directive.targetRole) {
      return 'Route or model overrides queue as a new turn.';
    }
    if (!supportsLiveSteer) {
      return `${activeRuntimeStatus?.name || 'Active CLI'} queues mid-turn guidance until the next turn.`;
    }
    return null;
  }, [busy, delivery, attachmentState.files.length, directive.modelCatalogId, directive.targetRole, supportsLiveSteer, activeRuntimeStatus?.name]);

  useEffect(() => {
    setPicker(null);
    setLocalError(null);
    setSaveNotice('');
    setDelivery('queue');
    setDeliveryFeedback(null);
    setIntegrationNotice(false);
  }, [scopeKey]);

  useEffect(() => {
    if (!composerInput) return;
    setMessage(composerInput);
    setComposerInput('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [composerInput, setComposerInput, setMessage]);

  const submit = async () => {
    if (locked || !serviceOnline || !hasModel || route.error || (!message.trim() && !attachmentState.files.length)) return;
    setSending(true);
    setLocalError(null);
    setDeliveryFeedback(null);
    const submittedKey = scopeKey;
    const submittedMissionId = missionId;
    const submittedWorkspaceId = workspaceId;
    const submittedDelivery = delivery;
    const submittedBusy = busy;
    const submittedPreferences = preferences;
    const submittedMessage = message;
    const expectedDowngrade = steerDowngradePreview;

    try {
      const uploaded = await attachmentState.upload();
      const liveModels = useAccountStore.getState().discoveredModels;
      const liveRoute = resolveOrchestratorRoute(
        parseAgentDirective(submittedMessage, liveModels, 'Orchestrator'),
        submittedPreferences,
        liveModels,
      );
      if (liveRoute.error) throw new Error(liveRoute.error);

      const options: StartMissionOptions = {
        teamTemplate: submittedPreferences.teamTemplate,
        agentProfileIds: submittedPreferences.agentProfileIds,
        trustMode: submittedPreferences.trustMode,
        automationSettings: submittedPreferences.automationSettings,
        ...liveRoute.options,
        ...uploaded,
        ...(!submittedBusy || submittedDelivery !== 'steer' || uploaded.attachmentIds.length
          ? { workMode: submittedPreferences.workMode, teamLaunch: submittedPreferences.teamLaunch }
          : {}),
      };

      const store = useMissionStore.getState();
      if (submittedMissionId && submittedBusy) {
        await store.sendMissionCommand(submittedMissionId, submittedMessage, submittedDelivery, options);
        if (submittedDelivery === 'steer' && expectedDowngrade) {
          setDeliveryFeedback({ effective: 'queue', reason: expectedDowngrade });
        } else if (submittedDelivery === 'steer') {
          setDeliveryFeedback({ effective: 'steer' });
        }
      } else if (submittedMissionId) {
        await store.continueMission(submittedMissionId, submittedMessage, options);
      } else {
        await store.startMission(submittedMessage, submittedWorkspaceId || undefined, options);
      }

      const result = useMissionStore.getState();
      if (result.error) throw new Error(result.error);

      const prefStore = useOrchestratorPreferencesStore.getState();
      const destination = submittedMissionId || result.activeMissionId;
      const destinationKey = destination ? `conversation:${destination}` : submittedKey;
      if (!submittedMissionId && !prefStore.conversations[destinationKey]) {
        prefStore.setConversation(destinationKey, submittedPreferences);
      }
      if (prefStore.drafts[submittedKey] === submittedMessage) {
        prefStore.setDraft(submittedKey, '');
      }
      const activeScopeKey = result.activeMissionId ? `conversation:${result.activeMissionId}` : submittedKey;
      if (activeScopeKey === submittedKey || (!submittedMissionId && activeScopeKey === destinationKey)) {
        attachmentState.clearFiles();
      }
      setPicker(null);
      setIntegrationNotice(false);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Message could not be delivered. Your draft and attachments are retained.');
    } finally {
      setSending(false);
    }
  };

  const chooseMention = (role: string) => {
    setMessage(message.replace(/@[\w-]*$/, `@${role} `));
    setPicker(null);
    textareaRef.current?.focus();
  };
  const chooseIntegration = (mention: string) => {
    chooseMention(mention);
    setIntegrationNotice(mention !== 'github');
  };
  const chooseCommand = (command: string) => {
    setMessage(message.replace(/^\/\w*$/, `/${command} `));
    setPicker(null);
    textareaRef.current?.focus();
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && picker) {
      setPicker(null);
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.nativeEvent.isComposing && picker === 'mention') {
      const role = AGENT_ROLES.find((value) => value.toLowerCase().includes(filter));
      const integration = matchingIntegrationMentions(integrations.items, filter)[0];
      if (role || integration) {
        event.preventDefault();
        if (role) chooseMention(role);
        else if (integration) chooseIntegration(integration.mention);
      }
      return;
    }
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const role = AGENT_ROLES.find((value) => value.toLowerCase().includes(filter));
    const command = COMMANDS.find((value) => value.id.includes(commandFilter));
    if (picker === 'mention' && role) chooseMention(role);
    else if (picker === 'mention') {
      const match = matchingIntegrationMentions(integrations.items, filter)[0];
      if (match) chooseIntegration(match.mention);
    } else if (picker === 'command' && command) {
      chooseCommand(command.id);
    } else {
      void submit();
    }
  };

  const visibleError = localError || attachmentState.error || route.error || error;

  return (
    <div className="shrink-0 border-t border-border bg-background">
      <div className="mx-auto max-w-4xl px-4 py-3">
        {busy && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Clock3 className="h-3.5 w-3.5" />
            <span>Work is in progress. Keep the conversation going.</span>
            {queued > 0 && <span className="ml-auto">{queued} queued</span>}
          </div>
        )}
        {(directive.dynamicAgent || directive.teamWideModel) && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              {directive.teamWideModel
                ? `Worker override: ${directive.modelName || 'selected model'} · coordinator unchanged`
                : `Delegate to ${directive.targetRole || 'a specialist'}`}
            </span>
          </div>
        )}
        <div
          className={cn(
            'relative rounded-2xl border bg-card px-3 pb-2 pt-3 shadow-sm transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/15',
            dragging ? 'border-primary bg-primary/5' : 'border-input',
          )}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              if (!locked) setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!locked) attachmentState.addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/95 text-sm font-medium">
              Drop files into this conversation
            </div>
          )}
          {picker && (
            <div className="absolute bottom-full left-0 z-20 mb-2 w-[min(300px,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-1 shadow-lg">
              {picker === 'mention' ? (
                <>
                  {AGENT_ROLES.filter((role) => role.toLowerCase().includes(filter)).map((role, index) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => chooseMention(role)}
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-accent ${index === 0 ? 'bg-accent' : ''}`}
                    >
                      <AtSign className="h-3.5 w-3.5" />
                      {role}
                      {index === 0 && <kbd className="ml-auto rounded border border-border px-1 text-[10px] text-muted-foreground">Tab</kbd>}
                    </button>
                  ))}
                  <IntegrationMentionOptions
                    {...integrations}
                    query={filter}
                    onSelect={chooseIntegration}
                    first={!AGENT_ROLES.some((role) => role.toLowerCase().includes(filter))}
                  />
                </>
              ) : (
                COMMANDS.filter((command) => command.id.includes(commandFilter)).map((command) => (
                  <button
                    key={command.id}
                    type="button"
                    onClick={() => chooseCommand(command.id)}
                    className="block w-full rounded-md px-3 py-2 text-left hover:bg-accent"
                  >
                    <span className="block text-xs font-medium">/{command.id}</span>
                    <span className="text-xs text-muted-foreground">{command.label}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {attachmentState.files.length > 0 && (
            <div aria-label="Attached files" className="mb-2 flex gap-2 overflow-x-auto border-b border-border/60 pb-3">
              {attachmentState.files.map((file, index) => (
                <ComposerAttachmentChip
                  key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                  file={file}
                  onOpen={() => setPreviewFile(file)}
                  onRemove={() => {
                    if (previewFile === file) setPreviewFile(null);
                    attachmentState.removeFile(index);
                  }}
                />
              ))}
            </div>
          )}

          <MentionTextarea
            ref={textareaRef}
            aria-label="Mission message"
            value={message}
            disabled={locked}
            placeholder={
              !workspaceId
                ? 'Open a project to begin…'
                : busy
                  ? 'Add a follow-up or guide the current work…'
                  : 'Describe your goal. AtrisAgent will assemble the right team…'
            }
            onChange={(event) => {
              const value = event.target.value;
              setMessage(value);
              setPicker(/(?:^|\s)@([\w-]*)$/.test(value) ? 'mention' : /^\/\w*$/.test(value) ? 'command' : null);
              setLocalError(null);
            }}
            onKeyDown={keyDown}
            onPaste={(event) => {
              const files = extractClipboardFiles(event.clipboardData);
              if (files.length && !locked) {
                event.preventDefault();
                attachmentState.addFiles(files);
              }
            }}
            style={{ height }}
            className="block w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />

          <ComposerResizeHandle height={height} onHeightChange={setHeight} />

          <input
            ref={fileRef}
            type="file"
            multiple
            tabIndex={-1}
            className="hidden"
            aria-label="Attach files"
            onChange={(event) => {
              attachmentState.addFiles(Array.from(event.target.files || []));
              event.target.value = '';
            }}
          />

          <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/70 pt-2">
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Attach files"
                className="h-8 w-8 text-muted-foreground"
                disabled={locked}
                onClick={() => fileRef.current?.click()}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Target a specialist"
                className="h-8 w-8 text-muted-foreground"
                disabled={locked}
                onClick={() => {
                  setMessage(`${message}${message ? ' ' : ''}@`);
                  setPicker('mention');
                  textareaRef.current?.focus();
                }}
              >
                <AtSign className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Mission commands"
                className="hidden h-8 w-8 text-muted-foreground sm:flex"
                disabled={locked}
                onClick={() => {
                  setMessage('/');
                  setPicker('command');
                  textareaRef.current?.focus();
                }}
              >
                <Terminal className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <OrchestratorModelSelector />
              <Button
                type="button"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={busy ? `Send with ${delivery} delivery` : missionId ? 'Continue conversation' : 'Send mission'}
                disabled={locked || !serviceOnline || !hasModel || Boolean(route.error) || (!message.trim() && !attachmentState.files.length)}
                onClick={() => void submit()}
              >
                {sending || attachmentState.uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <TierRoutingPopover />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Conversation settings"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => {
                setSaveNotice('');
                setSettingsOpen(true);
              }}
            >
              <Settings2 className="h-3.5 w-3.5" />
              Work settings
            </Button>
            <span className="px-1 text-[11px] text-muted-foreground">
              {MODE_LABELS[preferences.workMode]}
              {preferences.teamLaunch === 'confirm' ? ' · team approval' : ''}
              {preferences.modelScope === 'all' ? ' · model for everyone' : ''}
            </span>
          </div>
          {busy ? (
            <div className="flex items-center gap-1.5">
              {delivery === 'steer' && supportsLiveSteer && !steerDowngradePreview && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                  <Zap className="h-2.5 w-2.5" />Live Steer
                </span>
              )}
              <select
                aria-label="Message delivery"
                className="h-7 max-w-full rounded-md border border-input bg-background px-2 text-xs"
                value={delivery}
                onChange={(event) => setDelivery(event.target.value as TurnDelivery)}
              >
                <option value="queue">Queue for next turn</option>
                <option value="steer">Guide current work (Steer)</option>
                <option value="stop_and_replan">Stop and replan</option>
              </select>
            </div>
          ) : (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              Enter to send · Shift+Enter for a new line · Drag handle to resize
            </span>
          )}
        </div>

        {visibleError && <p role="alert" className="mt-2 break-words text-xs text-destructive">{visibleError}</p>}
        {integrationNotice && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            Integration tool access is not yet available in chat; the mention is text only.
          </p>
        )}
        {(!serviceOnline || !hasModel) && (
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{!serviceOnline ? 'Connecting to the local service…' : 'Connect a compatible model to start.'}</span>
            <Button variant="link" size="sm" className="h-6 text-xs" onClick={() => useSettingsStore.getState().setActiveView('accounts')}>
              Connections
            </Button>
          </div>
        )}
        {busy && delivery === 'steer' && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {steerDowngradePreview ? (
              <>
                <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
                <span>{steerDowngradePreview}</span>
              </>
            ) : (
              <span>Guidance reaches the next safe boundary. Attachments start a new turn; other settings apply to queued work.</span>
            )}
          </p>
        )}
        {deliveryFeedback?.reason && (
          <div role="status" className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Delivered as <strong>queued</strong>: {deliveryFeedback.reason}</span>
            </span>
            <button type="button" onClick={() => setDeliveryFeedback(null)} className="text-amber-800/80 hover:text-amber-950 dark:text-amber-300/80 dark:hover:text-amber-200" aria-label="Dismiss delivery notice">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {pendingMissionStart && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            Checking durable start acceptance before another request can be sent…
          </p>
        )}
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Conversation settings</DialogTitle>
            <DialogDescription>
              These choices apply to this conversation and its next turns. Active workers keep their current settings.
            </DialogDescription>
          </DialogHeader>
          <OrchestratorPreferenceFields value={preferences} onChange={updatePreferences} />
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={!workspaceId}
              onClick={() => {
                useOrchestratorPreferencesStore.getState().saveDefaults(preferences, workspaceId || undefined);
                setSaveNotice('Saved as this project’s defaults.');
              }}
            >
              Save as project defaults
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                useOrchestratorPreferencesStore.getState().saveDefaults(preferences);
                setSaveNotice('Saved as application defaults.');
              }}
            >
              Save as application defaults
            </Button>
            {customized && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  useOrchestratorPreferencesStore.getState().resetConversation(scopeKey);
                  setSaveNotice('Using inherited defaults.');
                }}
              >
                Reset to defaults
              </Button>
            )}
          </div>
          {saveNotice && <p role="status" className="text-xs text-muted-foreground">{saveNotice}</p>}
        </DialogContent>
      </Dialog>

      {previewFile && <ImageLightbox file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  );
}
