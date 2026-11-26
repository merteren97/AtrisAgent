import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  ImageIcon,
  Info,
  Lightbulb,
  Loader2,
  Maximize2,
  ShieldAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { browserUrl, useBrowserStore } from '@/stores/browser-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { apiRequest, getApiOrigin } from '@/lib/api-client';
import { planApi } from '@/stores/planning-store';
import { loadLocalImagePreviewBlob, normalizeImagePath } from './chat-image-preview';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { MermaidBlock } from './mermaid-block';
import { isMermaidLanguage } from './mermaid-renderer';

export interface MarkdownContentProps {
  content: string;
  className?: string;
  cwd?: string;
  workspaceId?: string;
  planId?: string;
  onLocalImageLink?: (path: string) => void;
  onLocalFileLink?: (path: string) => void;
}

type AlertKind = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

interface ListItem {
  text: string;
  children?: Block[];
}

interface Block {
  type: 'paragraph' | 'heading' | 'code' | 'quote' | 'alert' | 'list' | 'separator' | 'table' | 'image';
  level?: number;
  language?: string;
  closed?: boolean;
  text?: string;
  alertType?: AlertKind;
  items?: ListItem[];
  ordered?: boolean;
  start?: number;
  headers?: string[];
  rows?: string[][];
  alignments?: Array<'left' | 'center' | 'right'>;
  alt?: string;
  src?: string;
}

export function normalizeFileUri(raw: string): string {
  let cleaned = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '');
  if (/^file:\/\//i.test(cleaned)) {
    const afterScheme = cleaned.slice(7);
    const stripped = /^\/[a-zA-Z]:/.test(afterScheme) ? afterScheme.slice(1) : afterScheme;
    try {
      cleaned = decodeURIComponent(stripped);
    } catch {
      cleaned = stripped;
    }
  }
  if (/^[a-zA-Z]:\\\\/.test(cleaned) || cleaned.includes('\\\\')) {
    cleaned = cleaned.replace(/\\\\/g, '\\');
  }
  return cleaned;
}

