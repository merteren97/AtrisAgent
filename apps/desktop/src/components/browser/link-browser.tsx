import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, ArrowRight, Globe, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isTauriRuntime } from '@/lib/secure-storage';
import { browserUrl, useBrowserStore } from '@/stores/browser-store';
import { cn } from '@/lib/utils';

type NavigationEvent = {url:string;loading:boolean};

export function LinkBrowser() {
  const {url, requestId, expanded, width, open, close, setExpanded, setWidth} = useBrowserStore();
  const [address,setAddress] = useState('');
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(false);
  const [frameRevision,setFrameRevision] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{x:number;width:number} | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const native = isTauriRuntime();
  const enqueue = useCallback((command:string,args?:Record<string,unknown>) => {
    queue.current = queue.current.catch(() => {}).then(async () => { await invoke(command,args); }).catch(cause => {setError(String(cause));setLoading(false);});
  },[]);

  useLayoutEffect(() => {
    if (url && !previousFocus.current) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!url && previousFocus.current) { const target = previousFocus.current; previousFocus.current = null; if (target.isConnected) target.focus(); }
  },[url]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void Promise.all([
      listen<NavigationEvent>('link-browser-navigation',event => {if (!disposed) {setAddress(event.payload.url);setLoading(event.payload.loading);}}),
      listen<string>('link-browser-open',event => {if (!disposed) open(event.payload);}),
    ]).then(items => {if (disposed) items.forEach(unlisten => unlisten());else cleanups.push(...items);}).catch(cause => {if (!disposed)setError(String(cause));});
    return () => {disposed=true;cleanups.forEach(unlisten=>unlisten());};
  },[native,open]);

  useLayoutEffect(() => {
    if (!native || !url || !host.current) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.current?.getBoundingClientRect();
        if (rect && rect.width >= 1 && rect.height >= 1) enqueue('browser_resize',{rect:{x:Math.max(0,rect.left),y:Math.max(0,rect.top),width:rect.width,height:rect.height}});
      });
    };
    const observer = new ResizeObserver(sync);observer.observe(host.current);
    window.addEventListener('resize',sync);sync();
    return () => {cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',sync);};
  },[native,url,expanded,width,enqueue]);

  useEffect(() => {
    if (!url) {if (native) enqueue('browser_close');setError('');return;}
    setAddress(url);setError('');setLoading(true);
    if (!native) {setFrameRevision(value=>value+1);return;}
    const rect = host.current?.getBoundingClientRect();
    if (rect && rect.width >= 1 && rect.height >= 1) enqueue('browser_open',{url,rect:{x:Math.max(0,rect.left),y:Math.max(0,rect.top),width:rect.width,height:rect.height}});
  },[native,url,requestId,enqueue]);

  useEffect(() => {
    if (!native || !url) return;
    const syncVisibility = () => enqueue('browser_visibility',{visible:!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')});
    const observer = new MutationObserver(syncVisibility);
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-state','role']});
    syncVisibility();
    return () => observer.disconnect();
  },[native,url,enqueue]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setLoading(false), 15_000);
    return () => window.clearTimeout(timer);
  },[loading,requestId]);

  useEffect(() => () => { if (native) enqueue('browser_close'); useBrowserStore.getState().close(); },[native,enqueue]);

  if (!url) return null;
  const navigate = (event:React.FormEvent) => {
    event.preventDefault();
    const raw = address.trim();
    const next = browserUrl(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!next) {setError('Enter a valid HTTP or HTTPS address.');return;}
    open(next);
  };
  const action = (value:'back'|'forward'|'reload') => {
    if (native) enqueue('browser_action',{action:value});
    else if (value === 'reload') {setLoading(true);setFrameRevision(revision=>revision+1);}
  };
  return <aside aria-label="Link browser" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();if(expanded)setExpanded(false);else close();}}} className={cn('relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm',expanded?'fixed inset-3 z-[90] shadow-2xl':'my-2 mr-2')} style={expanded ? undefined : {width:`min(${width}px, calc(100vw - 360px))`}}>
    {!expanded && <div role="separator" aria-label="Resize browser" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={900} aria-valuenow={width} tabIndex={0} className="absolute bottom-0 left-0 top-0 z-10 w-2 cursor-col-resize touch-none hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none" onPointerDown={event=>{drag.current={x:event.clientX,width};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(drag.current)setWidth(drag.current.width+drag.current.x-event.clientX);}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setWidth(width+(event.key==='ArrowLeft'?20:-20));}}}/>}
    <header className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border px-3 py-2 pl-4">
      <div className="mr-1 flex shrink-0 items-center gap-1"><Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Back" disabled={!native} onClick={()=>action('back')}><ArrowLeft className="h-4 w-4"/></Button><Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Forward" disabled={!native} onClick={()=>action('forward')}><ArrowRight className="h-4 w-4"/></Button><Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Reload" onClick={()=>action('reload')}><RefreshCw className={cn('h-4 w-4',loading&&'animate-spin motion-reduce:animate-none')}/></Button></div>
      <form onSubmit={navigate} className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-border bg-muted/30 px-2"><Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/><Input ref={input} aria-label="Web address" value={address} onChange={event=>setAddress(event.target.value)} className="h-8 min-w-0 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"/></form>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={expanded?'Restore browser size':'Expand browser'} onClick={()=>setExpanded(!expanded)}>{expanded?<Minimize2 className="h-4 w-4"/>:<Maximize2 className="h-4 w-4"/>}</Button>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Close browser" onClick={close}><X className="h-4 w-4"/></Button>
    </header>
    {error && <div role="alert" className="shrink-0 border-b border-border px-4 py-2 text-xs text-destructive">{error}</div>}
    <div className="min-h-0 min-w-0 flex-1 p-2"><div ref={host} className="h-full w-full overflow-hidden rounded-md bg-background">
      {!native && <iframe key={frameRevision} title="Web page" src={url} sandbox="allow-forms allow-scripts allow-same-origin allow-popups" onLoad={()=>setLoading(false)} className="h-full w-full border-0"/>}
    </div></div>
    {!native && <p className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">Browser preview: some websites do not allow embedding.</p>}
  </aside>;
}
