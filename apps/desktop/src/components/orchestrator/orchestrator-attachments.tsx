import { useEffect, useRef, useState, type RefObject } from 'react';
import { FileText, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { canPreviewAttachment } from '@/stores/orchestrator-attachments-store';

export { useOrchestratorAttachments } from '@/stores/orchestrator-attachments-store';
export type { UseOrchestratorAttachmentsResult, OrchestratorAttachmentUpload } from '@/stores/orchestrator-attachments-store';

export function AttachmentLightbox({ name, url, image, open, onOpenChange, status, returnFocusRef }: {
  name: string; url?: string; image: boolean; open: boolean; onOpenChange: (open: boolean) => void; status?: string;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent onCloseAutoFocus={(event) => { if (returnFocusRef?.current) { event.preventDefault(); returnFocusRef.current.focus(); } }} className="w-[min(1100px,calc(100vw-2rem))] max-w-none gap-3 p-4 sm:max-w-none">
      <DialogTitle className="break-words pr-8 text-sm">{name}</DialogTitle>
      <DialogDescription className="sr-only">Attached file preview</DialogDescription>
      {status ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">{status}</p>
        : image && url ? <img src={url} alt={name} className="mx-auto max-h-[calc(100vh-9rem)] max-w-full object-contain" />
        : <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground"><FileText className="h-12 w-12" /><p className="text-sm">No inline preview for this file type.</p></div>}
      {url && <a href={url} download={name} className="w-fit rounded text-sm text-primary underline focus-visible:ring-2 focus-visible:ring-ring">Download file</a>}
    </DialogContent>
  </Dialog>;
}

function AttachmentPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string>();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const image = canPreviewAttachment(file);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return <>
    <div className={`group relative flex h-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/40 ${image ? 'w-16' : 'w-28'}`}>
      <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-label={`Preview ${file.name}`} title={file.name} className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        {image && url ? <img src={url} alt={file.name} className="h-full w-full object-cover" /> : <><FileText className="h-5 w-5 shrink-0 text-muted-foreground" /><span className="w-full truncate text-[10px] text-muted-foreground">{file.name}</span></>}
      </button>
      <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`} className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-foreground shadow-sm hover:bg-destructive hover:text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring"><X className="h-3.5 w-3.5" /></button>
    </div>
    <AttachmentLightbox name={file.name} url={url} image={image} open={open} onOpenChange={setOpen} returnFocusRef={trigger} />
  </>;
}

export function OrchestratorAttachmentTray({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  if (!files.length) return null;
  return <div aria-label="Attached files" className="mb-2 flex gap-2 overflow-x-auto border-b border-border/60 pb-3">
    {files.map((file, index) => <AttachmentPreview key={`${file.name}-${file.size}-${file.lastModified}-${index}`} file={file} onRemove={() => onRemove(index)} />)}
  </div>;
}
