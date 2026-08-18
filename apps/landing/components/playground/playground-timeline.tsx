"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Award,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  GitCompare,
  Hammer,
  ListTodo,
  Loader2,
  Rocket,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  Terminal,
  X,
  XCircle,
} from "lucide-react";
import type {
  AgentRole,
  ApprovalData,
  CandidateItem,
  TimelineStepEvent,
} from "./types";
import type { PlaygroundEngine } from "./playground-engine";

interface PlaygroundTimelineProps {
  engine: PlaygroundEngine;
  compact?: boolean;
  locale?: string;
}

function getAgentRoleBadge(role: AgentRole) {
  switch (role) {
    case "orchestrator":
      return {
        label: "Orchestrator",
        color: "#c084fc",
        bg: "rgba(192, 132, 252, 0.15)",
        border: "rgba(192, 132, 252, 0.35)",
        icon: Brain,
      };
    case "builder":
      return {
        label: "Builder",
        color: "#60a5fa",
        bg: "rgba(96, 165, 250, 0.15)",
        border: "rgba(96, 165, 250, 0.35)",
        icon: Hammer,
      };
    case "builder_b":
      return {
        label: "Candidate B",
        color: "#34d399",
        bg: "rgba(52, 211, 153, 0.15)",
        border: "rgba(52, 211, 153, 0.35)",
        icon: GitCompare,
      };
    case "reviewer":
      return {
        label: "Reviewer",
        color: "#fbbf24",
        bg: "rgba(251, 191, 36, 0.15)",
        border: "rgba(251, 191, 36, 0.35)",
        icon: Award,
      };
    case "researcher":
      return {
        label: "Researcher",
        color: "#34d399",
        bg: "rgba(52, 211, 153, 0.15)",
        border: "rgba(52, 211, 153, 0.35)",
        icon: Search,
      };
    case "qa":
      return {
        label: "QA Engineer",
        color: "#38bdf8",
        bg: "rgba(56, 189, 248, 0.15)",
        border: "rgba(56, 189, 248, 0.35)",
        icon: Shield,
      };
    default:
      return {
        label: role,
        color: "#94a3b8",
        bg: "rgba(148, 163, 184, 0.15)",
        border: "rgba(148, 163, 184, 0.35)",
        icon: Rocket,
      };
  }
}

