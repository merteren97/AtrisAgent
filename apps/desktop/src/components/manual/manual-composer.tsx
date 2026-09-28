import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from 'react';
import { Brain, FileText, GripHorizontal, ImagePlus, Loader2, Send, Shield, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatSessionControls } from './chat-session-controls';
import type { ManualAgent } from '@/stores/manual-store';
import type { DiscoveredModel } from '@/stores/account-store';

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

function ImageLightbox({ file, onClose }: { file: File; onClose: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div role="dialog" aria-modal="true" aria-label={`Preview ${file.name}`} className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black/85 p-6 backdrop-blur-sm" onClick={onClose}>
    <button type="button" autoFocus aria-label="Close preview" onClick={onClose} className="absolute right-5 top-5 rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"><X className="h-5 w-5" /></button>
    {url ? <img src={url} alt={file.name} onClick={event => event.stopPropagation()} className="max-h-[80vh] max-w-full rounded-xl object-contain shadow-2xl" /> : <FileText className="h-16 w-16 text-white" />}
    <p className="max-w-full truncate text-sm text-white/80">{file.name}</p>
  </div>;
}

export function ManualComposer({ agent, agents, live, native, pending, draft, files, autoApprove, onAutoApprove, onDraft, onAddFiles, onRemoveFile, onSend, onMemory, onApply }: {
  agent: ManualAgent; agents: ManualAgent[]; live: boolean; native: boolean; pending: boolean;
  autoApprove?: OpenCodeAutoApprove; onAutoApprove?: (enabled: boolean) => Promise<void>;
  draft: string; files: File[]; onDraft: (value: string) => void; onAddFiles: (files: File[]) => void; onRemoveFile: (file: File) => void;
  onSend: () => void; onMemory: () => void; onApply: (model: DiscoveredModel, independent: boolean, reasoning?: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [height, setHeight] = useState(72);
  const [preview, setPreview] = useState<File | null>(null);
  const [requestedMode, setRequestedMode] = useState<boolean | null>(null);
  const [modeError, setModeError] = useState<string>();
  const drag = useRef<{ start: number; height: number } | null>(null);
  const ignoreClick = useRef(false);
  const canSend = native && live && !pending && (draft.trim().length > 0 || files.length > 0);
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
  const resize = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    drag.current = { start: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return <form aria-label="Manual message composer" className="shrink-0 px-4 pb-3 pt-2" onSubmit={event => { event.preventDefault(); if (canSend) onSend(); }}>
    <div className="mx-auto max-w-3xl rounded-2xl border border-input bg-card p-3 shadow-sm transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/15">
      {files.length > 0 && <div aria-label="Attached files" className="mb-2 flex gap-2 overflow-x-auto border-b border-border/60 pb-3">
        {files.map((file, index) => <FilePreview key={`${file.name}-${file.lastModified}-${index}`} file={file} onOpen={() => setPreview(file)} onRemove={() => { if (preview === file) setPreview(null); onRemoveFile(file); }} />)}
      </div>}
      <textarea aria-label={`Message ${agent.name}`} value={draft} onChange={event => onDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) onSend(); } }} placeholder={live ? 'Message this agent…' : 'Open the agent to continue…'} maxLength={32000} style={{ height }} className="block w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground" />
      <button type="button" aria-label="Resize message area" title="Drag to resize · click to expand or collapse" onClick={() => { if (ignoreClick.current) { ignoreClick.current = false; return; } setHeight(value => value < 150 ? 216 : 72); }} onPointerDown={resize} onPointerMove={event => { if (drag.current) setHeight(Math.max(72, Math.min(320, drag.current.height + drag.current.start - event.clientY))); }} onPointerUp={event => { if (drag.current) { ignoreClick.current = Math.abs(event.clientY - drag.current.start) > 4; drag.current = null; } }} onLostPointerCapture={() => { drag.current = null; }} className="mx-auto flex h-5 w-16 cursor-ns-resize items-center justify-center rounded-full text-muted-foreground/60 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><GripHorizontal className="h-4 w-4" /></button>
      <div className="flex items-center justify-between gap-2"><ChatSessionControls key={`${agent.id}:${agent.catalogId}`} agent={agent} agents={agents} pending={pending || !native} onApply={onApply}/><div className="flex items-center gap-1">
        <input ref={input} type="file" multiple className="sr-only" aria-label="Choose files to attach" onChange={(event: ChangeEvent<HTMLInputElement>) => { onAddFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
        <Button type="button" variant="ghost" size="icon" aria-label="Attach files or images" title="Attach files or images" onClick={() => input.current?.click()}><ImagePlus className="h-4 w-4" /></Button>
        {agent.runtimeType === 'opencode' && <Button type="button" variant={autoApprove?.enabled ? 'secondary' : 'ghost'} size="icon" aria-label={autoApprove?.enabled ? 'Disable OpenCode auto-approve' : 'Enable OpenCode auto-approve'} aria-pressed={Boolean(autoApprove?.enabled)} title={autoApprove?.enabled ? 'Auto-approve on · click to turn off' : 'Auto-approve future permissions · explicit deny rules still apply'} disabled={!native || !live || pending || !autoApprove?.available || requestedMode !== null} onClick={toggleAutoApprove}>{requestedMode !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : autoApprove?.enabled ? <ShieldCheck className="h-4 w-4 text-primary" /> : <Shield className="h-4 w-4" />}</Button>}
        <Button type="button" variant="ghost" size="icon" aria-label="Open memory and references" onClick={onMemory}><Brain className="h-4 w-4" /></Button>
        <Button type="submit" size="sm" disabled={!canSend}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}<span className="ml-2">Send</span></Button>
      </div></div>
    </div>
    <p className="mx-auto mt-2 max-w-3xl px-2 text-[10px] text-muted-foreground">{agent.name} · {live ? 'CLI open' : 'Offline'}{agent.runtimeType === 'opencode' && autoApprove?.enabled ? ' · Auto-approve on' : ''} · Shift+Enter for a new line · Drag the handle to resize</p>
    {requestedMode === null && (modeError || autoApprove?.error) && <p role="alert" className="mx-auto max-w-3xl px-2 text-xs text-destructive">{modeError || autoApprove?.error}</p>}
    {preview && <ImageLightbox file={preview} onClose={() => setPreview(null)} />}
  </form>;
}
