import { useEffect } from 'react';
import { Download, Loader2, RefreshCw, Rocket, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import { useUpdateStore } from '@/stores/update-store';

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateManager() {
  const updateBehavior = useSettingsStore((state) => state.updateBehavior);
  const {
    initialize,
    availableUpdate,
    status,
    downloadedBytes,
    totalBytes,
    error,
    dismissedVersion,
    installAvailableUpdate,
    dismissAvailableUpdate,
  } = useUpdateStore();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const hasVisibleUpdate = Boolean(
    availableUpdate
      && (status === 'downloading'
        || status === 'installing'
        || status === 'installed'
        || status === 'error'
        || (status === 'available' && dismissedVersion !== availableUpdate.version)),
  );
  if (!hasVisibleUpdate || !availableUpdate) return null;

  const progress = totalBytes && totalBytes > 0
    ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
    : null;
  const busy = status === 'downloading' || status === 'installing';

  return (
    <section
      className="fixed bottom-4 right-4 z-[120] w-[min(390px,calc(100vw-2rem))] rounded-2xl border border-primary/25 bg-card/95 p-4 shadow-2xl backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">AtrisAgent {availableUpdate.version}</p>
            <Badge variant="secondary" className="text-[9px] uppercase tracking-wide">Update</Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {status === 'downloading'
              ? 'Downloading the signed update from GitHub Releases…'
              : status === 'installing'
                ? 'Download verified. Installing the update…'
                : status === 'installed'
                  ? 'Update installed. AtrisAgent is restarting…'
                  : status === 'error'
                    ? (error || 'The update could not be installed.')
                    : `A newer version is available. You are currently on ${availableUpdate.currentVersion}.`}
          </p>
          {status === 'available' && availableUpdate.notes ? (
            <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground/90">
              {availableUpdate.notes}
            </p>
          ) : null}
        </div>
        {!busy && status !== 'installed' ? (
          <button
            type="button"
            onClick={dismissAvailableUpdate}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Dismiss update notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {status === 'downloading' ? (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full bg-primary transition-[width] ${progress === null ? 'w-1/3 animate-pulse' : ''}`}
              style={progress === null ? undefined : { width: `${progress}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
            <span>{formatBytes(downloadedBytes)}</span>
            <span>{totalBytes ? `${progress}% · ${formatBytes(totalBytes)}` : 'Downloading…'}</span>
          </div>
        </div>
      ) : null}

      {status === 'available' ? (
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={dismissAvailableUpdate}>Later</Button>
          <Button size="sm" onClick={() => void installAvailableUpdate()}>
            <Download className="mr-2 h-3.5 w-3.5" />
            Update now
          </Button>
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[10px] text-muted-foreground">
            {updateBehavior === 'automatic' ? 'Automatic update will be retried on the next launch.' : 'You can retry from Settings.'}
          </span>
          <Button variant="outline" size="sm" onClick={() => void useUpdateStore.getState().checkForUpdates(true)}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />Retry
          </Button>
        </div>
      ) : null}
    </section>
  );
}