// Tool Execution Card (Matches desktop EventCard)
function ToolExecutionCard({
  toolData,
}: {
  toolData: NonNullable<TimelineStepEvent["toolData"]>;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div style={{ marginTop: "8px", borderRadius: "8px", border: "1px solid #1e293b", background: "#050811", overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "#0c1322", borderBottom: "1px solid #1e293b", color: "#e2e8f0", cursor: "pointer", textAlign: "left" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <Terminal style={{ width: "13px", height: "13px", color: "#38bdf8", flexShrink: 0 }} />
          <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#38bdf8", fontSize: "11px" }}>
            $ {toolData.name}
          </span>
          <span style={{ fontSize: "10px", color: "#94a3b8", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "260px" }}>
            {typeof toolData.args === "object" ? JSON.stringify(toolData.args) : String(toolData.args)}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <span style={{ fontFamily: "monospace", fontSize: "9px", color: "#64748b", background: "#060911", padding: "2px 6px", borderRadius: "4px", border: "1px solid #1e293b" }}>
            {toolData.duration}
          </span>
          {expanded ? <ChevronDown style={{ width: "13px", height: "13px" }} /> : <ChevronRight style={{ width: "13px", height: "13px" }} />}
        </div>
      </button>

      {expanded && (
        <div style={{ padding: "10px 12px", background: "#03060c", fontFamily: "monospace", fontSize: "10.5px", color: "#6ee7b7", lineHeight: "1.6", whiteSpace: "pre-wrap", maxHeight: "180px", overflowY: "auto" }}>
          {toolData.output}
        </div>
      )}
    </div>
  );
}

// Interactive Human Approval Gate (Matches desktop Gate Card)
function HumanApprovalGateCard({
  approvalData,
  decision,
  onDecide,
  locale = "tr",
}: {
  approvalData: ApprovalData;
  decision: "approved" | "rejected" | null;
  onDecide: (decision: "approved" | "rejected") => void;
  locale?: string;
}) {
  return (
    <div className="pg-approval-card">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: "rgba(245, 158, 11, 0.2)", border: "1px solid rgba(245, 158, 11, 0.4)", display: "grid", placeItems: "center", color: "#fbbf24", flexShrink: 0 }}>
            <ShieldAlert style={{ width: "16px", height: "16px" }} />
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <strong style={{ fontSize: "12px", color: "#fef3c7" }}>
                {approvalData.title}
              </strong>
              <span style={{ padding: "1px 6px", borderRadius: "4px", fontSize: "8.5px", fontWeight: 800, background: "rgba(239, 68, 68, 0.2)", color: "#fca5a5", border: "1px solid rgba(239, 68, 68, 0.35)" }}>
                {approvalData.riskLevel} RISK
              </span>
            </div>
            <span style={{ fontSize: "10px", color: "#94a3b8" }}>
              {locale === "tr" ? "Restricted operasyon insan onayı bekliyor" : "Restricted operation requires explicit confirmation"}
            </span>
          </div>
        </div>

        {decision && (
          <span style={{ padding: "3px 8px", borderRadius: "4px", fontSize: "9.5px", fontWeight: 800, textTransform: "uppercase", background: decision === "approved" ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)", color: decision === "approved" ? "#34d399" : "#fca5a5", border: `1px solid ${decision === "approved" ? "#10b981" : "#ef4444"}` }}>
            {decision === "approved" ? (locale === "tr" ? "ONAYLANDI" : "APPROVED") : (locale === "tr" ? "REDDEDİLDİ" : "REJECTED")}
          </span>
        )}
      </div>

      <p style={{ margin: "4px 0 0", fontSize: "11.5px", color: "#e2e8f0", lineHeight: "1.5" }}>
        {approvalData.description}
      </p>

      {approvalData.command && (
        <div style={{ padding: "6px 10px", background: "#060911", border: "1px solid #334155", borderRadius: "6px", fontFamily: "monospace", fontSize: "10px", color: "#fbbf24" }}>
          $ {approvalData.command}
        </div>
      )}

      {!decision && (
        <div className="pg-approval-actions">
          <button
            type="button"
            onClick={() => onDecide("approved")}
            className="pg-btn-approve"
          >
            <Check style={{ width: "12px", height: "12px" }} />
            <span>{locale === "tr" ? "Onayla & Devam Et" : "Approve & Continue"}</span>
          </button>
          <button
            type="button"
            onClick={() => onDecide("rejected")}
            className="pg-btn-reject"
          >
            <X style={{ width: "12px", height: "12px" }} />
            <span>{locale === "tr" ? "Reddet" : "Reject"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function PlaygroundTimeline({
  engine,
  compact = false,
  locale = "tr",
}: PlaygroundTimelineProps) {
  const {
    scenario,
    status,
    visibleEvents,
    streamedContent,
    isTyping,
    currentEventIndex,
    approvalDecision,
    handleApproval,
  } = engine;

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [visibleEvents.length, streamedContent]);

  const currentEvent =
    currentEventIndex >= 0 && currentEventIndex < scenario.events.length
      ? scenario.events[currentEventIndex]
      : null;

  return (
    <div className="pg-center">
      {/* Top Mission Title Bar (Matches Screenshot 2/4) */}
      <div className="pg-center-header">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          <strong style={{ fontSize: "12px", color: "#f1f5f9", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {scenario.title[locale === "tr" ? "tr" : "en"]}
          </strong>
          <span className={`pg-status-pill ${
            status === "waiting_for_approval" ? "is-approval" : status === "completed" ? "is-completed" : "is-running"
          }`}>
            {status === "waiting_for_approval"
              ? "APPROVAL REQUIRED"
              : status === "completed"
              ? "COMPLETED"
              : "RUNNING"}
          </span>
        </div>

        <div style={{ fontSize: "10.5px", fontFamily: "monospace", color: "#64748b", background: "#101623", padding: "2px 8px", borderRadius: "4px", border: "1px solid #1e293b" }}>
          {scenario.branchName}
        </div>
      </div>

      {/* Events Timeline Container (Bounded scroll) */}
      <div ref={containerRef} className="pg-timeline-stream">
        {/* User Prompt Message Bubble (Top Right, matching real app screenshots) */}
        <div className="pg-user-msg-row">
          <div className="pg-user-msg-header">
            <span>You 01:19</span>
          </div>
          <div className="pg-user-msg-bubble">
            <div className="pg-user-msg-text">
              {scenario.prompt}
            </div>
            <div className="pg-user-avatar">
              M
            </div>
          </div>
        </div>

        {/* Mission Started Notification */}
        <div className="pg-card-started">
          <Rocket style={{ width: "13px", height: "13px", color: "#38bdf8" }} />
          <span style={{ fontWeight: 600, color: "#cbd5e1" }}>Mission started: {scenario.title[locale === "tr" ? "tr" : "en"]}</span>
          <span style={{ fontSize: "9px", fontFamily: "monospace", color: "#64748b" }}>01:19</span>
          <span style={{ padding: "1px 5px", borderRadius: "4px", fontSize: "8.5px", fontWeight: 800, textTransform: "uppercase", background: "#1e293b", color: "#94a3b8" }}>
            Mission Started
          </span>
        </div>

        {/* Mission Plan Generated Box (Screenshot 2/3 exact parity) */}
        <div className="pg-card-dag">
          <div className="pg-dag-title-row">
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ padding: "4px", borderRadius: "6px", background: "rgba(168, 85, 247, 0.2)", color: "#c084fc", display: "grid", placeItems: "center" }}>
                <FileCode2 style={{ width: "13px", height: "13px" }} />
              </div>
              <strong style={{ fontSize: "11.5px", color: "#f1f5f9" }}>Mission plan generated</strong>
              <span style={{ padding: "1px 5px", borderRadius: "4px", fontSize: "8.5px", fontWeight: 800, textTransform: "uppercase", background: "rgba(168, 85, 247, 0.2)", color: "#d8b4fe", border: "1px solid rgba(168, 85, 247, 0.4)" }}>
                Orchestrator
              </span>
            </div>
            <span style={{ fontSize: "9.5px", fontFamily: "monospace", color: "#64748b" }}>01:19</span>
          </div>

          <p style={{ margin: "2px 0 0", fontSize: "11px", color: "#cbd5e1" }}>
            Generated {scenario.planTasks.length}-step structured DAG plan for "{scenario.title[locale === "tr" ? "tr" : "en"]}"
          </p>

          <div className="pg-dag-badges">
            <span className="pg-dag-chip">Plan 322e21e7</span>
            <span className="pg-dag-chip">{scenario.planTasks.length} tasks</span>
          </div>

          <p style={{ margin: "2px 0 0", fontSize: "9.5px", color: "#64748b" }}>
            A separate approval card is shown when the selected trust mode requires plan approval.
          </p>
        </div>

        {/* Visible Timeline Events */}
        {visibleEvents.map((event: TimelineStepEvent) => {
          const badge = getAgentRoleBadge(event.agentRole);
          const Icon = badge.icon;

          if (event.type === "approval_request" && event.approvalData) {
            return (
              <HumanApprovalGateCard
                key={event.id}
                approvalData={event.approvalData}
                decision={approvalDecision}
                onDecide={handleApproval}
                locale={locale}
              />
            );
          }

          if (event.type === "mission_summary") {
            return (
              <div
                key={event.id}
                style={{ margin: "8px 0", padding: "14px", borderRadius: "12px", border: "1px solid rgba(16, 185, 129, 0.4)", background: "rgba(6, 78, 59, 0.25)", color: "#e2e8f0" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#34d399", fontWeight: 800, fontSize: "12px" }}>
                  <Award style={{ width: "16px", height: "16px" }} />
                  <span>{locale === "tr" ? "Mission Başarıyla Doğrulandı ve Tamamlandı" : "Mission Verified & Completed"}</span>
                </div>
                <p style={{ margin: "6px 0 0", fontSize: "11.5px", color: "#cbd5e1", lineHeight: "1.5" }}>
                  {event.content}
                </p>
              </div>
            );
          }

          return (
            <div key={event.id} className="pg-event-card">
              <div className="pg-event-card-header">
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 6px", borderRadius: "4px", fontSize: "9px", fontWeight: 800, color: badge.color, background: badge.bg, border: `1px solid ${badge.border}` }}>
                    <Icon style={{ width: "11px", height: "11px" }} />
                    {badge.label}
                  </span>
                  <span style={{ fontSize: "9.5px", fontFamily: "monospace", color: "#64748b" }}>
                    {event.timestamp}
                  </span>
                </div>
              </div>

              <p style={{ margin: "2px 0 0", color: "#e2e8f0", lineHeight: "1.5", fontSize: "11.5px" }}>
                {event.content}
              </p>

              {event.toolData && <ToolExecutionCard toolData={event.toolData} />}
            </div>
          );
        })}

        {/* Live Typewriter stream card */}
        {isTyping && currentEvent && (
          <div className="pg-event-card" style={{ borderColor: "#38bdf8", background: "rgba(6, 182, 212, 0.1)" }}>
            <div className="pg-event-card-header">
              <span style={{ fontSize: "10px", fontFamily: "monospace", color: "#38bdf8", display: "flex", alignItems: "center", gap: "4px" }}>
                <Loader2 style={{ width: "11px", height: "11px", animation: "spin 1s linear infinite" }} />
                {locale === "tr" ? "Düşünüyor..." : "Thinking..."}
              </span>
            </div>
            <p style={{ margin: "4px 0 0", color: "#e0f2fe", fontSize: "11.5px", lineHeight: "1.5" }}>
              {streamedContent}
              <span style={{ display: "inline-block", width: "7px", height: "12px", marginLeft: "2px", background: "#38bdf8", verticalAlign: "middle" }} />
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
