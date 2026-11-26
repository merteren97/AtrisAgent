import { useEffect, useState } from 'react';
import { FileText, X } from 'lucide-react';

export function ImageLightbox({
  file,
  name: explicitName,
  url: explicitUrl,
  onClose,
}: {
  file?: File;
  name?: string;
  url?: string;
  onClose: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string>();
  const displayName = file?.name || explicitName || 'Attachment';

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setObjectUrl(undefined);
      return;
    }
    const created = URL.createObjectURL(file);
    setObjectUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const resolvedUrl = explicitUrl || objectUrl;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${displayName}`}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        autoFocus
        aria-label="Close preview"
        onClick={onClose}
        className="absolute right-5 top-5 rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      {resolvedUrl ? (
        <img
          src={resolvedUrl}
          alt={displayName}
          onClick={(event) => event.stopPropagation()}
          className="max-h-[80vh] max-w-full rounded-xl object-contain shadow-2xl"
        />
      ) : (
        <FileText className="h-16 w-16 text-white" />
      )}
      <p className="max-w-full truncate text-sm text-white/80">{displayName}</p>
    </div>
  );
}
