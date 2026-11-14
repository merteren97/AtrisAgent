import { useEffect, useRef, useState } from 'react';
import { Download, FileText, ImageIcon, Loader2, Maximize2, RotateCcw } from 'lucide-react';
import { apiRequest, getApiOrigin } from '@/lib/api-client';
import { planApi } from '@/stores/planning-store';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function PlanningMedia({ workspaceId, planId, path, label }: { workspaceId: string; planId: string; path: string; label?: string }) {
  const [url, setUrl] = useState(''); const [error, setError] = useState('');
  const [retry, setRetry] = useState(0); const [zoom, setZoom] = useState(false);
  const media = useRef<HTMLMediaElement | null>(null);
  const playback = useRef({ time: 0, playing: false });
  const name = label || path.split('/').pop() || path;
  const image = /\.(png|jpe?g|webp|gif)$/i.test(path);
  const video = /\.(mp4|webm|mov)$/i.test(path);
  const audio = /\.(mp3|wav|ogg)$/i.test(path);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    setUrl(''); setError('');
    const refresh = async () => {
      try {
        const grant = await apiRequest<{ url: string; expiresAt: string }>(`${planApi(workspaceId, planId)}/media-grant`, { method: 'POST', body: JSON.stringify({ path }) });
        if (disposed) return;
        if (media.current) playback.current = { time: media.current.currentTime, playing: !media.current.paused };
        setUrl(new URL(grant.url, getApiOrigin()).href); setError('');
        timer = setTimeout(() => void refresh(), Math.max(5_000, Date.parse(grant.expiresAt) - Date.now() - 20_000));
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : 'File unavailable.'); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [workspaceId, planId, path, retry]);
  const restore = () => {
    if (!media.current) return;
    if (playback.current.time && Number.isFinite(media.current.duration)) media.current.currentTime = Math.min(playback.current.time, media.current.duration);
    if (playback.current.playing) void media.current.play().catch(() => {});
  };
  return <figure className="my-4 min-w-0 overflow-hidden rounded-xl border border-border bg-card">
    <div className="relative flex min-h-24 items-center justify-center bg-muted/30">
      {error ? <div role="status" className="flex flex-col items-center gap-2 p-6 text-center text-xs text-muted-foreground"><ImageIcon className="h-5 w-5" /><span>{error}</span><Button size="sm" variant="outline" onClick={() => setRetry(value => value + 1)}><RotateCcw className="mr-1.5 h-3 w-3" />Retry preview</Button></div>
        : !url ? <Loader2 aria-label="Loading preview" className="m-8 h-5 w-5 animate-spin text-muted-foreground" />
          : image ? <button type="button" className="group relative block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Enlarge ${name}`} onClick={() => setZoom(true)}><img src={url} alt={name} loading="lazy" className="mx-auto max-h-[30rem] max-w-full object-contain" onError={() => setError('Image unavailable. Check that the file still exists.')} /><span className="absolute bottom-3 right-3 rounded-md bg-background/90 p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><Maximize2 className="h-4 w-4" /></span></button>
            : video ? <video ref={element => { media.current = element; }} src={url} controls playsInline preload="metadata" onLoadedMetadata={restore} onError={() => setError('This video format could not be played. Download it to open in your media player.')} className="max-h-[32rem] w-full" />
              : audio ? <audio ref={element => { media.current = element; }} src={url} controls preload="metadata" onLoadedMetadata={restore} className="m-4 max-w-[calc(100%-2rem)]" />
                : <FileText className="m-6 h-8 w-8 text-muted-foreground" />}
    </div>
    <figcaption className="flex min-w-0 items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs"><span className="truncate text-muted-foreground" title={path}>{name}</span>{url && <a href={url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1.5 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Download className="h-3.5 w-3.5" />Original</a>}</figcaption>
    <Dialog open={zoom} onOpenChange={setZoom}><DialogContent className="w-[calc(100vw-3rem)] max-w-6xl sm:max-w-6xl"><DialogTitle className="truncate pr-8 text-sm">{name}</DialogTitle>{url && <img src={url} alt={name} className="mx-auto max-h-[calc(100vh-10rem)] max-w-full object-contain" />}</DialogContent></Dialog>
  </figure>;
}
