import { useState, useRef } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { useMissionStore } from '@/stores/mission-store';
import { useAccountStore } from '@/stores/account-store';
import { getApiOrigin } from '@/lib/api-client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { X, Activity, Terminal, Settings2, Network, Cpu, CheckCircle2, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

const RUNTIME_EVENT_TYPES = new Set([
  'agent_spawned', 'agent_started', 'agent_progressed', 'agent_waiting', 'agent_resumed',
  'agent_completed', 'agent_error', 'agent_thought', 'agent_tool_call', 'text_delta',
  'tool_call_started', 'tool_call_completed', 'task_completed', 'task_failed', 'file_changed',
]);

export function DeveloperConsole() {
  const { devMode, toggleDevMode } = useSettingsStore();
  const { timeline } = useMissionStore();
  const { runtimes, serviceOnline } = useAccountStore();
  const [filter, setFilter] = useState('');
  const [activeTab, setActiveTab] = useState('events');
  const scrollRef = useRef<HTMLDivElement>(null);

  if (!devMode) return null;

  const filteredEvents = timeline.filter(e =>
    !filter || e.content.toLowerCase().includes(filter.toLowerCase()) ||
    (e.eventType || '').toLowerCase().includes(filter.toLowerCase())
  );
  const runtimeEvents = timeline.filter((event) => RUNTIME_EVENT_TYPES.has(event.eventType || ''));
  const mcpEvents = timeline.filter(e =>
    e.eventType?.includes('tool') || e.eventType?.includes('mcp') || (e.metadata && 'toolName' in e.metadata)
  );

  return (
    <div className="h-[300px] border-t border-border bg-card flex flex-col shrink-0 shadow-2xl z-40 select-none">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-semibold">Developer Mode Console & Diagnostics</span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">{timeline.length} raw events</Badge>
        </div>
        <Button variant="ghost" size="icon" className="h-5 w-5 cursor-pointer" onClick={toggleDevMode}>
          <X className="w-3 h-3" />
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="h-7 px-2 justify-start bg-transparent border-b border-border rounded-none gap-1">
          <TabsTrigger value="events" className="text-[11px] h-6 px-2.5 cursor-pointer"><Activity className="w-3 h-3 mr-1 text-primary" />Raw Events ({timeline.length})</TabsTrigger>
          <TabsTrigger value="process" className="text-[11px] h-6 px-2.5 cursor-pointer"><Terminal className="w-3 h-3 mr-1 text-blue-400" />Runtime Stream ({runtimeEvents.length})</TabsTrigger>
          <TabsTrigger value="mcp" className="text-[11px] h-6 px-2.5 cursor-pointer"><Network className="w-3 h-3 mr-1 text-indigo-400" />MCP Calls ({mcpEvents.length})</TabsTrigger>
          <TabsTrigger value="environment" className="text-[11px] h-6 px-2.5 cursor-pointer"><Settings2 className="w-3 h-3 mr-1 text-emerald-400" />Environment & Diagnostics</TabsTrigger>
        </TabsList>

        <TabsContent value="events" className="flex-1 overflow-hidden flex flex-col m-0 p-0">
          <div className="px-2 py-1 border-b border-border bg-muted/10">
            <Input placeholder="Filter raw event log stream..." value={filter} onChange={e => setFilter(e.target.value)}
              className="h-6 text-xs bg-transparent border-none focus-visible:ring-0 px-1 font-mono" />
          </div>
          <ScrollArea className="flex-1" ref={scrollRef}>
            <div className="p-2 space-y-0.5 font-mono text-[11px]">
              {filteredEvents.map(event => (
                <div key={event.id} className="flex items-start gap-2 py-0.5 hover:bg-muted/50 px-1.5 rounded border border-transparent hover:border-border/30 transition-colors">
                  <span className="text-muted-foreground shrink-0 w-16">{event.timestamp}</span>
                  <Badge variant="outline" className={cn('text-[9px] px-1 py-0 shrink-0 font-mono uppercase',
                    event.eventType === 'mission_started' && 'border-primary text-primary',
                    event.eventType === 'task_completed' && 'border-green-500 text-green-500',
                    event.eventType === 'task_failed' && 'border-destructive text-destructive',
                    event.eventType === 'mission_failed' && 'border-destructive text-destructive',
                  )}>{event.eventType || event.type}</Badge>
                  <span className="text-foreground/80 truncate flex-1">{event.content}</span>
                  {event.agentRole && <Badge variant="secondary" className="text-[8px] py-0 h-3 px-1">{event.agentRole}</Badge>}
                </div>
              ))}
              {filteredEvents.length === 0 && <div className="text-muted-foreground text-center py-6 text-xs font-mono">No raw events emitted yet</div>}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="process" className="flex-1 m-0 p-0">
          <ScrollArea className="h-full">
            <div className="p-3 font-mono text-[11px] space-y-2">
              <div className="text-muted-foreground text-xs font-sans mb-2">
                Parsed runtime/agent events observed from the authenticated local event stream. This view does not claim to be raw child-process stdout/stderr.
              </div>
              <div className="bg-zinc-950 p-3 rounded-lg border border-white/10 text-zinc-300 space-y-1.5 leading-relaxed">
                <div className={serviceOnline ? 'text-emerald-400' : 'text-rose-400'}>[SYSTEM] Local API {serviceOnline ? `reachable at ${getApiOrigin()}` : `unreachable at ${getApiOrigin()} · recovery supervisor active`}</div>
                {runtimeEvents.map((event) => {
                  const metadata = event.metadata as Record<string, unknown> | undefined;
                  const agentId = typeof metadata?.agentInstanceId === 'string' ? metadata.agentInstanceId.slice(0, 8) : '--------';
                  return (
                    <div key={event.id} className="text-zinc-400 font-mono">
                      <span className="text-zinc-600">[{event.timestamp}]</span>{' '}
                      <span className="text-indigo-300">[{(event.eventType || event.type).toUpperCase()}]</span>{' '}
                      <span className="text-zinc-500">[{agentId}]</span>{' '}
                      <span className="text-zinc-200 whitespace-pre-wrap break-words">{event.content}</span>
                    </div>
                  );
                })}
                {runtimeEvents.length === 0 && <div className="text-zinc-500">No runtime events observed for the active mission yet.</div>}
              </div>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="mcp" className="flex-1 m-0 p-0">
          <ScrollArea className="h-full">
            <div className="p-3 font-mono text-[11px] space-y-2">
              <div className="text-muted-foreground text-xs font-sans mb-1">MCP Tools & Resource Leases Stream:</div>
              {mcpEvents.length > 0 ? (
                mcpEvents.map((mcp, idx) => (
                  <div key={idx} className="p-2 rounded bg-muted/30 border border-border/50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Network className="w-3.5 h-3.5 text-indigo-400" />
                      <span className="font-semibold text-foreground">{mcp.eventType || 'tool_call'}</span>
                      <span className="text-muted-foreground text-[10px] truncate">{mcp.content}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{mcp.timestamp}</span>
                  </div>
                ))
              ) : (
                <div className="p-4 border border-dashed rounded text-center text-muted-foreground text-xs">
                  No MCP or tool-call events have been emitted for the active mission. This panel only reports observed events; it does not assume that a coordination server is attached.
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="environment" className="flex-1 m-0 p-0">
          <ScrollArea className="h-full">
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 font-sans text-xs">
              <Card className="p-3 bg-muted/20 border-border space-y-2">
                <div className="flex items-center gap-2 text-primary font-semibold"><Cpu className="w-4 h-4" />Runtime Diagnostic Card</div>
                <div className="space-y-1 font-mono text-[11px]">
                  <div className="flex justify-between border-b border-border/40 pb-1"><span className="text-muted-foreground">Tauri Framework:</span><span className="text-foreground font-semibold">Tauri 2 desktop shell</span></div>
                  <div className="flex justify-between border-b border-border/40 pb-1">
                    <span className="text-muted-foreground">Local API Gateway:</span>
                    <span className={cn('font-semibold flex items-center gap-1', serviceOnline ? 'text-emerald-500' : 'text-rose-400')}><CheckCircle2 className="w-3 h-3" /> {serviceOnline ? getApiOrigin() : `Offline · ${getApiOrigin()}`}</span>
                  </div>
                  <div className="flex justify-between border-b border-border/40 pb-1"><span className="text-muted-foreground">SQLite Storage:</span><span className="text-foreground font-semibold">%APPDATA%/AtrisAgent/atris.db</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Security Policy:</span><span className="text-indigo-400 font-semibold flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Path Traversal Active</span></div>
                </div>
              </Card>

              <Card className="p-3 bg-muted/20 border-border space-y-2">
                <div className="flex items-center gap-2 text-foreground font-semibold"><Terminal className="w-4 h-4 text-blue-500" />Detected CLI Runtimes</div>
                <div className="space-y-1.5 font-mono text-[11px]">
                  {runtimes.map((runtime) => (
                    <div key={runtime.runtimeType} className="flex items-center justify-between p-1 rounded bg-background/50 border border-border/40">
                      <span className="font-semibold uppercase">{runtime.name}</span>
                      <Badge variant="outline" className={cn('text-[9px] py-0 h-4', runtime.installation.installed ? 'text-emerald-500 border-emerald-500/30' : 'text-muted-foreground')}>
                        {runtime.installation.installed ? runtime.installation.version || 'INSTALLED' : 'NOT FOUND'}
                      </Badge>
                    </div>
                  ))}
                  {!runtimes.length && <div className="text-muted-foreground">Runtime scan has not completed.</div>}
                </div>
              </Card>
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
