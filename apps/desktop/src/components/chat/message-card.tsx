import { User, Sparkles, Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';

function CodeBlock({ language, code }: { language: string, code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-border/50 bg-zinc-950 shadow-sm w-full max-w-full">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-white/10">
        <span className="text-[10px] font-mono font-medium text-zinc-400 uppercase tracking-wider">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="p-1.5 hover:bg-white/10 rounded-md transition-colors flex items-center justify-center text-zinc-400 hover:text-zinc-100"
          title="Copy code"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
      <div className="p-3 overflow-x-auto text-[13px] font-mono text-zinc-300 leading-relaxed bg-zinc-950">
        <pre className="!my-0"><code>{code}</code></pre>
      </div>
    </div>
  );
}

interface MessageCardProps {
  role: 'user' | 'orchestrator';
  content: string;
  timestamp: string;
}

export function MessageCard({ role, content, timestamp }: MessageCardProps) {
  const isUser = role === 'user';

  const renderContent = (text: string) => {
    const parts = text.split(/(```[\w]*\n[\s\S]*?```)/g);
    
    return parts.map((part, index) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        const lines = part.split('\n');
        const langMatch = lines[0].match(/```(\w*)/);
        const language = langMatch && langMatch[1] ? langMatch[1] : 'text';
        const code = lines.slice(1, -1).join('\n');
        return <CodeBlock key={index} language={language} code={code} />;
      }
      return <span key={index} className="whitespace-pre-wrap break-words">{part}</span>;
    });
  };

  return (
    <div className={cn("flex gap-3 w-full py-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/10 flex items-center justify-center shrink-0 mt-1 shadow-sm">
          <Sparkles className="w-4 h-4 text-primary" />
        </div>
      )}
      
      <div className={cn(
        "flex flex-col gap-1 max-w-[85%] overflow-hidden",
        isUser ? "items-end" : "items-start"
      )}>
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs font-semibold text-foreground/80">{isUser ? 'You' : 'Orchestrator'}</span>
          <span className="text-[10px] text-muted-foreground">{timestamp}</span>
        </div>
        <div className={cn(
          "px-4 py-2.5 text-sm leading-relaxed shadow-sm w-full",
          isUser 
            ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-sm" 
            : "bg-card border border-border/50 rounded-2xl rounded-tl-sm text-foreground/90"
        )}>
          {renderContent(content)}
        </div>
      </div>
      
      {isUser && (
        <div className="w-8 h-8 rounded-xl bg-secondary border border-border/50 flex items-center justify-center shrink-0 mt-1 shadow-sm">
          <User className="w-4 h-4 text-secondary-foreground" />
        </div>
      )}
    </div>
  );
}
