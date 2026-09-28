import { useEffect, useState } from 'react';
import { Check, Circle, Loader2, AlertCircle } from 'lucide-react';
import { NavigationRowActions } from '@/components/layout/navigation-row-actions';
import { type ManualConversation } from '@/stores/manual-store';
import { activityNotice, conversationActivity, useManualActivity } from './manual-activity';
import { useManualStore } from '@/stores/manual-store';

export function ManualConversationRow({ conversation, active, onSelect, onRename, onDelete }: { conversation: ManualConversation; active: boolean; onSelect: () => void; onRename: () => void; onDelete: () => void }) {
  const observations = useManualActivity(state => state.agents);
  const acknowledged = useManualStore(state => state.acknowledgedActivity);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, []);
  const status = conversationActivity(conversation.agents, observations, now);
  const notices = conversation.agents.map(agent => activityNotice(observations[agent.id], acknowledged[agent.id], now));
  const questions = notices.filter(kind => kind === 'attention').length;
  const finished = notices.filter(kind => kind === 'completed').length;
  const notification = questions ? `${questions} need attention` : finished ? `${finished} finished` : null;
  const Icon = status.kind === 'working' ? Loader2 : status.kind === 'completed' ? Check : status.kind === 'attention' ? AlertCircle : Circle;
  const color = status.kind === 'working' ? 'text-primary' : status.kind === 'completed' ? 'text-emerald-500' : status.kind === 'attention' ? 'text-amber-500' : 'text-sidebar-muted';
  return (
    <div className="navigation-row mb-1 flex items-center rounded-lg hover:bg-sidebar-accent" data-active={active}>
          <button type="button" aria-current={active ? 'page' : undefined} onClick={onSelect}
             title={`${conversation.title} · ${notification || status.text} · ${conversation.agents.length} agents`}
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sidebar-foreground">
             {questions ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" /> : finished ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <Icon className={`h-3.5 w-3.5 shrink-0 ${color} ${status.kind === 'working' ? 'motion-safe:animate-spin' : ''}`} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs">{conversation.title}</span>
               <span className={`mt-0.5 block truncate text-[11px] ${questions ? 'text-amber-500' : finished ? 'text-emerald-500' : color}`}>{notification || status.text}</span>
            </span>
          </button>
          <NavigationRowActions name={conversation.title} onRename={onRename} onDelete={onDelete} deleteLabel="Delete conversation…" />
    </div>
  );
}