function tableCells(line: string): string[] {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let code = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\' && text[i + 1] === '|') { cell += '|'; i += 1; continue; }
    if (char === '`') code = !code;
    if (char === '|' && !code) { cells.push(cell.trim()); cell = ''; } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function tableHeader(lines: string[], index: number): boolean {
  if (!lines[index]?.includes('|') || !lines[index + 1]?.includes('|')) return false;
  const headers = tableCells(lines[index]);
  const separators = tableCells(lines[index + 1]);
  return headers.length === separators.length && separators.every(cell => /^:?-{3,}:?$/.test(cell));
}

function isSafeLink(value: string): boolean {
  return browserUrl(value) !== null;
}

function lineIndent(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === ' ') count += 1;
    else if (line[i] === '\t') count += 2;
    else break;
  }
  return count;
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || /^\s*<!--[\s\S]*?-->\s*$/.test(line)) {
      index += 1;
      continue;
    }

    if (tableHeader(lines, index)) {
      const headers = tableCells(line);
      const alignments = tableCells(lines[index + 1]).map((cell): 'left' | 'center' | 'right' => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : 'left');
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = tableCells(lines[index]);
        rows.push(headers.map((_, column) => cells[column] || ''));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows, alignments });
      continue;
    }

    const fence = line.match(/^\s*(`{3,})([^`]*)$/);
    if (fence) {
      const fenceLen = fence[1].length;
      const closingFence = new RegExp(`^\\s*\`{${fenceLen},}\\s*$`);
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !closingFence.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      const hasClosingFence = index < lines.length;
      if (hasClosingFence) index += 1;
      blocks.push({
        type: 'code',
        language: fence[2].trim() || 'text',
        closed: hasClosingFence,
        text: code.join('\n'),
      });
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ type: 'separator' });
      index += 1;
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    const standaloneImage = line.match(/^\s*!\[([^\]\n]*)\]\(([^)\n]+)\)\s*$/);
    if (standaloneImage) {
      blocks.push({
        type: 'image',
        alt: standaloneImage[1].trim(),
        src: standaloneImage[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      const alertMatch = quote[0]?.trim().match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i);
      if (alertMatch) {
        const alertType = alertMatch[1].toUpperCase() as AlertKind;
        const firstLineRest = alertMatch[2]?.trim() ? [alertMatch[2].trim()] : [];
        const bodyLines = [...firstLineRest, ...quote.slice(1)];
        blocks.push({ type: 'alert', alertType, text: bodyLines.join('\n').trim() });
      } else {
        blocks.push({ type: 'quote', text: quote.join('\n') });
      }
      continue;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const baseIndent = lineIndent(line);
      const start = ordered ? Number(ordered[2]) : undefined;
      const items: ListItem[] = [];
      let currentItem: ListItem | null = null;
      let childLines: string[] = [];

      const flushChildren = () => {
        if (!currentItem || !childLines.length) return;
        const nonEmptyIndents = childLines
          .filter(l => l.trim().length > 0)
          .map(l => lineIndent(l));
        const minIndent = nonEmptyIndents.length ? Math.min(...nonEmptyIndents) : 0;
        const dedented = childLines
          .map(l => (l.trim().length > 0 ? l.slice(Math.min(minIndent, l.length)) : ''))
          .join('\n')
          .trim();
        if (dedented) {
          currentItem.children = parseBlocks(dedented);
        }
        childLines = [];
      };

      while (index < lines.length) {
        const currentLine = lines[index];
        if (!currentLine.trim()) {
          let lookahead = index + 1;
          while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1;
          if (lookahead >= lines.length) break;
          const nextLine = lines[lookahead];
          const nextIndent = lineIndent(nextLine);
          const nextUnordered = nextLine.match(/^(\s*)[-*+]\s+(.+)$/);
          const nextOrdered = nextLine.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
          const nextSameList = isOrdered
            ? Boolean(nextOrdered && nextIndent <= baseIndent + 1)
            : Boolean(nextUnordered && nextIndent <= baseIndent + 1);
          const nextIndentedChild = currentItem !== null && nextIndent > baseIndent;
          if (nextSameList || nextIndentedChild) {
            if (childLines.length > 0) childLines.push('');
            index = lookahead;
            continue;
          }
          break;
        }

        const curIndent = lineIndent(currentLine);
        const uMatch = currentLine.match(/^(\s*)[-*+]\s+(.+)$/);
        const oMatch = currentLine.match(/^(\s*)(\d+)[.)]\s+(.+)$/);

        if (curIndent <= baseIndent + 1) {
          const itemMatch = isOrdered ? oMatch : uMatch;
          if (itemMatch) {
            flushChildren();
            currentItem = { text: isOrdered ? itemMatch[3] : itemMatch[2] };
            items.push(currentItem);
            index += 1;
            continue;
          }
          break;
        }

        if (currentItem && curIndent > baseIndent) {
          childLines.push(currentLine);
          index += 1;
          continue;
        }

        break;
      }

      flushChildren();
      blocks.push({
        type: 'list',
        items,
        ordered: isOrdered,
        ...(start !== undefined && start !== 1 ? { start } : {}),
      });
      continue;
    }

    const paragraph: string[] = [line.trimEnd()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim() || /^\s*<!--[\s\S]*?-->\s*$/.test(next)) break;
      if (tableHeader(lines, index)) break;
      if (/^\s*`{3,}/.test(next)
        || /^\s*(#{1,6})\s+/.test(next)
        || /^\s*>\s?/.test(next)
        || /^\s*[-*+]\s+/.test(next)
        || /^\s*\d+[.)]\s+/.test(next)
        || /^\s*!\[[^\]\n]*\]\([^)\n]+\)\s*$/.test(next)
        || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(next)) break;
      paragraph.push(next.trimEnd());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

interface InlineOptions {
  cwd?: string;
  workspaceId?: string;
  planId?: string;
  onLocalImageLink?: (path: string) => void;
  onLocalFileLink?: (path: string) => void;
}

function LocalMarkdownImage({
  alt,
  rawPath,
  cwd,
  workspaceId,
  planId,
  inline = false,
  onLocalImageLink,
}: {
  alt: string;
  rawPath: string;
  cwd?: string;
  workspaceId?: string;
  planId?: string;
  inline?: boolean;
  onLocalImageLink?: (path: string) => void;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const activeWorkspace = useWorkspaceStore(s => s.workspaces.find(w => w.id === s.activeWorkspaceId));
  const effectiveCwd = cwd || activeWorkspace?.path || '';
  const normalizedPath = useMemo(() => normalizeImagePath(rawPath), [rawPath]);
  const displayName = alt || normalizedPath.split(/[\\/]/).pop() || 'Image';

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError(false);

    const planningAssetMatch = /(?:^|[/\\])\.atris-plans[/\\][^/\\]+[/\\](assets[/\\][^\s?#]+)$/.exec(normalizedPath);
    const planningPath = planningAssetMatch
      ? planningAssetMatch[1].replace(/\\/g, '/')
      : (/^assets[/\\]/i.test(normalizedPath) ? normalizedPath.replace(/\\/g, '/') : undefined);

    if (workspaceId && planId && planningPath) {
      void apiRequest<{ url: string }>(`${planApi(workspaceId, planId)}/media-grant`, {
        method: 'POST',
        body: JSON.stringify({ path: planningPath }),
      })
        .then(grant => {
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

    void loadLocalImagePreviewBlob({
      cwd: effectiveCwd,
      path: normalizedPath,
    })
      .then(blob => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
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
  }, [effectiveCwd, normalizedPath, workspaceId, planId]);

  const handleClick = () => {
    if (onLocalImageLink && !url) {
      onLocalImageLink(normalizedPath);
      return;
    }
    setOpen(true);
  };

  if (inline) {
    return (
      <>
        <button
          type="button"
          onClick={handleClick}
          title={normalizedPath}
          aria-label={`Preview ${displayName}`}
          className="group my-1 inline-flex max-w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-left align-middle transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="relative flex max-h-64 min-h-20 w-full items-center justify-center overflow-hidden bg-muted/30">
            {url ? (
              <img src={url} alt={displayName} loading="lazy" className="max-h-60 max-w-full object-contain" />
            ) : error ? (
              <span className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
                <ImageIcon className="h-4 w-4 shrink-0 text-primary" />
                <span>{displayName}</span>
              </span>
            ) : (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </span>
          {url && (
            <span className="truncate px-2.5 py-1 text-xs text-muted-foreground">{displayName}</span>
          )}
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="w-[min(1100px,calc(100vw-2rem))] max-w-none gap-3 p-4 sm:max-w-none">
            <DialogTitle className="pr-8 text-sm">{displayName}</DialogTitle>
            {url ? (
              <img src={url} alt={displayName} className="mx-auto max-h-[calc(100vh-9rem)] max-w-full object-contain" />
            ) : (
              <p role="status" className="py-12 text-center text-sm text-muted-foreground">
                {error ? 'Image unavailable' : 'Loading image…'}
              </p>
            )}
            <p className="truncate text-xs text-muted-foreground select-all" title={normalizedPath}>{normalizedPath}</p>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <div className="my-2 overflow-hidden rounded-xl border border-border bg-card/80">
        <button
          type="button"
          onClick={handleClick}
          title={normalizedPath}
          aria-label={`Preview ${displayName}`}
          className="group relative flex w-full flex-col text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="relative flex max-h-[420px] min-h-36 w-full items-center justify-center overflow-hidden bg-muted/30 p-2">
            {url ? (
              <>
                <img
                  src={url}
                  alt={displayName}
                  loading="lazy"
                  className="max-h-[400px] max-w-full rounded-lg object-contain transition-transform group-hover:scale-[1.01]"
                />
                <span className="absolute bottom-2.5 right-2.5 rounded-md bg-background/85 p-1.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Maximize2 className="h-3.5 w-3.5 text-foreground" />
                </span>
              </>
            ) : error ? (
              <div className="flex flex-col items-center gap-1.5 py-6 text-center text-xs text-muted-foreground">
                <ImageIcon className="h-6 w-6 text-primary/80" />
                <span className="font-medium text-foreground">{displayName}</span>
                <span className="max-w-md truncate px-4 text-[11px]">{normalizedPath}</span>
              </div>
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
          </div>
          {url && (
            <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
              <span className="truncate text-xs font-medium text-foreground">{displayName}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {normalizedPath.split(/[\\/]/).pop()}
              </span>
            </div>
          )}
        </button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(1100px,calc(100vw-2rem))] max-w-none gap-3 p-4 sm:max-w-none">
          <DialogTitle className="pr-8 text-sm">{displayName}</DialogTitle>
          {url ? (
            <img src={url} alt={displayName} className="mx-auto max-h-[calc(100vh-9rem)] max-w-full object-contain" />
          ) : (
            <p role="status" className="py-12 text-center text-sm text-muted-foreground">
              {error ? 'Image unavailable' : 'Loading image…'}
            </p>
          )}
          <p className="truncate text-xs text-muted-foreground select-all" title={normalizedPath}>{normalizedPath}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}

function inlineNodes(text: string, keyPrefix: string, options: InlineOptions): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|(?<![\p{L}\p{N}_])__(?!\s)[^_]+(?<!\s)__(?![\p{L}\p{N}_])|\*[^*]+\*|!\[[^\]\n]*\]\((?:https?:\/\/(?:[^\s()]|\([^\s()]*\))+|(?:file:\/\/\/?)?(?:[^()\n]|\([^()\n]*\))+\.(?:png|jpe?g|webp|gif))\)|\[[^\]\n]+\]\((?:https?:\/\/(?:[^\s()]|\([^\s()]*\))+|file:\/\/\/?(?:[^\s()]|\([^\s()]*\))+|[^()\s]+\.(?:png|jpe?g|webp|gif))\)|(?<![\p{L}\p{N}_])_(?!\s)[^_]+(?<!\s)_(?![\p{L}\p{N}_])|https?:\/\/[^\s<>]+)/giu;
  const parts = text.split(pattern).filter(part => part.length > 0);

  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{part.slice(1, -1)}</code>;
    }
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong key={key} className="font-semibold text-foreground">{inlineNodes(part.slice(2, -2), key, options)}</strong>;
    }
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      return <em key={key}>{inlineNodes(part.slice(1, -1), key, options)}</em>;
    }
    if (part.startsWith('![')) {
      const imgMatch = part.match(/^!\[([^\]\n]*)\]\(([\s\S]+)\)$/);
      if (imgMatch) {
        const alt = imgMatch[1].trim();
        const target = imgMatch[2].trim();
        if (isSafeLink(target)) {
          return (
            <img
              key={key}
              src={target}
              alt={alt || 'Image'}
              loading="lazy"
              className="my-1 inline-block max-h-64 max-w-full rounded-lg border border-border object-contain"
            />
          );
        }
        return (
          <LocalMarkdownImage
            key={key}
            alt={alt}
            rawPath={target}
            cwd={options.cwd}
            workspaceId={options.workspaceId}
            planId={options.planId}
            inline
            onLocalImageLink={options.onLocalImageLink}
          />
        );
      }
    }
    const link = part.match(/^\[([^\]]+)\]\(([\s\S]+)\)$/);
    if (link) {
      const label = link[1];
      const rawTarget = link[2].trim();
      if (isSafeLink(rawTarget)) {
        return (
          <a key={key} href={rawTarget} onClick={event => { event.preventDefault(); useBrowserStore.getState().open(rawTarget); }} className="inline-flex items-center gap-1 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
            {label} <ExternalLink className="h-3 w-3" />
          </a>
        );
      }
      if (/\.(?:png|jpe?g|webp|gif)$/i.test(rawTarget)) {
        const normalizedImg = normalizeImagePath(rawTarget);
        if (options.onLocalImageLink) {
          return (
            <button key={key} type="button" onClick={() => options.onLocalImageLink!(normalizedImg)} className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {label}
            </button>
          );
        }
        return <span key={key} className="inline-flex items-center gap-1 font-medium text-primary underline decoration-primary/40 underline-offset-2">{label}</span>;
      }
      if (/^file:\/\/\/?/i.test(rawTarget)) {
        const normalizedFile = normalizeFileUri(rawTarget);
        const pillClass = 'inline-flex items-center gap-1 rounded-md border border-border/80 bg-muted/60 px-1.5 py-0.5 font-mono text-[0.86em] text-foreground transition-colors';
        if (options.onLocalFileLink) {
          return (
            <button
              key={key}
              type="button"
              title={normalizedFile}
              onClick={() => options.onLocalFileLink!(normalizedFile)}
              className={cn(pillClass, 'cursor-pointer hover:border-primary/50 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
            >
              <FileText className="h-3 w-3 shrink-0 text-primary/80" />
              <span>{label}</span>
            </button>
          );
        }
        return (
          <span key={key} title={normalizedFile} className={pillClass}>
            <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span>{label}</span>
          </span>
        );
      }
    }
    if (/^https?:\/\//i.test(part)) {
      const match = part.match(/^(.*?)([.,!?;:]*)$/);
      let href = match?.[1] || part;
      let suffix = match?.[2] || '';
      while (href.endsWith(')') && (href.match(/\)/g)?.length || 0) > (href.match(/\(/g)?.length || 0)) { href = href.slice(0, -1); suffix = `)${suffix}`; }
      if (isSafeLink(href)) return <Fragment key={key}><a href={href} onClick={event => { event.preventDefault(); useBrowserStore.getState().open(href); }} className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">{href}</a>{suffix}</Fragment>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function InlineText({ text, prefix, options }: { text: string; prefix: string; options: InlineOptions }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={`${prefix}-line-${index}`}>
          {index > 0 && <br />}
          {inlineNodes(line, `${prefix}-${index}`, options)}
        </Fragment>
      ))}
    </>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="my-3 w-full max-w-full overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 bg-zinc-900 px-3 py-1.5">
        <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-zinc-400">{language || 'text'}</span>
        <button type="button" onClick={() => void copy()} className="flex items-center justify-center rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100" title="Copy code">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre className="max-h-[34rem] overflow-auto p-3 font-mono text-[12px] leading-relaxed text-zinc-300"><code>{code}</code></pre>
    </div>
  );
}

function CarouselBlock({
  content,
  options,
}: {
  content: string;
  options: InlineOptions;
}) {
  const slides = useMemo(() => {
    const parts = content
      .split(/<!--\s*slide\s*-->/i)
      .map(slide => slide.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : [content.trim()].filter(Boolean);
  }, [content]);
  const [activeIndex, setActiveIndex] = useState(0);
  const safeIndex = Math.min(activeIndex, Math.max(0, slides.length - 1));

  if (slides.length === 0) return null;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Slide carousel"
      className="my-3 overflow-hidden rounded-xl border border-border bg-muted/20"
    >
      <div className="p-3.5">
        <MarkdownContent
          content={slides[safeIndex]}
          cwd={options.cwd}
          workspaceId={options.workspaceId}
          planId={options.planId}
          onLocalImageLink={options.onLocalImageLink}
          onLocalFileLink={options.onLocalFileLink}
        />
      </div>
      {slides.length > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-background/60 px-3 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Previous slide"
            onClick={() => setActiveIndex(current => (current - 1 + slides.length) % slides.length)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {safeIndex + 1} / {slides.length}
            </span>
            <div className="flex items-center gap-1">
              {slides.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  aria-label={`Go to slide ${idx + 1}`}
                  aria-current={idx === safeIndex ? 'true' : undefined}
                  onClick={() => setActiveIndex(idx)}
                  className={cn(
                    'h-1.5 rounded-full transition-all',
                    idx === safeIndex ? 'w-4 bg-primary' : 'w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70',
                  )}
                />
              ))}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Next slide"
            onClick={() => setActiveIndex(current => (current + 1) % slides.length)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

const ALERT_STYLES: Record<AlertKind, { label: string; icon: typeof Info; containerClass: string; headerClass: string }> = {
  NOTE: {
    label: 'Note',
    icon: Info,
    containerClass: 'border-blue-500/35 bg-blue-500/5',
    headerClass: 'text-blue-600 dark:text-blue-400',
  },
  TIP: {
    label: 'Tip',
    icon: Lightbulb,
    containerClass: 'border-emerald-500/35 bg-emerald-500/5',
    headerClass: 'text-emerald-600 dark:text-emerald-400',
  },
  IMPORTANT: {
    label: 'Important',
    icon: AlertCircle,
    containerClass: 'border-violet-500/35 bg-violet-500/5',
    headerClass: 'text-violet-600 dark:text-violet-400',
  },
  WARNING: {
    label: 'Warning',
    icon: AlertTriangle,
    containerClass: 'border-amber-500/35 bg-amber-500/5',
    headerClass: 'text-amber-600 dark:text-amber-400',
  },
  CAUTION: {
    label: 'Caution',
    icon: ShieldAlert,
    containerClass: 'border-destructive/40 bg-destructive/5',
    headerClass: 'text-destructive',
  },
};

function renderBlocks(blocks: Block[], prefix: string, options: InlineOptions): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${prefix}-${index}`;
    if (block.type === 'table') {
      return (
        <div key={key} className="my-3 max-w-full overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead className="bg-muted/60"><tr>{(block.headers || []).map((cell, column) => (
              <th key={column} scope="col" style={{ textAlign: block.alignments?.[column] }} className="border-b border-border px-3 py-2 font-semibold"><InlineText text={cell} prefix={`${key}-head-${column}`} options={options} /></th>
            ))}</tr></thead>
            <tbody>{(block.rows || []).map((row, rowIndex) => <tr key={rowIndex} className="border-b border-border/60 last:border-0">{row.map((cell, column) => (
              <td key={column} style={{ textAlign: block.alignments?.[column] }} className="max-w-sm px-3 py-2 align-top"><InlineText text={cell} prefix={`${key}-${rowIndex}-${column}`} options={options} /></td>
            ))}</tr>)}</tbody>
          </table>
        </div>
      );
    }
    if (block.type === 'code') {
      if ((block.language || '').toLowerCase() === 'carousel') {
        return <CarouselBlock key={key} content={block.text || ''} options={options} />;
      }
      if (isMermaidLanguage(block.language)) {
        return <MermaidBlock key={key} code={block.text || ''} isComplete={block.closed !== false} />;
      }
      return <CodeBlock key={key} language={block.language || 'text'} code={block.text || ''} />;
    }
    if (block.type === 'image') {
      const src = block.src || '';
      const alt = block.alt || '';
      if (isSafeLink(src)) {
        return (
          <div key={key} className="my-2 overflow-hidden rounded-xl border border-border bg-card/80 p-2">
            <img src={src} alt={alt || 'Image'} loading="lazy" className="mx-auto max-h-[400px] max-w-full rounded-lg object-contain" />
          </div>
        );
      }
      return (
        <LocalMarkdownImage
          key={key}
          alt={alt}
          rawPath={src}
          cwd={options.cwd}
          workspaceId={options.workspaceId}
          planId={options.planId}
          onLocalImageLink={options.onLocalImageLink}
        />
      );
    }
    if (block.type === 'separator') return <hr key={key} className="my-3 border-border/70" />;
    if (block.type === 'alert') {
      const kind = block.alertType || 'NOTE';
      const meta = ALERT_STYLES[kind] || ALERT_STYLES.NOTE;
      const Icon = meta.icon;
      return (
        <div key={key} role="note" aria-label={meta.label} className={cn('my-2.5 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed', meta.containerClass)}>
          <div className={cn('mb-1 flex items-center gap-1.5 font-semibold', meta.headerClass)}>
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{meta.label}</span>
          </div>
          {block.text && (
            <div className="text-foreground/90">
              <InlineText text={block.text} prefix={`${key}-alert`} options={options} />
            </div>
          )}
        </div>
      );
    }
    if (block.type === 'quote') {
      return (
        <blockquote key={key} className="border-l-2 border-primary/40 pl-3 text-foreground/75">
          <InlineText text={block.text || ''} prefix={key} options={options} />
        </blockquote>
      );
    }
    if (block.type === 'list') {
      if (block.ordered) {
        return (
          <ol key={key} start={block.start} className="list-decimal space-y-1.5 pl-5">
            {(block.items || []).map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`} className="pl-0.5 leading-relaxed marker:text-muted-foreground">
                <InlineText text={item.text} prefix={`${key}-${itemIndex}`} options={options} />
                {item.children && item.children.length > 0 && (
                  <div className="mt-1 space-y-1">
                    {renderBlocks(item.children, `${key}-${itemIndex}-child`, options)}
                  </div>
                )}
              </li>
            ))}
          </ol>
        );
      }
      return (
        <ul key={key} className="list-disc space-y-1 pl-5">
          {(block.items || []).map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`} className="pl-0.5 leading-relaxed marker:text-muted-foreground">
              <InlineText text={item.text} prefix={`${key}-${itemIndex}`} options={options} />
              {item.children && item.children.length > 0 && (
                <div className="mt-1 space-y-1">
                  {renderBlocks(item.children, `${key}-${itemIndex}-child`, options)}
                </div>
              )}
            </li>
          ))}
        </ul>
      );
    }
    if (block.type === 'heading') {
      const level = block.level || 2;
      const size = level <= 1 ? 'text-base' : level === 2 ? 'text-[15px]' : 'text-sm';
      return (
        <div key={key} className={cn('pt-1 font-semibold leading-snug text-foreground', size)}>
          <InlineText text={block.text || ''} prefix={key} options={options} />
        </div>
      );
    }
    return (
      <p key={key} className="whitespace-normal leading-relaxed text-foreground/90">
        <InlineText text={block.text || ''} prefix={key} options={options} />
      </p>
    );
  });
}

export function MarkdownContent({
  content,
  className,
  cwd,
  workspaceId,
  planId,
  onLocalImageLink,
  onLocalFileLink,
}: MarkdownContentProps) {
  const blocks = useMemo(() => parseBlocks(content), [content]);
  const options = useMemo<InlineOptions>(() => ({
    cwd,
    workspaceId,
    planId,
    onLocalImageLink,
    onLocalFileLink,
  }), [cwd, workspaceId, planId, onLocalImageLink, onLocalFileLink]);

  return (
    <div className={cn('min-w-0 space-y-2.5 break-words', className)}>
      {renderBlocks(blocks, 'block', options)}
    </div>
  );
}
