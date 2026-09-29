import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileText, ImageIcon, Loader2 } from 'lucide-react';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface Attachment { name: string; path: string }
interface ProjectImage { name: string; path: string }

export function assistantProjectImages(text: string): ProjectImage[] {
  const matches = text.matchAll(/!?\[([^\]\n]{1,120})\]\(([^)\n]{1,2048})\)/g);
  const images: ProjectImage[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const path = match[2].trim();
    const external = /^(?:[a-z][\w+.-]*:|\/\/)/i.test(path) && !/^[a-z]:[\\/]/i.test(path);
    if (path.length > 1024 || external || !/\.(?:png|jpe?g|webp|gif)$/i.test(path) || seen.has(path)) continue;
    images.push({ name: match[1], path });
    seen.add(path);
    if (images.length === 12) break;
  }
  return images;
}

function ProjectImagePreview({ image, cwd, open, onOpenChange }: { image: ProjectImage; cwd: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true; let objectUrl: string | undefined;
    const extension = image.path.split('.').pop()?.toLowerCase();
    const mime = extension === 'jpg' ? 'jpeg' : extension;
    void invoke<number[]>('manual_project_image_preview', { cwd, path: image.path }).then(bytes => {
      if (!active) return;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: `image/${mime}` }));
      setUrl(objectUrl);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [cwd, image.path]);
  return <>
    <button type="button" onClick={() => onOpenChange(true)} aria-label={`Review ${image.name}`} title={image.path} className="group flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex h-28 w-full items-center justify-center overflow-hidden bg-muted/40">
        {url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" /> : error ? <ImageIcon className="h-6 w-6 text-muted-foreground" /> : <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      </div>
      <span className="truncate px-2 py-1.5 text-xs text-foreground">{image.name}</span>
      {error && <span className="px-2 pb-1.5 text-[11px] text-muted-foreground">Image unavailable</span>}
    </button>
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="w-[min(1100px,calc(100vw-2rem))] max-w-none gap-3 p-4 sm:max-w-none">
      <DialogTitle className="pr-8 text-sm">{image.name}</DialogTitle>
      {url && <img src={url} alt={image.name} className="mx-auto max-h-[calc(100vh-9rem)] max-w-full object-contain" />}
      {!url && <p role="status" className="py-12 text-center text-sm text-muted-foreground">{error ? 'Image unavailable' : 'Loading image…'}</p>}
      <p className="truncate text-xs text-muted-foreground" title={image.path}>{image.path}</p>
    </DialogContent></Dialog>
  </>;
}
export function displayManualPrompt(text: string): { text: string; attachments: Attachment[] } {
  const marker = 'Attached files (read these local paths to inspect their contents, including images):\n';
  const offset = text.lastIndexOf(marker);
  if (offset < 0 || (offset > 0 && text.slice(offset - 2, offset) !== '\n\n')) return { text, attachments: [] };
  const lines = text.slice(offset + marker.length).trimEnd().split('\n');
  const attachments: Attachment[] = [];
  for (const line of lines) {
    const match = /^- ("(?:\\.|[^"\\])*"): ("(?:\\.|[^"\\])*")$/.exec(line);
    if (!match) return { text, attachments: [] };
    try {
      const name = JSON.parse(match[1]); const path = JSON.parse(match[2]);
      if (typeof name !== 'string' || typeof path !== 'string') return { text, attachments: [] };
      attachments.push({ name, path });
    } catch { return { text, attachments: [] }; }
  }
  return attachments.length ? { text: text.slice(0, offset).trimEnd(), attachments } : { text, attachments: [] };
}

function SentAttachment({ attachment, agentId }: { attachment: Attachment; agentId: string }) {
  const [url, setUrl] = useState<string>();
  const image = /\.(png|jpe?g|webp|gif)$/i.test(attachment.name);
  useEffect(() => {
    if (!image) return;
    let active = true; let objectUrl: string | undefined;
    void invoke<number[]>('manual_attachment_preview', { id: agentId, path: attachment.path }).then(bytes => {
      if (!active) return;
      const extension = attachment.name.split('.').pop()?.toLowerCase();
      const mime = extension === 'jpg' ? 'jpeg' : extension;
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: `image/${mime}` }));
      setUrl(objectUrl);
    }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [agentId, attachment.path, attachment.name, image]);
  return url ? <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`} className="block w-fit overflow-hidden rounded-lg border border-border focus-visible:ring-2 focus-visible:ring-ring"><img src={url} alt={attachment.name} className="max-h-52 max-w-full object-contain" /></a>
    : <span title={attachment.name} className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-background/50 px-2 py-1 text-xs text-muted-foreground">{image ? <ImageIcon className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}<span className="truncate">{attachment.name}</span></span>;
}

export function ManualChatContent({ text, agentId, cwd, user }: { text: string; agentId: string; cwd: string; user: boolean }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const content = user ? displayManualPrompt(text) : { text, attachments: [] };
  const images = user ? [] : assistantProjectImages(text);
  const openImage = (path: string) => { if (images.some(image => image.path === path)) setSelectedPath(path); };
  return <>{content.text && <MarkdownContent content={content.text} onLocalImageLink={images.length ? openImage : undefined} />}{content.attachments.length > 0 && <div aria-label="Sent attachments" className="mt-2 flex flex-wrap gap-2">{content.attachments.map((attachment, index) => <SentAttachment key={`${attachment.path}:${index}`} attachment={attachment} agentId={agentId} />)}</div>}{images.length > 0 && <div aria-label="Generated image previews" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{images.map(image => <ProjectImagePreview key={image.path} image={image} cwd={cwd} open={selectedPath === image.path} onOpenChange={open => setSelectedPath(open ? image.path : null)} />)}</div>}</>;
}
