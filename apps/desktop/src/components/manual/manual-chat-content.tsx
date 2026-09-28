import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileText, ImageIcon } from 'lucide-react';
import { MarkdownContent } from '@/components/chat/markdown-content';

interface Attachment { name: string; path: string }
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

export function ManualChatContent({ text, agentId, user }: { text: string; agentId: string; user: boolean }) {
  const content = user ? displayManualPrompt(text) : { text, attachments: [] };
  return <>{content.text && <MarkdownContent content={content.text} />}{content.attachments.length > 0 && <div aria-label="Sent attachments" className="mt-2 flex flex-wrap gap-2">{content.attachments.map((attachment, index) => <SentAttachment key={`${attachment.path}:${index}`} attachment={attachment} agentId={agentId} />)}</div>}</>;
}
