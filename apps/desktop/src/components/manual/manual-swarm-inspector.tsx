import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Check, ChevronRight, Loader2, MessageSquareText, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { fetchSubagentMessages, fetchSwarmBoard } from '@/lib/api-client';
import type {
  ManualChatSnapshot,
  ManualSwarmBoardMessage,
  ManualSwarmMember,
  ManualSwarmSummary,
} from '@/stores/manual-store';
import { ManualChatContent } from './manual-chat-content';

export interface SwarmInspectorTarget {
  conversationId: string;
  label: string;
}

export type SwarmInspectorTab = 'overview' | 'board' | 'transcript';

function MemberStatusBadge({ member }: { member: ManualSwarmMember }) {
  if (member.state === 'working') {
    return (
      <Badge variant="outline" className="border-primary/40 bg-primary/10 text-[10px] text-primary">
        <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
        Working
      </Badge>
    );
  }
  if (member.state === 'waiting' && member.completedSignaled) {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400">
        <Check className="mr-1 h-2.5 w-2.5" />
        Done
      </Badge>
    );
  }
  if (member.state === 'waiting') {
    return (
      <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-400">
        Waiting
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      {member.state === 'killed' ? 'Killed' : 'Stopped'}
    </Badge>
  );
}

function formatBoardText(text: string) {
  const parts = text.split(/(@[a-z0-9_-]+)/gi);
  return parts.map((part, idx) =>
    part.startsWith('@') ? (
      <span key={idx} className="rounded bg-primary/15 px-1 font-medium text-primary">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function ManualSwarmInspector({
  open,
  onOpenChange,
  agentId,
  cwd,
  swarm,
  tab,
  onTabChange,
  transcriptStack,
  onSelectTranscript,
  onPushTranscript,
  onPopTranscript,
  onJumpTranscriptStack,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  cwd: string;
  swarm: ManualSwarmSummary;
  tab: SwarmInspectorTab;
  onTabChange: (tab: SwarmInspectorTab) => void;
  transcriptStack: SwarmInspectorTarget[];
  onSelectTranscript: (target: SwarmInspectorTarget) => void;
  onPushTranscript: (target: SwarmInspectorTarget) => void;
  onPopTranscript: () => void;
  onJumpTranscriptStack: (index: number) => void;
}) {
  const [boardMessages, setBoardMessages] = useState<ManualSwarmBoardMessage[]>([]);
  const [boardHasMore, setBoardHasMore] = useState(false);
  const [boardOldestSeq, setBoardOldestSeq] = useState<number | undefined>();
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  const [transcriptSnapshot, setTranscriptSnapshot] = useState<ManualChatSnapshot | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const lastRevisionRef = useRef<string | undefined>(undefined);
  const anchorRef = useRef<string | undefined>(undefined);

  const activeTarget = transcriptStack[transcriptStack.length - 1];

  const loadBoard = useCallback(async (beforeSeq?: number) => {
    setBoardLoading(true);
    setBoardError(null);
    try {
      const response = await fetchSwarmBoard(agentId, beforeSeq, 50);
      setBoardMessages((prev) => {
        if (beforeSeq === undefined) return response.messages;
        const seen = new Set(response.messages.map((m) => m.seq));
        return [...response.messages, ...prev.filter((m) => !seen.has(m.seq))];
      });
      setBoardHasMore(response.hasMore);
      setBoardOldestSeq(response.oldestSeq);
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : String(error));
    } finally {
      setBoardLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!open || tab !== 'board') return;
    void loadBoard();
  }, [open, tab, swarm.latestBoardSeq, loadBoard]);

  useEffect(() => {
    lastRevisionRef.current = undefined;
    anchorRef.current = undefined;
    setTranscriptSnapshot(null);
    setTranscriptError(null);
    if (!open || tab !== 'transcript' || !activeTarget) return;

    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;

    const poll = async () => {
      if (disposed || abort.signal.aborted) return;
      if (!lastRevisionRef.current) setTranscriptLoading(true);
      try {
        const result = await fetchSubagentMessages(agentId, activeTarget.conversationId, {
          anchor: anchorRef.current,
          known: lastRevisionRef.current,
          signal: abort.signal,
        });
        if (disposed || abort.signal.aborted) return;
        if (result.messages !== undefined) {
          lastRevisionRef.current = result.revision;
          setTranscriptSnapshot(result);
        }
        setTranscriptError(null);
      } catch (error) {
        if (!disposed && !abort.signal.aborted) {
          setTranscriptError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!disposed) {
          setTranscriptLoading(false);
          timer = setTimeout(() => void poll(), 1_500);
        }
      }
    };

    void poll();
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [open, tab, agentId, activeTarget?.conversationId]);

  const loadOlderTranscript = async () => {
    if (!activeTarget || !transcriptSnapshot?.hasOlder) return;
    const anchor = transcriptSnapshot.messages[0]?.id;
    if (!anchor) return;
    setTranscriptLoading(true);
    try {
      const result = await fetchSubagentMessages(agentId, activeTarget.conversationId, {
        anchor,
        older: true,
      });
      if (result.messages !== undefined) {
        anchorRef.current = result.messages[0]?.id ?? anchor;
        lastRevisionRef.current = result.revision;
        setTranscriptSnapshot(result);
      }
    } catch (error) {
      setTranscriptError(error instanceof Error ? error.message : String(error));
    } finally {
      setTranscriptLoading(false);
    }
  };

  const memberByName = new Map(swarm.members.map((m) => [m.name, m]));
  const threadedMembers = new Set((swarm.threads || []).flatMap((t) => t.tasks));
  const ungroupedMembers = swarm.members.filter((m) => !threadedMembers.has(m.name));
  const standaloneSubagents = swarm.subagents.filter(
    (s) => !swarm.members.some((m) => m.conversationId === s.conversationId),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[82vh] w-[min(1024px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <DialogTitle className="flex items-center gap-2 pr-8 text-base">
            <Users className="h-4 w-4 text-primary" />
            <span className="truncate">{swarm.title || swarm.goal?.title || 'Swarm & Subagents'}</span>
          </DialogTitle>
          {swarm.goal?.line && (
            <DialogDescription className="truncate text-xs">{swarm.goal.line}</DialogDescription>
          )}
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as SwarmInspectorTab)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="shrink-0 border-b border-border/70 px-6 py-2">
            <TabsList>
              <TabsTrigger value="overview">Overview & Roster</TabsTrigger>
              <TabsTrigger value="board">Board Feed ({swarm.totalBoardCount})</TabsTrigger>
              <TabsTrigger value="transcript" disabled={!activeTarget}>
                {activeTarget ? `Worker: ${activeTarget.label}` : 'Worker Transcript'}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full px-6 py-4">
              <div className="space-y-5">
                {swarm.threads && swarm.threads.length > 0 && (
                  <div className="space-y-3">
                    <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Workstreams
                    </h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      {swarm.threads.map((thread) => (
                        <div key={thread.id} className="rounded-xl border border-border/80 bg-card/70 p-3.5">
                          <div className="text-sm font-medium text-foreground">{thread.title}</div>
                          {thread.goal && (
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{thread.goal}</p>
                          )}
                          <div className="mt-3 space-y-2">
                            {thread.tasks.map((memberName) => {
                              const member = memberByName.get(memberName);
                              if (!member) return null;
                              return (
                                <div
                                  key={member.name}
                                  className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-2 text-xs"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="truncate font-medium text-foreground">{member.name}</span>
                                      {member.model && (
                                        <span className="truncate text-[10px] text-muted-foreground">{member.model}</span>
                                      )}
                                    </div>
                                    {member.task && (
                                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                        {member.task}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <MemberStatusBadge member={member} />
                                    {member.role !== 'coordinator' && (
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 px-2 text-[11px]"
                                        onClick={() => onSelectTranscript({ conversationId: member.conversationId, label: member.name })}
                                      >
                                        Inspect
                                        <ArrowRight className="ml-1 h-3 w-3" />
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {ungroupedMembers.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Members
                    </h3>
                    <div className="space-y-2">
                      {ungroupedMembers.map((member) => (
                        <div
                          key={member.name}
                          className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/70 px-3.5 py-2.5 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-foreground">{member.name}</span>
                              {member.role === 'coordinator' && (
                                <Badge variant="secondary" className="text-[10px]">Coordinator</Badge>
                              )}
                              {member.model && (
                                <span className="text-[11px] text-muted-foreground">{member.model}</span>
                              )}
                              {member.workspaceMode && (
                                <span className="text-[10px] text-muted-foreground">· {member.workspaceMode}</span>
                              )}
                            </div>
                            {member.task && (
                              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{member.task}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <MemberStatusBadge member={member} />
                            {member.role !== 'coordinator' && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2.5 text-xs"
                                onClick={() => onSelectTranscript({ conversationId: member.conversationId, label: member.name })}
                              >
                                Inspect
                                <ArrowRight className="ml-1 h-3 w-3" />
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {standaloneSubagents.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Subagents
                    </h3>
                    <div className="space-y-2">
                      {standaloneSubagents.map((sub) => (
                        <div
                          key={sub.conversationId}
                          className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/70 px-3.5 py-2.5 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
                            <span className="truncate font-medium text-foreground">{sub.role}</span>
                            {sub.typeName && (
                              <Badge variant="outline" className="text-[10px]">{sub.typeName}</Badge>
                            )}
                            {sub.model && (
                              <span className="text-[11px] text-muted-foreground">{sub.model}</span>
                            )}
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 shrink-0 px-2.5 text-xs"
                            onClick={() => onSelectTranscript({ conversationId: sub.conversationId, label: sub.role })}
                          >
                            Inspect
                            <ArrowRight className="ml-1 h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="board" className="min-h-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full px-6 py-4">
              <div className="space-y-3">
                {boardHasMore && (
                  <div className="flex justify-center">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={boardLoading}
                      onClick={() => void loadBoard(boardOldestSeq)}
                    >
                      {boardLoading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                      Load older messages
                    </Button>
                  </div>
                )}
                {boardError && (
                  <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {boardError}
                  </p>
                )}
                {!boardMessages.length && !boardLoading && !boardError && (
                  <div className="flex flex-col items-center justify-center py-12 text-xs text-muted-foreground">
                    <MessageSquareText className="mb-2 h-6 w-6 opacity-60" />
                    No board messages recorded yet.
                  </div>
                )}
                {boardMessages.map((msg) => {
                  const isDone = /\[done\]/i.test(msg.text);
                  return (
                    <div key={msg.seq} className="rounded-xl border border-border/70 bg-card/70 p-3.5 text-xs">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">#{msg.seq}</span>
                          <span className="font-semibold text-foreground">{msg.agent}</span>
                          {msg.kind && (
                            <Badge variant="outline" className="text-[10px]">{msg.kind}</Badge>
                          )}
                          {isDone && (
                            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400">
                              done
                            </Badge>
                          )}
                        </div>
                        {msg.time && (
                          <span className="text-[10px] text-muted-foreground">{msg.time}</span>
                        )}
                      </div>
                      <div className="whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
                        {formatBoardText(msg.text)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="transcript" className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTarget && (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-6 py-2 text-xs">
                  {transcriptStack.length > 1 && (
                    <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onPopTranscript}>
                      <ArrowLeft className="mr-1 h-3 w-3" />
                      Back
                    </Button>
                  )}
                  <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                    {transcriptStack.map((item, idx) => (
                      <div key={`${item.conversationId}:${idx}`} className="flex shrink-0 items-center gap-1">
                        {idx > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                        <button
                          type="button"
                          onClick={() => onJumpTranscriptStack(idx)}
                          className={`truncate rounded px-1.5 py-0.5 ${
                            idx === transcriptStack.length - 1
                              ? 'font-medium text-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {item.label}
                        </button>
                      </div>
                    ))}
                  </div>
                  {transcriptLoading && (
                    <Loader2 className="ml-auto h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  )}
                </div>

                <ScrollArea className="min-h-0 flex-1 px-6 py-4">
                  <div className="mx-auto max-w-3xl space-y-6">
                    {transcriptError && (
                      <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {transcriptError}
                      </p>
                    )}
                    {transcriptSnapshot?.hasOlder && (
                      <div className="flex justify-center">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={transcriptLoading}
                          onClick={() => void loadOlderTranscript()}
                        >
                          Load older messages
                        </Button>
                      </div>
                    )}
                    {!transcriptSnapshot?.messages.length && !transcriptLoading && !transcriptError && (
                      <p className="py-12 text-center text-xs text-muted-foreground">
                        No transcript messages available for this worker yet.
                      </p>
                    )}
                    {(transcriptSnapshot?.messages || []).map((message, index, list) => {
                      const showAuthor = index === 0 || list[index - 1].role !== message.role;
                      return (
                        <article
                          key={`${activeTarget.conversationId}:${message.id}`}
                          className={
                            message.role === 'user'
                              ? 'ml-auto max-w-[90%] rounded-xl bg-secondary px-4 py-3'
                              : `min-w-0${showAuthor ? '' : ' !mt-3'}`
                          }
                        >
                          {showAuthor && (
                            <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                              {message.role === 'user' ? 'Prompt / System' : activeTarget.label}
                            </p>
                          )}
                          <ManualChatContent
                            text={message.text}
                            agentId={agentId}
                            cwd={cwd}
                            user={message.role === 'user'}
                            thinking={message.thinking}
                            thinkingTokens={message.thinkingTokens}
                            tools={message.tools}
                            readOnly
                            onOpenSubagent={(childConvId, label) =>
                              onPushTranscript({ conversationId: childConvId, label: label || 'Subagent' })
                            }
                          />
                        </article>
                      );
                    })}
                  </div>
                </ScrollArea>
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
