"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PLAYGROUND_SCENARIOS } from "./playground-scenarios";
import type {
  AgentInfo,
  AgentRole,
  ApprovalData,
  ChangedFileDiff,
  InspectorTab,
  PlaygroundScenario,
  PlaygroundStatus,
  QACheckItem,
  RuntimeModel,
  ScenarioTask,
  TimelineStepEvent,
  TrustMode,
} from "./types";

const SPEED_MS = {
  slow: 1900,
  normal: 1050,
  fast: 420,
};

export function usePlaygroundEngine(initialScenarioId = "fullstack-refactor") {
  const [scenarioId, setScenarioIdState] = useState<string>(initialScenarioId);
  const scenario =
    PLAYGROUND_SCENARIOS.find((s) => s.id === scenarioId) ||
    PLAYGROUND_SCENARIOS[0];

  // Initialize with initial active steps so the playground is never an empty void
  const initialEventsCount = Math.min(3, scenario.events.length);
  const initialLoadedEvents = scenario.events.slice(0, initialEventsCount);
  const initialHasApproval = initialLoadedEvents.some(
    (e) => e.type === "approval_request" && e.approvalData
  );
  const initialApprovalData =
    initialLoadedEvents.find((e) => e.type === "approval_request")?.approvalData ||
    null;

  const [status, setStatus] = useState<PlaygroundStatus>(
    initialHasApproval ? "waiting_for_approval" : "running"
  );
  const [currentEventIndex, setCurrentEventIndex] = useState<number>(
    initialEventsCount - 1
  );
  const [streamedContent, setStreamedContent] = useState<string>("");
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [activeAgents, setActiveAgents] = useState<AgentInfo[]>(() =>
    scenario.initialAgents.map((a) => {
      if (a.role === "orchestrator") return { ...a, status: "done" };
      if (a.role === "builder") return { ...a, status: "running" };
      return a;
    })
  );
  const [planTasks, setPlanTasks] = useState<ScenarioTask[]>(() =>
    scenario.planTasks.map((task, idx) => {
      if (idx === 0) return { ...task, status: "completed" };
      if (idx === 1) return { ...task, status: "in_progress" };
      return task;
    })
  );
  const [visibleEvents, setVisibleEvents] =
    useState<TimelineStepEvent[]>(initialLoadedEvents);
  const [visibleDiffs, setVisibleDiffs] = useState<ChangedFileDiff[]>(
    scenario.finalDiffs.slice(0, 1)
  );
  const [visibleQAChecks, setVisibleQAChecks] = useState<QACheckItem[]>(
    scenario.qaChecks.slice(0, 2)
  );
  const [activeInspectorTab, setActiveInspectorTab] =
    useState<InspectorTab>("plan");
  const [speed, setSpeed] = useState<"slow" | "normal" | "fast">("normal");
  const [trustMode, setTrustMode] = useState<TrustMode>(
    scenario.defaultTrustMode
  );
  const [runtime, setRuntime] = useState<RuntimeModel>(scenario.defaultRuntime);
  const [tokensCount, setTokensCount] = useState<number>(
    Math.round(scenario.estimatedTokens * 0.45)
  );
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(14);
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalData | null>(initialApprovalData);
  const [approvalDecision, setApprovalDecision] = useState<
    "approved" | "rejected" | null
  >(null);
  const [devMode, setDevMode] = useState<boolean>(false);

  const typewriterTimerRef = useRef<number | null>(null);
  const playbackTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);

  // Synchronize scenario switches
  const resetToScenario = useCallback((nextScenario: PlaygroundScenario) => {
    if (typewriterTimerRef.current)
      window.clearTimeout(typewriterTimerRef.current);
    if (playbackTimerRef.current)
      window.clearTimeout(playbackTimerRef.current);
    if (elapsedTimerRef.current)
      window.clearInterval(elapsedTimerRef.current);

    const initCount = Math.min(3, nextScenario.events.length);
    const initEvs = nextScenario.events.slice(0, initCount);
    const hasAppr = initEvs.some(
      (e) => e.type === "approval_request" && e.approvalData
    );
    const apprData =
      initEvs.find((e) => e.type === "approval_request")?.approvalData || null;

    setStatus(hasAppr ? "waiting_for_approval" : "running");
    setCurrentEventIndex(initCount - 1);
    setStreamedContent("");
    setIsTyping(false);
    setActiveAgents(
      nextScenario.initialAgents.map((a) => {
        if (a.role === "orchestrator") return { ...a, status: "done" };
        if (a.role === "builder") return { ...a, status: "running" };
        return a;
      })
    );
    setPlanTasks(
      nextScenario.planTasks.map((task, idx) => {
        if (idx === 0) return { ...task, status: "completed" };
        if (idx === 1) return { ...task, status: "in_progress" };
        return task;
      })
    );
    setVisibleEvents(initEvs);
    setVisibleDiffs(nextScenario.finalDiffs.slice(0, 1));
    setVisibleQAChecks(nextScenario.qaChecks.slice(0, 2));
    setActiveInspectorTab("plan");
    setTrustMode(nextScenario.defaultTrustMode);
    setRuntime(nextScenario.defaultRuntime);
    setTokensCount(Math.round(nextScenario.estimatedTokens * 0.45));
    setElapsedSeconds(14);
    setPendingApproval(apprData);
    setApprovalDecision(null);
  }, []);

  const setScenario = useCallback(
    (id: string) => {
      const found =
        PLAYGROUND_SCENARIOS.find((s) => s.id === id) || PLAYGROUND_SCENARIOS[0];
      setScenarioIdState(found.id);
      resetToScenario(found);
    },
    [resetToScenario]
  );

  // Helper to update agent status given active event
  const updateAgentsForRole = useCallback(
    (role: AgentRole, isCompleted = false) => {
      setActiveAgents((prev) =>
        prev.map((agent) => {
          if (agent.role === role) {
            return {
              ...agent,
              status: isCompleted ? "done" : "running",
            };
          }
          return agent.status === "running"
            ? { ...agent, status: "idle" }
            : agent;
        })
      );
    },
    []
  );

  // Helper to advance task status
  const updatePlanTasksForEvent = useCallback(
    (event: TimelineStepEvent, eventIdx: number, totalEvents: number) => {
      setPlanTasks((prev) => {
        const fraction = (eventIdx + 1) / totalEvents;
        return prev.map((task, idx) => {
          const taskFraction = (idx + 1) / prev.length;
          if (fraction >= taskFraction) {
            return { ...task, status: "completed" };
          } else if (
            fraction >= (idx + 0.3) / prev.length &&
            task.status !== "completed"
          ) {
            return { ...task, status: "in_progress" };
          }
          return task;
        });
      });
    },
    []
  );

  // Execute a specific event index with typewriter stream effect
  const executeEventAtIndex = useCallback(
    (index: number) => {
      if (index < 0 || index >= scenario.events.length) {
        if (index >= scenario.events.length) {
          setStatus("completed");
          setActiveAgents((prev) =>
            prev.map((a) => ({ ...a, status: "done" }))
          );
        }
        return;
      }

      const event = scenario.events[index];
      setCurrentEventIndex(index);
      updateAgentsForRole(event.agentRole);
      updatePlanTasksForEvent(event, index, scenario.events.length);

      // Accumulate tokens
      const tokenDelta = Math.round(
        scenario.estimatedTokens / scenario.events.length
      );
      setTokensCount((prev) => Math.min(scenario.estimatedTokens, prev + tokenDelta));

      // If diff data present, append to visible diffs
      if (event.diffData) {
        setVisibleDiffs((prev) => {
          const exists = prev.some((d) => d.path === event.diffData?.path);
          return exists ? prev : [...prev, event.diffData!];
        });
      }

      // If QA check data present, append to checks
      if (event.checkData) {
        setVisibleQAChecks((prev) => {
          const exists = prev.some((c) => c.id === event.checkData?.id);
          return exists ? prev : [...prev, event.checkData!];
        });
      }

      // Check if this event is an approval request
      if (event.type === "approval_request" && event.approvalData) {
        setPendingApproval(event.approvalData);
        setStatus("waiting_for_approval");
        setVisibleEvents((prev) => [...prev, event]);
        return;
      }

      // Stream content typewriter for thoughts or summary
      if (event.type === "thought" || event.type === "mission_summary") {
        setIsTyping(true);
        setStreamedContent("");
        let charIndex = 0;
        const text = event.content;
        const typingSpeed = speed === "fast" ? 10 : speed === "slow" ? 30 : 18;

        const typeNextChar = () => {
          if (charIndex <= text.length) {
            setStreamedContent(text.slice(0, charIndex));
            charIndex += 2;
            typewriterTimerRef.current = window.setTimeout(
              typeNextChar,
              typingSpeed
            );
          } else {
            setIsTyping(false);
            setStreamedContent(text);
            setVisibleEvents((prev) => {
              const alreadyHas = prev.some((e) => e.id === event.id);
              return alreadyHas ? prev : [...prev, event];
            });

            // Schedule next event if running
            if (status === "running") {
              playbackTimerRef.current = window.setTimeout(() => {
                executeEventAtIndex(index + 1);
              }, SPEED_MS[speed]);
            }
          }
        };
        typeNextChar();
      } else {
        // Non-thought events add immediately
        setVisibleEvents((prev) => {
          const alreadyHas = prev.some((e) => e.id === event.id);
          return alreadyHas ? prev : [...prev, event];
        });

        if (index === scenario.events.length - 1) {
          setStatus("completed");
          setActiveAgents((prev) =>
            prev.map((a) => ({ ...a, status: "done" }))
          );
        } else if (status === "running") {
          playbackTimerRef.current = window.setTimeout(() => {
            executeEventAtIndex(index + 1);
          }, SPEED_MS[speed]);
        }
      }
    },
    [
      scenario,
      speed,
      status,
      updateAgentsForRole,
      updatePlanTasksForEvent,
    ]
  );

  // Play
  const play = useCallback(() => {
    if (status === "completed" || status === "rejected") {
      resetToScenario(scenario);
      setStatus("running");
      window.setTimeout(() => executeEventAtIndex(0), 100);
      return;
    }
    setStatus("running");
    if (currentEventIndex < 0) {
      executeEventAtIndex(0);
    } else {
      executeEventAtIndex(currentEventIndex + 1);
    }
  }, [currentEventIndex, executeEventAtIndex, resetToScenario, scenario, status]);

  // Pause
  const pause = useCallback(() => {
    if (playbackTimerRef.current)
      window.clearTimeout(playbackTimerRef.current);
    if (typewriterTimerRef.current)
      window.clearTimeout(typewriterTimerRef.current);
    setStatus("paused");
    setIsTyping(false);
  }, []);

  // Step forward
  const stepForward = useCallback(() => {
    pause();
    const nextIndex = currentEventIndex + 1;
    if (nextIndex < scenario.events.length) {
      executeEventAtIndex(nextIndex);
    } else {
      setStatus("completed");
    }
  }, [currentEventIndex, executeEventAtIndex, pause, scenario.events.length]);

  // Step backward
  const stepBackward = useCallback(() => {
    pause();
    if (currentEventIndex <= 0) {
      resetToScenario(scenario);
    } else {
      const targetIndex = currentEventIndex - 1;
      const targetEvents = scenario.events.slice(0, targetIndex + 1);
      setVisibleEvents(targetEvents);
      setCurrentEventIndex(targetIndex);

      // Reconstruct diffs & checks
      const reconstructedDiffs: ChangedFileDiff[] = [];
      const reconstructedChecks: QACheckItem[] = [];
      targetEvents.forEach((ev) => {
        if (ev.diffData) reconstructedDiffs.push(ev.diffData);
        if (ev.checkData) reconstructedChecks.push(ev.checkData);
      });
      setVisibleDiffs(reconstructedDiffs);
      setVisibleQAChecks(reconstructedChecks);
    }
  }, [currentEventIndex, pause, resetToScenario, scenario]);

  // Restart
  const restart = useCallback(() => {
    resetToScenario(scenario);
  }, [resetToScenario, scenario]);

  // Handle Interactive Approval Decision
  const handleApproval = useCallback(
    (decision: "approved" | "rejected") => {
      setApprovalDecision(decision);
      setPendingApproval(null);

      if (decision === "approved") {
        setStatus("running");
        const nextIdx = currentEventIndex + 1;
        playbackTimerRef.current = window.setTimeout(() => {
          executeEventAtIndex(nextIdx);
        }, 500);
      } else {
        setStatus("rejected");
        const rejectEvent: TimelineStepEvent = {
          id: "ev-rejected",
          type: "mission_summary",
          agentRole: "orchestrator",
          content:
            "Execution halted: Restricted command permission was rejected by the operator. Workspace returned to clean checkpoint.",
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        };
        setVisibleEvents((prev) => [...prev, rejectEvent]);
      }
    },
    [currentEventIndex, executeEventAtIndex]
  );

  // Custom Prompt injection
  const injectCustomPrompt = useCallback(
    (promptText: string) => {
      restart();
      setStatus("running");
      window.setTimeout(() => {
        executeEventAtIndex(0);
      }, 200);
    },
    [executeEventAtIndex, restart]
  );

  // Elapsed timer tick
  useEffect(() => {
    if (status === "running") {
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      if (elapsedTimerRef.current)
        window.clearInterval(elapsedTimerRef.current);
    }
    return () => {
      if (elapsedTimerRef.current)
        window.clearInterval(elapsedTimerRef.current);
    };
  }, [status]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (typewriterTimerRef.current)
        window.clearTimeout(typewriterTimerRef.current);
      if (playbackTimerRef.current)
        window.clearTimeout(playbackTimerRef.current);
      if (elapsedTimerRef.current)
        window.clearInterval(elapsedTimerRef.current);
    };
  }, []);

  return {
    scenario,
    scenarioId,
    status,
    currentEventIndex,
    streamedContent,
    isTyping,
    activeAgents,
    planTasks,
    visibleEvents,
    visibleDiffs,
    visibleQAChecks,
    activeInspectorTab,
    speed,
    trustMode,
    runtime,
    tokensCount,
    elapsedSeconds,
    pendingApproval,
    approvalDecision,
    devMode,
    play,
    pause,
    stepForward,
    stepBackward,
    restart,
    setScenario,
    setTrustMode,
    setRuntime,
    setSpeed,
    setActiveInspectorTab,
    toggleDevMode: () => setDevMode((prev) => !prev),
    handleApproval,
    injectCustomPrompt,
  };
}

export type PlaygroundEngine = ReturnType<typeof usePlaygroundEngine>;
