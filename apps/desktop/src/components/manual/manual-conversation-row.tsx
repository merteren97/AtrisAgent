import { useEffect, useState } from 'react';
import { Check, Circle, Loader2, AlertCircle } from 'lucide-react';
import { type ManualConversation } from '@/stores/manual-store';
import { conversationActivity, useManualActivity } from './manual-activity';

export function ManualConversationRow({ conversation, active, onSelect }: { conversation: ManualConversation; active: boolean; onSelect: () => void }) {
  const observations = useManualActivity(state => state.agents);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, []);
  const status = conversationActivity(conversation.agents, observations, now);
  const Icon = status.kind === 'working' ? Loader2 : status.kind === 'completed' ? Check : status.kind === 'attention' ? AlertCircle : Circle;
  const color = status.kind === 'working' ? 'text-primary' : status.kind === 'completed' ? 'text-emerald-500' : status.kind === 'attention' ? 'text-amber-500' : 'text-sidebar-muted';
  return <button type="button" aria-current={active ? 'page' : undefined} onClick={onSelect} title={`${conversation.title} · ${status.text}`} className={`mb-1 flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors ${active ? 'bg-primary/10 text-sidebar-foreground' : 'text-sidebar-muted hover:bg-sidebar-accent'}`}>
    <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${color} ${status.kind === 'working' ? 'motion-safe:animate-spin' : ''}`} />
    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{conversation.title}</span><span className={`mt-1 block truncate text-[11px] ${color}`}>{status.text}</span></span>
    <span className="mt-0.5 text-[10px] tabular-nums text-sidebar-muted" aria-label={`${conversation.agents.length} agents`}>{conversation.agents.length}</span>
  </button>;
}
