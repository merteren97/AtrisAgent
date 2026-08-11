import { Fragment, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };

  return (
    <div className="my-3 w-full max-w-full overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 bg-zinc-900 px-3 py-1.5">
        <span className="text-[10px] font-mono font-medium uppercase tracking-wider text-zinc-400">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex items-center justify-center rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
          title="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-3 text-[12px] leading-relaxed text-zinc-300"><code>{code}</code></pre>
    </div>
  );
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  const parts = text.split(tokenPattern).filter((part) => part.length > 0);

  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground">{part.slice(1, -1)}</code>;
    }
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong key={key} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('~~') && part.endsWith('~~')) {
      return <del key={key}>{part.slice(2, -2)}</del>;
    }
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer" className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
          {link[1]}
        </a>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(line)
    || /^>\s?/.test(line)
    || /^[-*+]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || /^(---|\*\*\*|___)$/.test(trimmed)
    || line.startsWith('```');
}

export function MarkdownContent({ content, className }: { content: string; className?: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<CodeBlock key={`code-${index}`} language={language} code={code.join('\n')} />);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const headingClass = level === 1
        ? 'mt-4 text-lg font-semibold tracking-tight'
        : level === 2
          ? 'mt-4 text-base font-semibold tracking-tight'
          : 'mt-3 text-sm font-semibold';
      blocks.push(
        <div key={`heading-${index}`} role="heading" aria-level={level} className={cn(headingClass, 'mb-1 text-foreground')}>
          {renderInline(heading[2], `heading-${index}`)}
        </div>,
      );
      index += 1;
      continue;
    }

    if (/^(---|\*\*\*|___)$/.test(line.trim())) {
      blocks.push(<hr key={`rule-${index}`} className="my-4 border-border/70" />);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`} className="my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground">
          {quote.map((item, quoteIndex) => <div key={quoteIndex}>{renderInline(item, `quote-${index}-${quoteIndex}`)}</div>)}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`} className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `ul-${index}-${itemIndex}`)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item, `ol-${index}-${itemIndex}`)}</li>)}
        </ol>,
      );
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`} className="my-1.5 whitespace-pre-wrap break-words leading-relaxed">
        {paragraph.map((item, paragraphIndex) => (
          <Fragment key={paragraphIndex}>
            {paragraphIndex > 0 && <br />}
            {renderInline(item, `paragraph-${index}-${paragraphIndex}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className={cn('min-w-0 max-w-full text-sm text-foreground/90', className)}>{blocks}</div>;
}
