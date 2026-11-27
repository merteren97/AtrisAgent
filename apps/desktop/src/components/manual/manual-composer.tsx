import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Brain, FileText, ImagePlus, Loader2, Send, Shield, ShieldCheck, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatSessionControls, type ChatControlAgent } from './chat-session-controls';
import type { DiscoveredModel } from '@/stores/account-store';
import type { ReactNode } from 'react';
import { IntegrationMentionOptions, matchingIntegrationMentions, useConnectedIntegrationMentions } from '@/components/integrations/integration-mentions';
import { MentionTextarea } from '@/components/integrations/mention-textarea';
import { extractClipboardFiles } from '@/lib/clipboard-files';
import { ComposerResizeHandle } from '@/components/shared/ComposerResizeHandle';
import { ImageLightbox } from '@/components/shared/ImageLightbox';

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const MAX_TOTAL_SIZE = 25 * 1024 * 1024;
export interface OpenCodeAutoApprove { available: boolean; enabled: boolean; error?: string }

export function addManualFiles(current: File[], incoming: File[]): File[] {
  const next = [...current];
  for (const file of incoming) {
    if (next.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue;
    if (next.length >= MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files at a time.`);
    if (!file.size) throw new Error(`${file.name} is empty.`);
    if (file.size > MAX_ATTACHMENT_SIZE) throw new Error(`${file.name} exceeds the 10 MB per-file limit.`);
    if (next.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_TOTAL_SIZE) throw new Error('Attachments exceed the 25 MB total limit.');
    next.push(file);
  }
  return next;
}

function FilePreview({ file, onOpen, onRemove }: { file: File; onOpen: () => void; onRemove: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return <div className={`group relative flex h-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/40 ${file.type.startsWith('image/') ? 'w-16' : 'w-28'}`}>
    <button type="button" onClick={onOpen} aria-label={`Preview ${file.name}`} title={file.name} className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      {url ? <img src={url} alt={file.name} className="h-full w-full object-cover transition-transform group-hover:scale-105" /> : <><FileText className="h-5 w-5 shrink-0 text-muted-foreground" /><span className="w-full truncate text-[10px] text-muted-foreground">{file.name}</span></>}
    </button>
    <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`} className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-foreground shadow-sm hover:bg-destructive hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="h-3.5 w-3.5" /></button>
  </div>;
}

export function ManualComposer({ agent, agents, live, native, pending, draft, files, autoApprove, routeStatus, permissionControl, setupPending, onOpenCode, onAutoApprove, onDraft, onAddFiles, onRemoveFile, onSend, onMemory, onApply, surface = 'manual', sendDisabled = false, statusText, busy = false, canUrgentSteer = false, onUrgentSteer }: {
  agent: ChatControlAgent & { name: string }; agents: readonly unknown[]; live: boolean; native: boolean; pending: boolean;
  autoApprove?: OpenCodeAutoApprove; onAutoApprove?: (enabled: boolean) => Promise<void>;
  routeStatus?: {pending: boolean; error?: string};
  permissionControl?: ReactNode; setupPending?: boolean; onOpenCode?: () => void;
  draft: string; files: File[]; onDraft: (value: string) => void; onAddFiles: (files: File[]) => void; onRemoveFile: (file: File) => void;
  onSend: () => void; onMemory?: () => void; onApply: (model: DiscoveredModel, independent: boolean, reasoning?: string) => Promise<boolean>;
  surface?: 'manual' | 'planning'; sendDisabled?: boolean; statusText?: string;
  busy?: boolean; canUrgentSteer?: boolean; onUrgentSteer?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [height, setHeight] = useState(72);
  const [preview, setPreview] = useState<File | null>(null);
  const [requestedMode, setRequestedMode] = useState<boolean | null>(null);
  const [modeError, setModeError] = useState<string>();
  const [mentionOpen, setMentionOpen] = useState(false);
  const integrations = useConnectedIntegrationMentions(mentionOpen);
  const [integrationNotice, setIntegrationNotice] = useState(false);
  const mentionQuery = draft.match(/(?:^|\s)@([\w-]*)$/)?.[1] || '';
  const chooseIntegration = (mention:string) => { onDraft(draft.replace(/@[\w-]*$/, `@${mention} `)); setMentionOpen(false); setIntegrationNotice(mention !== 'github'); textarea.current?.focus(); };
  const canSend = native && live && !pending && !sendDisabled && !setupPending && (draft.trim().length > 0 || files.length > 0);
  useEffect(() => {
    if (requestedMode === null) return;
    if (autoApprove?.enabled === requestedMode) setRequestedMode(null);
  }, [autoApprove?.enabled, requestedMode]);
  useEffect(() => {
    if (requestedMode === null) return;
    const timeout = setTimeout(() => { setRequestedMode(null); setModeError('OpenCode did not confirm the permission mode change.'); }, 5000);
    return () => clearTimeout(timeout);
  }, [requestedMode]);
  const toggleAutoApprove = () => {
    if (!onAutoApprove || !autoApprove?.available || requestedMode !== null) return;
    const next = !autoApprove.enabled;
    setModeError(undefined); setRequestedMode(next);
    void onAutoApprove(next).catch(error => { setRequestedMode(null); setModeError(error instanceof Error ? error.message : String(error)); });
  };
  return <form aria-label={surface === 'manual' ? 'Manual message composer' : 'Planning message composer'} className={`shrink-0 px-4 pb-3 pt-2 ${surface === 'planning' ? 'flex min-h-0 max-h-[70%] flex-col' : ''}`} onSubmit={event => { event.preventDefault(); if (canSend) onSend(); }}>
    <div className={`relative mx-auto w-full max-w-3xl rounded-2xl border border-input bg-card p-3 shadow-sm transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/15 ${surface === 'planning' ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
      {mentionOpen && <div className="absolute bottom-full left-0 z-20 mb-2 w-[min(300px,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-1 shadow-lg"><IntegrationMentionOptions {...integrations} query={mentionQuery} onSelect={chooseIntegration} /></div>}
      <div className={surface === 'planning' ? 'min-h-0 flex-1 overflow-y-auto' : 'contents'}>
      {files.length > 0 && <div aria-label="Attached files" className="mb-2 flex gap-2 overflow-x-auto border-b border-border/60 pb-3">
        {files.map((file, index) => <FilePreview key={`${file.name}-${file.lastModified}-${index}`} file={file} onOpen={() => setPreview(file)} onRemove={() => { if (preview === file) setPreview(null); onRemoveFile(file); }} />)}
      </div>}
      <MentionTextarea ref={textarea} aria-label={`Message ${agent.name}`} onPaste={event => { const pastedFiles = extractClipboardFiles(event.clipboardData); if (pastedFiles.length) { event.preventDefault(); onAddFiles(pastedFiles); } }} value={draft} onChange={event => { const value = event.target.value; onDraft(value); setMentionOpen(/(?:^|\s)@([\w-]*)$/.test(value)); if (!value) setIntegrationNotice(false); }} onKeyDown={event => { if (event.key === 'Escape' && mentionOpen) { event.preventDefault(); event.stopPropagation(); setMentionOpen(false); return; } if (event.nativeEvent.isComposing) return; if (event.key === 'Tab' && !event.shiftKey && mentionOpen) { const match = matchingIntegrationMentions(integrations.items, mentionQuery)[0]; if (match) { event.preventDefault(); chooseIntegration(match.mention); } return; } if (event.key === 'Enter' && event.altKey && !event.shiftKey) { if (surface === 'manual' && canSend && busy && canUrgentSteer && onUrgentSteer) { event.preventDefault(); onUrgentSteer(); } return; } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (mentionOpen) { const match = matchingIntegrationMentions(integrations.items, mentionQuery)[0]; if (match) { chooseIntegration(match.mention); return; } setMentionOpen(false); } if (canSend) onSend(); } }} placeholder={live ? 'Message this agent…' : 'Open the agent to continue…'} maxLength={32000} style={{ height }} className="block w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground" />
      </div>
      <ComposerResizeHandle height={height} onHeightChange={setHeight} />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2"><ChatSessionControls key={agent.id} agent={agent} agents={agents} pending={pending || !native} onApply={onApply}/><div className="ml-auto flex items-center gap-1">
        <input ref={input} type="file" multiple className="sr-only" aria-label="Choose files to attach" onChange={(event: ChangeEvent<HTMLInputElement>) => { onAddFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
        <Button type="button" variant="ghost" size="icon" aria-label="Attach files or images" title="Attach files or images" onClick={() => input.current?.click()}><ImagePlus className="h-4 w-4" /></Button>
        {agent.runtimeType === 'opencode' && <Button type="button" variant={autoApprove?.enabled ? 'secondary' : 'ghost'} size="icon" aria-label={autoApprove?.enabled ? 'Disable OpenCode auto-approve' : 'Enable OpenCode auto-approve'} aria-pressed={Boolean(autoApprove?.enabled)} title={autoApprove?.enabled ? 'Auto-approve on · click to turn off' : 'Auto-approve future permissions · explicit deny rules still apply'} disabled={!native || !live || pending || !autoApprove?.available || requestedMode !== null} onClick={toggleAutoApprove}>{requestedMode !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : autoApprove?.enabled ? <ShieldCheck className="h-4 w-4 text-primary" /> : <Shield className="h-4 w-4" />}</Button>}
        {permissionControl}
         {onMemory && <Button type="button" variant="ghost" size="icon" aria-label="Open memory and references" onClick={onMemory}><Brain className="h-4 w-4" /></Button>}
         {surface === 'manual' && busy && canUrgentSteer && onUrgentSteer && (
           <Button type="button" size="sm" variant="secondary" disabled={!canSend} title="Send immediately into current turn (Alt+Enter)" onClick={onUrgentSteer}>
             <Zap className="h-4 w-4" />
             <span className="ml-1.5">Steer</span>
           </Button>
         )}
         <Button type="submit" size="sm" disabled={!canSend} title={surface === 'manual' && busy ? 'Add to queue' : 'Send'}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}<span className="ml-2">{surface === 'manual' && busy ? 'Queue' : 'Send'}</span></Button>
      </div></div>
    </div>
    {setupPending && <p role="status" className="mx-auto mt-2 max-w-3xl px-2 text-xs text-muted-foreground">Codex is starting. Your draft is kept until the CLI is ready. <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={onOpenCode}>View CLI setup</button></p>}
    {integrationNotice && draft && <p role="status" className="mx-auto mt-2 max-w-3xl px-2 text-xs text-muted-foreground">Integration tool access is not yet available in chat; the mention is text only.</p>}
    <p className="mx-auto mt-2 max-w-3xl px-2 text-[10px] text-muted-foreground">{agent.name} · {statusText || (live ? 'CLI open' : 'Offline')}{agent.runtimeType === 'opencode' && autoApprove?.enabled ? ' · Auto-approve on' : ''} · Shift+Enter for a new line · Drag the handle to resize</p>
    {requestedMode === null && (modeError || autoApprove?.error) && <p role="alert" className="mx-auto max-w-3xl px-2 text-xs text-destructive">{modeError || autoApprove?.error}</p>}
    {live && routeStatus?.error && <p role="alert" className="mx-auto max-w-3xl px-2 text-xs text-destructive">{routeStatus.error}</p>}
    {live && routeStatus?.pending && !routeStatus.error && <p role="status" className="mx-auto max-w-3xl px-2 text-[10px] text-muted-foreground">CLI selection is syncing… Active turns keep their current reasoning; a different model is restored after its next message.</p>}
    {preview && <ImageLightbox file={preview} onClose={() => setPreview(null)} />}
  </form>;
}
