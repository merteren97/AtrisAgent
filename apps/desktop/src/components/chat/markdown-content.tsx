import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { browserUrl, useBrowserStore } from '@/stores/browser-store';

interface MarkdownContentProps {
  content: string;
  className?: string;
  onLocalImageLink?: (path: string) => void;
}

interface Block {
  type: 'paragraph' | 'heading' | 'code' | 'quote' | 'list' | 'separator' | 'table';
  level?: number;
  language?: string;
  text?: string;
  items?: string[];
  ordered?: boolean;
  headers?: string[];
  rows?: string[][];
  alignments?: Array<'left' | 'center' | 'right'>;
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

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
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

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1].trim() || 'text', text: code.join('\n') });
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

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const items: string[] = [];
      const isOrdered = Boolean(ordered);
      const matcher = isOrdered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const match = lines[index].match(matcher);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ type: 'list', items, ordered: isOrdered });
      continue;
    }

    const paragraph: string[] = [line.trimEnd()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim()) break;
      if (tableHeader(lines, index)) break;
      if (/^\s*```/.test(next)
        || /^\s*(#{1,6})\s+/.test(next)
        || /^\s*>\s?/.test(next)
        || /^\s*[-*+]\s+/.test(next)
        || /^\s*\d+[.)]\s+/.test(next)
        || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(next)) break;
      paragraph.push(next.trimEnd());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

function inlineNodes(text: string, keyPrefix: string, onLocalImageLink?: (path: string) => void): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|!?\[[^\]]+\]\((?:https?:\/\/(?:[^\s()]|\([^\s()]*\))+|[^()\s]+\.(?:png|jpe?g|webp|gif))\)|https?:\/\/[^\s<>]+)/gi;
  const parts = text.split(pattern).filter((part) => part.length > 0);

  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{part.slice(1, -1)}</code>;
    }
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong key={key} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = part.match(/^!?\[([^\]]+)\]\(([^\s]+)\)$/);
    if (link && isSafeLink(link[2])) {
      return (
        <a key={key} href={link[2]} onClick={event => {event.preventDefault();useBrowserStore.getState().open(link[2]);}} className="inline-flex items-center gap-1 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
          {link[1]} <ExternalLink className="h-3 w-3" />
        </a>
      );
    }
    if (/^https?:\/\//i.test(part)) {
      const match = part.match(/^(.*?)([.,!?;:]*)$/);
      let href = match?.[1] || part;
      let suffix = match?.[2] || '';
      while (href.endsWith(')') && (href.match(/\)/g)?.length || 0) > (href.match(/\(/g)?.length || 0)) { href = href.slice(0,-1); suffix = `)${suffix}`; }
      if (isSafeLink(href)) return <Fragment key={key}><a href={href} onClick={event => {event.preventDefault();useBrowserStore.getState().open(href);}} className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">{href}</a>{suffix}</Fragment>;
    }
    if (link && onLocalImageLink && /\.(?:png|jpe?g|webp|gif)$/i.test(link[2])) {
      return <button key={key} type="button" onClick={() => onLocalImageLink(link[2])} className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{link[1]}</button>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function InlineText({ text, prefix, onLocalImageLink }: { text: string; prefix: string; onLocalImageLink?: (path: string) => void }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={`${prefix}-line-${index}`}>
          {index > 0 && <br />}
          {inlineNodes(line, `${prefix}-${index}`, onLocalImageLink)}
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

export function MarkdownContent({ content, className, onLocalImageLink }: MarkdownContentProps) {
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <div className={cn('min-w-0 space-y-2.5 break-words', className)}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        if (block.type === 'table') {
          return (
            <div key={key} className="my-3 max-w-full overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-max border-collapse text-sm">
                <thead className="bg-muted/60"><tr>{(block.headers || []).map((cell, column) => (
                  <th key={column} scope="col" style={{ textAlign: block.alignments?.[column] }} className="border-b border-border px-3 py-2 font-semibold"><InlineText text={cell} prefix={`${key}-head-${column}`} onLocalImageLink={onLocalImageLink} /></th>
                ))}</tr></thead>
                <tbody>{(block.rows || []).map((row, rowIndex) => <tr key={rowIndex} className="border-b border-border/60 last:border-0">{row.map((cell, column) => (
                  <td key={column} style={{ textAlign: block.alignments?.[column] }} className="max-w-sm px-3 py-2 align-top"><InlineText text={cell} prefix={`${key}-${rowIndex}-${column}`} onLocalImageLink={onLocalImageLink} /></td>
                ))}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'code') return <CodeBlock key={key} language={block.language || 'text'} code={block.text || ''} />;
        if (block.type === 'separator') return <hr key={key} className="my-3 border-border/70" />;
        if (block.type === 'quote') {
          return (
            <blockquote key={key} className="border-l-2 border-primary/40 pl-3 text-foreground/75">
              <InlineText text={block.text || ''} prefix={key} onLocalImageLink={onLocalImageLink} />
            </blockquote>
          );
        }
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={key} className={cn('space-y-1 pl-5', block.ordered ? 'list-decimal' : 'list-disc')}>
              {(block.items || []).map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`} className="pl-0.5 leading-relaxed marker:text-muted-foreground">
                  <InlineText text={item} prefix={`${key}-${itemIndex}`} onLocalImageLink={onLocalImageLink} />
                </li>
              ))}
            </List>
          );
        }
        if (block.type === 'heading') {
          const level = block.level || 2;
          const size = level <= 1 ? 'text-base' : level === 2 ? 'text-[15px]' : 'text-sm';
          return (
            <div key={key} className={cn('pt-1 font-semibold leading-snug text-foreground', size)}>
              <InlineText text={block.text || ''} prefix={key} onLocalImageLink={onLocalImageLink} />
            </div>
          );
        }
        return (
          <p key={key} className="whitespace-normal leading-relaxed text-foreground/90">
            <InlineText text={block.text || ''} prefix={key} onLocalImageLink={onLocalImageLink} />
          </p>
        );
      })}
    </div>
  );
}
