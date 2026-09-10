import { useEffect, useState } from 'react';
import { Check, Circle, Loader2, AlertCircle, Trash2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { NavigationDeleteAction } from '@/components/layout/navigation-row-actions';
import { type ManualConversation } from '@/stores/manual-store';
import { conversationActivity, useManualActivity } from './manual-activity';

export function ManualConversationRow({ conversation, active, onSelect, onDelete }: { conversation: ManualConversation; active: boolean; onSelect: () => void; onDelete?: () => void }) {
  const observations = useManualActivity(state => state.agents);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, []);
  const status = conversationActivity(conversation.agents, observations, now);
  const Icon = status.kind === 'working' ? Loader2 : status.kind === 'completed' ? Check : status.kind === 'attention' ? AlertCircle : Circle;
  const color = status.kind === 'working' ? 'text-primary' : status.kind === 'completed' ? 'text-emerald-500' : status.kind === 'attention' ? 'text-amber-500' : 'text-sidebar-muted';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="navigation-row mb-1 flex items-center rounded-lg hover:bg-sidebar-accent" data-active={active}>
          <button type="button" aria-current={active ? 'page' : undefined} onClick={onSelect}
            title={`${conversation.title} · ${status.text} · ${conversation.agents.length} agents`}
            className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sidebar-foreground">
            <Icon className={`h-3.5 w-3.5 shrink-0 ${color} ${status.kind === 'working' ? 'motion-safe:animate-spin' : ''}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs">{conversation.title}</span>
              <span className={`mt-0.5 block truncate text-[11px] ${color}`}>{status.text}</span>
            </span>
          </button>
          {onDelete && <NavigationDeleteAction label={`Delete conversation: ${conversation.title}`} onClick={onDelete} />}
        </div>
      </ContextMenuTrigger>
      {onDelete && <ContextMenuContent><ContextMenuItem variant="destructive" onSelect={onDelete}><Trash2 className="h-3.5 w-3.5" />Delete conversation…</ContextMenuItem></ContextMenuContent>}
    </ContextMenu>
  );
}
