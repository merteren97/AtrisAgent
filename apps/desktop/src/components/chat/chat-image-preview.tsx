import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ImageIcon, Loader2, Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { apiRequest, getApiOrigin } from '@/lib/api-client';
import { planApi } from '@/stores/planning-store';

export interface ChatImageItem {
  name: string;
  path: string;
}

export function normalizeImagePath(raw: string): string {
  let cleaned = raw.trim();
  if (/^file:\/\/\/?/i.test(cleaned)) {
    cleaned = decodeURIComponent(cleaned.replace(/^file:\/\/\/?/i, ''));
  }
  // Remove wrapping quotes or backticks if any
  cleaned = cleaned.replace(/^[`'"]+|[`'"]+$/g, '');
  // Unescape double backslashes in Windows paths (from JSON / logs)
  if (/^[a-zA-Z]:\\\\/.test(cleaned) || cleaned.includes('\\\\')) {
    cleaned = cleaned.replace(/\\\\/g, '\\');
  }
  return cleaned;
}

export function extractChatImages(text: string): ChatImageItem[] {
  if (!text) return [];
  const images: ChatImageItem[] = [];
  const seen = new Set<string>();

  // 1. Markdown link / image syntax: ![name](path) or [name](path)
  const mdMatches = text.matchAll(/!?\[([^\]\n]{0,120})\]\(([^)\n]{1,2048})\)/g);
  for (const match of mdMatches) {
    const rawPath = match[2].trim();
    if (/^https?:\/\//i.test(rawPath)) continue;
    const path = normalizeImagePath(rawPath);
    if (!/\.(?:png|jpe?g|webp|gif)$/i.test(path) || seen.has(path.toLowerCase())) continue;
    const name = match[1]?.trim() || path.split(/[\\/]/).pop() || 'Image';
    images.push({ name, path });
    seen.add(path.toLowerCase());
    if (images.length >= 12) return images;
  }

  // 2. Raw file:/// or Windows/Unix paths ending in image extensions
  const pathMatches = text.matchAll(/(?:file:\/\/\/[^\s<>"`']+\.(?:png|jpe?g|webp|gif)|\b[a-zA-Z]:[\\/][^\s<>"`']+\.(?:png|jpe?g|webp|gif)|assets[/\\][^\s<>"`']+\.(?:png|jpe?g|webp|gif))/gi);
  for (const match of pathMatches) {
    const path = normalizeImagePath(match[0]);
    if (seen.has(path.toLowerCase()) || !/\.(?:png|jpe?g|webp|gif)$/i.test(path)) continue;
    const name = path.split(/[\\/]/).pop() || 'Image';
    images.push({ name, path });
    seen.add(path.toLowerCase());
    if (images.length >= 12) return images;
  }

  return images;
}

export function ChatImageThumbnail({
  image,
  cwd,
  workspaceId,
  planId,
  className = '',
}: {
  image: ChatImageItem;
  cwd?: string;
  workspaceId?: string;
  planId?: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const activeWorkspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const effectiveCwd = cwd || activeWorkspace?.path || '';

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    const extension = image.path.split('.').pop()?.toLowerCase();
    const mime = extension === 'jpg' ? 'jpeg' : extension;

    // If it's a planning asset and planning credentials are provided, use planning media-grant API
    const planningAssetMatch = /(?:^|[/\\])\.atris-plans[/\\][^/\\]+[/\\](assets[/\\][^\s?#]+)$/.exec(image.path);
    const planningPath = planningAssetMatch
      ? planningAssetMatch[1].replace(/\\/g, '/')
      : (/^assets[/\\]/i.test(image.path) ? image.path.replace(/\\/g, '/') : undefined);

    if (workspaceId && planId && planningPath) {
      void apiRequest<{ url: string }>(`${planApi(workspaceId, planId)}/media-grant`, {
        method: 'POST',
        body: JSON.stringify({ path: planningPath }),
      })
        .then((grant) => {
          if (!active) return;
          setUrl(new URL(grant.url, getApiOrigin()).href);
          setError(false);
        })
        .catch(() => {
          if (active) setError(true);
        });
      return () => {
        active = false;
      };
    }

    // Otherwise use native Tauri preview
    void invoke<number[]>('manual_project_image_preview', {
      cwd: effectiveCwd,
      path: image.path,
    })
      .then((bytes) => {
        if (!active) return;
        const b = new Uint8Array(bytes);
        const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
        const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
        const isGif = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
        const isWebp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
        const detectedMime = isPng ? 'image/png'
          : isJpeg ? 'image/jpeg'
          : isGif ? 'image/gif'
          : isWebp ? 'image/webp'
          : `image/${mime}`;
        objectUrl = URL.createObjectURL(new Blob([b], { type: detectedMime }));
        setUrl(objectUrl);
        setError(false);
      })
      .catch(() => {
        if (active) setError(true);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [effectiveCwd, image.path, workspaceId, planId]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Preview ${image.name}`}
        title={image.path}
        className={`group relative flex min-w-0 max-w-xs flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      >
        <div className="relative flex h-32 w-full items-center justify-center overflow-hidden bg-muted/30">
          {url ? (
            <>
              <img
                src={url}
                alt={image.name}
                loading="lazy"
                className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]"
              />
              <span className="absolute bottom-1.5 right-1.5 rounded-md bg-background/80 p-1 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Maximize2 className="h-3.5 w-3.5 text-foreground" />
              </span>
            </>
          ) : error ? (
            <div className="flex flex-col items-center gap-1 p-2 text-center text-[10px] text-muted-foreground">
              <ImageIcon className="h-5 w-5" />
              <span>Image unavailable</span>
            </div>
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-col px-2.5 py-1.5">
          <span className="truncate text-xs font-medium text-foreground">{image.name}</span>
          <span className="truncate text-[10px] text-muted-foreground">{image.path}</span>
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(1100px,calc(100vw-2rem))] max-w-none gap-3 p-4 sm:max-w-none">
          <DialogTitle className="pr-8 text-sm">{image.name}</DialogTitle>
          {url && (
            <img
              src={url}
              alt={image.name}
              className="mx-auto max-h-[calc(100vh-9rem)] max-w-full object-contain"
            />
          )}
          {!url && (
            <p role="status" className="py-12 text-center text-sm text-muted-foreground">
              {error ? 'Image unavailable' : 'Loading image…'}
            </p>
          )}
          <p className="truncate text-xs text-muted-foreground select-all" title={image.path}>
            {image.path}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ChatImageGallery({
  images,
  cwd,
  workspaceId,
  planId,
}: {
  images: ChatImageItem[];
  cwd?: string;
  workspaceId?: string;
  planId?: string;
}) {
  if (!images.length) return null;
  return (
    <div aria-label="Image previews" className="mt-3 flex flex-wrap gap-2.5">
      {images.map((img) => (
        <ChatImageThumbnail key={img.path} image={img} cwd={cwd} workspaceId={workspaceId} planId={planId} />
      ))}
    </div>
  );
}
