import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Clock3, Send, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RuntimeBrandIcon } from '@/components/runtime/runtime-brand-icon';
import { parseAgentDirective } from '@/lib/agent-directive';
import { useAccountStore } from '@/stores/account-store';
import { useMissionStore, type StartMissionOptions } from '@/stores/mission-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { ChatComposer as StandardChatComposer } from './chat-composer-base';

function QueuedTurnComposer() {
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const queueMissionTurn = useMissionStore((state) => state.queueMissionTurn);
  const queuedTurns = useMissionStore((state) => state.queuedTurns);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const discoveredModels = useAccountStore((state) => state.discoveredModels);
  const serviceOnline = useAccountStore((state) => state.serviceOnline);
  const { selectedModel, reasoningLevel, trustMode, teamTemplate, setActiveView } = useSettingsStore();

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
  const queuedCount = useMemo(
    () => activeMissionId ? queuedTurns.filter((turn) => turn.missionId === activeMissionId).length : 0,
    [activeMissionId, queuedTurns],
  );

  const resizeInput = () => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 170)}px`;
  };

  const submit = () => {
    const prompt = message.trim();
    if (!prompt || !activeMissionId || !activeWorkspaceId) return;
    if (!serviceOnline) {
      setActiveView('accounts');
      return;
    }

    const targetRole = directive.targetRole || 'Orchestrator';
    const selectedRouteApplies = !directive.targetRole || directive.targetRole.toLowerCase() === 'orchestrator';
    const scopedSelectedModel = selectedRouteApplies ? selectedModel || undefined : undefined;
    const resolvedModel = directive.modelCatalogId || scopedSelectedModel;
    const resolvedReasoning = directive.reasoningLevel
      || (directive.modelCatalogId
        ? directiveModel?.defaultReasoning || directiveModel?.supportedReasoning[0]
        : scopedSelectedModel ? reasoningLevel : undefined);
    const options: StartMissionOptions = {
      model: resolvedModel,
      reasoningLevel: resolvedReasoning,
      teamTemplate,
      trustMode,
      targetRole: directive.targetRole,
      routeRole: targetRole,
      command: directive.command,
    };

    queueMissionTurn(activeMissionId, prompt, options);
    setMessage('');
    requestAnimationFrame(resizeInput);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto max-w-4xl px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/[0.035] px-3 py-2 text-[10px]">
          <div className="flex min-w-0 items-center gap-2">
            <Clock3 className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="font-medium text-foreground">Current turn is still running</span>
            <span className="truncate text-muted-foreground">Your next message will start automatically after the active agents finish.</span>
          </div>
          {queuedCount > 0 ? <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-[9px] text-muted-foreground">{queuedCount} queued</span> : null}
        </div>

        <div className="relative rounded-xl border border-border/70 bg-card/70 px-3 pb-2 pt-3 shadow-sm transition-all focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(event) => { setMessage(event.target.value); resizeInput(); }}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="Send another message — it will be queued as the next turn…"
            disabled={!activeWorkspaceId}
            className="block max-h-[170px] min-h-[42px] w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/75 disabled:cursor-not-allowed disabled:opacity-60"
          />

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
            <div className="flex min-w-0 items-center gap-1.5 text-[9px] text-muted-foreground">
              {selectedModelObject ? <RuntimeBrandIcon runtimeId={selectedModelObject.runtimeType} className="h-3 w-3 shrink-0" /> : <Sparkles className="h-3 w-3 shrink-0 text-primary" />}
              <span className="truncate">Next turn route: {selectedModelObject?.name || 'Auto routing'}</span>
              {reasoningLevel && reasoningLevel !== 'none' && selectedModelObject?.supportedReasoning.length ? <span className="shrink-0">· {reasoningLevel}</span> : null}
            </div>
            <Button
              size="icon"
              className="h-8 w-8 rounded-lg"
              disabled={!message.trim() || !serviceOnline || !activeWorkspaceId}
              onClick={submit}
              aria-label="Queue next conversation turn"
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-between px-1 text-[9px] text-muted-foreground/70">
          <span>Enter to queue · Shift+Enter for a new line · queued turns run FIFO</span>
          {message.length > 0 ? <span>~{Math.ceil(message.length / 4)} tokens</span> : null}
        </div>
      </div>
    </div>
  );
}

export function ChatComposer() {
  const activeMissionId = useMissionStore((state) => state.activeMissionId);
  const missions = useMissionStore((state) => state.missions);
  const drainQueuedTurn = useMissionStore((state) => state.drainQueuedTurn);
  const queuedTurns = useMissionStore((state) => state.queuedTurns);
  const activeMission = useMemo(
    () => missions.find((mission) => mission.id === activeMissionId),
    [activeMissionId, missions],
  );
  const busy = Boolean(activeMission && !['completed', 'failed', 'cancelled'].includes(activeMission.status));
  const queuedCount = useMemo(
    () => activeMissionId ? queuedTurns.filter((turn) => turn.missionId === activeMissionId).length : 0,
    [activeMissionId, queuedTurns],
  );

  useEffect(() => {
    if (!busy && activeMissionId && queuedCount > 0) void drainQueuedTurn(activeMissionId);
  }, [activeMissionId, busy, drainQueuedTurn, queuedCount]);

  return busy ? <QueuedTurnComposer /> : <StandardChatComposer />;
}
