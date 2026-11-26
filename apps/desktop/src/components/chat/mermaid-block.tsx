import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTheme } from 'next-themes';
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Download,
  GitBranch,
  Loader2,
  Maximize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useSettingsStore } from '@/stores/settings-store';
import {
  getCachedMermaidSvg,
  getMermaidDiagramLabel,
  renderMermaidDiagram,
  scopeMermaidSvgIds,
  type MermaidRenderResult,
  type MermaidThemeMode,
} from './mermaid-renderer';

export interface MermaidBlockProps {
  code: string;
  isComplete?: boolean;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.2;
const MIN_INLINE_AUTO_SCALE = 0.72;

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
}

function formatRenderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Syntax error');
  const firstLine = message
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 180) : 'Unable to parse Mermaid syntax.';
}

function MermaidCanvas({
  result,
  scopeSuffix,
  zoom,
  className,
  allowWheelZoom = false,
  onZoomChange,
  onFitScaleComputed,
}: {
  result: MermaidRenderResult;
  scopeSuffix: string;
  zoom: number | 'fit';
  className?: string;
  allowWheelZoom?: boolean;
  onZoomChange?: (nextZoom: number) => void;
  onFitScaleComputed?: (fitScale: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(0);
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => {
      setViewportWidth(el.clientWidth);
      setViewportHeight(el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const naturalWidth = result.width ?? 640;
  const naturalHeight = result.height ?? 320;
  const paddingX = 32;
  const paddingY = 32;

  const fitScale = useMemo(() => {
    if (viewportWidth <= paddingX) return 1;
    const widthFit = (viewportWidth - paddingX) / naturalWidth;
    if (allowWheelZoom && viewportHeight > paddingY) {
      const heightFit = (viewportHeight - paddingY) / naturalHeight;
      return clampZoom(Math.min(1, widthFit, heightFit));
    }
    return clampZoom(Math.min(1, widthFit));
  }, [allowWheelZoom, naturalHeight, naturalWidth, viewportHeight, viewportWidth]);

  useEffect(() => {
    onFitScaleComputed?.(fitScale);
  }, [fitScale, onFitScaleComputed]);

  const effectiveZoom = useMemo(() => {
    if (zoom !== 'fit') return clampZoom(zoom);
    if (allowWheelZoom) return fitScale;
    // Inline cards keep wide LR flowcharts legible instead of shrinking text to microscopic size
    return clampZoom(Math.min(1, Math.max(fitScale, MIN_INLINE_AUTO_SCALE)));
  }, [allowWheelZoom, fitScale, zoom]);

  const scopedSvg = useMemo(
    () => scopeMermaidSvgIds(result.svg, result.renderId, scopeSuffix),
    [result.renderId, result.svg, scopeSuffix],
  );

  const scaledWidth = Math.max(1, Math.round(naturalWidth * effectiveZoom));
  const scaledHeight = Math.max(1, Math.round(naturalHeight * effectiveZoom));

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const el = viewportRef.current;
    if (!el) return;
    const canPan = el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2;
    if (!canPan) return;
    el.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    const el = viewportRef.current;
    if (!drag || !el || drag.pointerId !== event.pointerId) return;
    el.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
    el.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    const el = viewportRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    setDragging(false);
    if (el?.hasPointerCapture(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
  };

  const effectiveZoomRef = useRef(effectiveZoom);
  effectiveZoomRef.current = effectiveZoom;

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !onZoomChange) return;
    const handleNativeWheel = (event: WheelEvent) => {
      if (!allowWheelZoom && !event.ctrlKey && !event.metaKey) return;
      if (event.deltaY === 0) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.12 : -0.12;
      onZoomChange(clampZoom(effectiveZoomRef.current + delta));
    };
    el.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleNativeWheel);
  }, [allowWheelZoom, onZoomChange]);

  return (
    <div
      ref={viewportRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cn(
        'relative overflow-auto select-none',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
        className,
      )}
    >
      <div className="flex min-h-full w-max min-w-full items-center justify-center p-4">
        <div
          className="mermaid-svg-host shrink-0"
          style={{ width: `${scaledWidth}px`, height: `${scaledHeight}px` }}
          dangerouslySetInnerHTML={{ __html: scopedSvg }}
        />
      </div>
    </div>
  );
}

export function MermaidBlock({ code, isComplete = true }: MermaidBlockProps) {
  const { resolvedTheme } = useTheme();
  const colorPalette = useSettingsStore(s => s.colorPalette);
  const mode: MermaidThemeMode = resolvedTheme === 'light' ? 'light' : 'dark';
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const trimmedCode = useMemo(() => code.trim(), [code]);
  const diagramLabel = useMemo(() => getMermaidDiagramLabel(trimmedCode), [trimmedCode]);

  const [view, setView] = useState<'diagram' | 'code'>('diagram');
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inlineZoom, setInlineZoom] = useState<number | 'fit'>('fit');
  const [inlineFitScale, setInlineFitScale] = useState(1);
  const [modalZoom, setModalZoom] = useState<number | 'fit'>('fit');
  const [modalFitScale, setModalFitScale] = useState(1);

  const [result, setResult] = useState<MermaidRenderResult | null>(() =>
    trimmedCode ? (getCachedMermaidSvg(trimmedCode, mode, colorPalette) ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    if (!trimmedCode) {
      setResult(null);
      setError('Empty Mermaid diagram');
      setRendering(false);
      return;
    }

    if (!isComplete) {
      setRendering(true);
      setError(null);
      return;
    }

    const cached = getCachedMermaidSvg(trimmedCode, mode, colorPalette);
    if (cached) {
      setResult(cached);
      setError(null);
      setRendering(false);
      return;
    }

    let cancelled = false;
    setRendering(true);
    setError(null);

    const timer = window.setTimeout(() => {
      void renderMermaidDiagram(trimmedCode, { mode, palette: colorPalette })
        .then(rendered => {
          if (cancelled) return;
          setResult(rendered);
          setError(null);
          setRendering(false);
        })
        .catch(err => {
          if (cancelled) return;
          setError(formatRenderError(err));
          setRendering(false);
        });
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedCode, isComplete, mode, colorPalette]);

  const effectiveInlineZoom = inlineZoom === 'fit'
    ? clampZoom(Math.min(1, Math.max(inlineFitScale, MIN_INLINE_AUTO_SCALE)))
    : inlineZoom;
  const effectiveModalZoom = modalZoom === 'fit' ? modalFitScale : modalZoom;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Ignore clipboard write errors in restricted contexts
    }
  }, [code]);

  const handleDownloadSvg = useCallback(() => {
    if (!result) return;
    const blob = new Blob([result.svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mermaid-${diagramLabel.toLowerCase().replace(/\s+/g, '-')}.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [diagramLabel, result]);

  const showDiagramControls = view === 'diagram' && Boolean(result) && !error && isComplete;
  const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <>
      <figure
        data-mermaid-block="true"
        aria-label={`Mermaid ${diagramLabel}`}
        className="my-3 w-full max-w-full overflow-hidden rounded-xl border border-border bg-card/85 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-muted/45 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Mermaid
            </span>
            <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
              {diagramLabel}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {showDiagramControls && (
              <div className="mr-1 flex items-center gap-0.5 rounded-md border border-border/70 bg-background/70 p-0.5">
                <button
                  type="button"
                  onClick={() => setInlineZoom(clampZoom(effectiveInlineZoom - ZOOM_STEP))}
                  disabled={effectiveInlineZoom <= MIN_ZOOM}
                  className={cn('flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40', focusClass)}
                  title="Zoom out"
                  aria-label="Zoom out"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setInlineZoom(inlineZoom === 'fit' ? 1 : 'fit')}
                  className={cn('min-w-[3rem] rounded px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', focusClass)}
                  title={inlineZoom === 'fit' ? 'Switch to 100% scale' : 'Reset zoom'}
                >
                  {Math.round(effectiveInlineZoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => setInlineZoom(clampZoom(effectiveInlineZoom + ZOOM_STEP))}
                  disabled={effectiveInlineZoom >= MAX_ZOOM}
                  className={cn('flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40', focusClass)}
                  title="Zoom in"
                  aria-label="Zoom in"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
                {inlineFitScale < MIN_INLINE_AUTO_SCALE && (
                  <button
                    type="button"
                    onClick={() => setInlineZoom(inlineFitScale)}
                    className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', focusClass)}
                    title="Fit entire diagram to width"
                  >
                    Fit
                  </button>
                )}
              </div>
            )}

            <div role="group" aria-label="Diagram display mode" className="flex items-center rounded-md border border-border/70 bg-background/70 p-0.5">
              <button
                type="button"
                aria-pressed={view === 'diagram'}
                onClick={() => setView('diagram')}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                  focusClass,
                  view === 'diagram'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Diagram
              </button>
              <button
                type="button"
                aria-pressed={view === 'code'}
                onClick={() => setView('code')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                  focusClass,
                  view === 'code'
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Code2 className="h-3 w-3" />
                Code
              </button>
            </div>

            {result && !error && (
              <button
                type="button"
                onClick={() => {
                  setModalZoom('fit');
                  setExpanded(true);
                }}
                className={cn('flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', focusClass)}
                title="Expand diagram"
                aria-label="Expand diagram"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={() => void handleCopy()}
              className={cn('flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', focusClass)}
              title="Copy Mermaid source"
              aria-label="Copy Mermaid source"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {view === 'code' ? (
          <pre className="max-h-[34rem] overflow-auto bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-zinc-300">
            <code>{code}</code>
          </pre>
        ) : !isComplete ? (
          <div>
            <div className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              <span>Streaming diagram source…</span>
            </div>
            <pre className="max-h-[24rem] overflow-auto bg-zinc-950/90 p-3 font-mono text-[12px] leading-relaxed text-zinc-300">
              <code>{code}</code>
            </pre>
          </div>
        ) : error ? (
          <div>
            <div role="alert" className="flex items-start gap-2 border-b border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">Unable to render Mermaid diagram</p>
                <p className="mt-0.5 break-words font-mono text-[11px] opacity-85">{error}</p>
              </div>
            </div>
            <pre className="max-h-[28rem] overflow-auto bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed text-zinc-300">
              <code>{code}</code>
            </pre>
          </div>
        ) : result ? (
          <div className="relative bg-background/40">
            <MermaidCanvas
              result={result}
              scopeSuffix={`inline-${reactId}`}
              zoom={inlineZoom}
              onZoomChange={setInlineZoom}
              onFitScaleComputed={setInlineFitScale}
              className="max-h-[34rem] min-h-[140px]"
            />
            {rendering && (
              <div className="pointer-events-none absolute right-2.5 top-2.5 flex items-center gap-1.5 rounded-md border border-border/70 bg-background/85 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
                <span>Updating…</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-[140px] items-center justify-center gap-2 bg-background/40 px-4 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span>Rendering {diagramLabel.toLowerCase()}…</span>
          </div>
        )}
      </figure>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[min(88vh,920px)] w-[min(94vw,1400px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 py-3 pl-4 pr-12">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch className="h-4 w-4 shrink-0 text-primary" />
              <DialogTitle className="truncate text-sm">Mermaid {diagramLabel}</DialogTitle>
              <DialogDescription className="sr-only">
                Interactive zoomed view of the rendered Mermaid diagram. Drag to pan or scroll to zoom.
              </DialogDescription>
            </div>

            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-0.5 rounded-md border border-border bg-background/80 p-0.5">
                <button
                  type="button"
                  onClick={() => setModalZoom(clampZoom(effectiveModalZoom - ZOOM_STEP))}
                  disabled={effectiveModalZoom <= MIN_ZOOM}
                  className={cn('flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40', focusClass)}
                  title="Zoom out"
                  aria-label="Zoom out"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-[3.2rem] text-center font-mono text-xs font-medium tabular-nums text-foreground/85">
                  {Math.round(effectiveModalZoom * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setModalZoom(clampZoom(effectiveModalZoom + ZOOM_STEP))}
                  disabled={effectiveModalZoom >= MAX_ZOOM}
                  className={cn('flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40', focusClass)}
                  title="Zoom in"
                  aria-label="Zoom in"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setModalZoom('fit')}
                  className={cn('flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', focusClass)}
                  title="Fit to viewport"
                >
                  <RotateCcw className="h-3 w-3" />
                  Fit
                </button>
                <button
                  type="button"
                  onClick={() => setModalZoom(1)}
                  className={cn('flex h-7 items-center rounded px-2 font-mono text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', focusClass)}
                  title="Actual size (100%)"
                >
                  100%
                </button>
              </div>

              <button
                type="button"
                onClick={handleDownloadSvg}
                className={cn('flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/80 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', focusClass)}
                title="Download SVG"
              >
                <Download className="h-3.5 w-3.5" />
                SVG
              </button>

              <button
                type="button"
                onClick={() => void handleCopy()}
                className={cn('flex h-8 items-center gap-1.5 rounded-md border border-border bg-background/80 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', focusClass)}
                title="Copy Mermaid source"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 bg-background/50">
            {result && (
              <MermaidCanvas
                result={result}
                scopeSuffix={`modal-${reactId}`}
                zoom={modalZoom}
                allowWheelZoom
                onZoomChange={setModalZoom}
                onFitScaleComputed={setModalFitScale}
                className="h-full w-full"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
