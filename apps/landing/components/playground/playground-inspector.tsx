"use client";

import React, { useState } from "react";
import {
  Brain,
  CheckCircle2,
  Code2,
  FileCode2,
  FileText,
  Hammer,
  ListTodo,
  Minus,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
  XCircle,
  Network,
  Maximize2,
  MoreHorizontal,
  Search,
} from "lucide-react";
import type {
  AgentInfo,
  ChangedFileDiff,
  InspectorTab,
  QACheckItem,
  ScenarioTask,
} from "./types";
import type { PlaygroundEngine } from "./playground-engine";

interface PlaygroundInspectorProps {
  engine: PlaygroundEngine;
  compact?: boolean;
  locale?: string;
}

export function PlaygroundInspector({
  engine,
  compact = false,
  locale = "tr",
}: PlaygroundInspectorProps) {
  const {
    scenario,
    activeInspectorTab,
    setActiveInspectorTab,
    planTasks,
    activeAgents,
    visibleDiffs,
    visibleQAChecks,
  } = engine;

  const [selectedDiffIndex, setSelectedDiffIndex] = useState(0);

  // Tabs config matching real desktop app screenshots
  const tabs: Array<{ id: string; label: string }> = [
    { id: "plan", label: "Plan" },
    { id: "agents", label: "Agents" },
    { id: "changes", label: "Changes" },
    { id: "checks", label: "Review" },
    { id: "memory", label: "Memory" },
  ];

  const diffsToDisplay =
    visibleDiffs.length > 0 ? visibleDiffs : scenario.finalDiffs;
  const activeDiff =
    diffsToDisplay[selectedDiffIndex] || diffsToDisplay[0];

  const checksToDisplay =
    visibleQAChecks.length > 0 ? visibleQAChecks : scenario.qaChecks;

  return (
    <aside
      className="pg-inspector"
      style={compact ? { width: "180px" } : undefined}
    >
      {/* Inspector Tab Bar (Matches Screenshot 2/3) */}
      <div className="pg-inspector-tabs">
        <div style={{ display: "flex", alignItems: "center", gap: "3px" }}>
          {tabs.map(({ id, label }) => {
            const isActive = (activeInspectorTab as string) === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveInspectorTab(id as any)}
                className={`pg-tab-btn ${isActive ? "is-active" : ""}`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "4px", color: "#64748b" }}>
          <MoreHorizontal style={{ width: "13px", height: "13px", cursor: "pointer" }} />
        </div>
      </div>

      {/* Tab Content Panels */}
      <div className="pg-inspector-content">
        {/* TAB 1: PLAN */}
        {activeInspectorTab === "plan" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "9px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em", color: "#64748b" }}>
                {locale === "tr" ? "Görev Dağılımı (Plan)" : "Mission Tasks"}
              </span>
              <span style={{ fontSize: "10.5px", fontFamily: "monospace", color: "#c084fc", fontWeight: 700 }}>
                {planTasks.filter((t: ScenarioTask) => t.status === "completed").length} / {planTasks.length}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {planTasks.map((task: ScenarioTask, index: number) => {
                const isCompleted = task.status === "completed";
                const isInProgress = task.status === "in_progress";

                return (
                  <div
                    key={task.id}
                    className={`pg-task-card ${isCompleted ? "is-done" : isInProgress ? "is-progress" : ""}`}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#c084fc", fontSize: "11px", flexShrink: 0 }}>
                        {index + 1}.
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <strong style={{ display: "block", fontSize: "11px", color: "#f1f5f9", lineHeight: "1.3" }}>
                          {task.title}
                        </strong>
                        {task.summary && (
                          <p style={{ margin: "4px 0 0", fontSize: "10px", color: "#94a3b8", lineHeight: "1.4" }}>
                            {task.summary}
                          </p>
                        )}
                        <div style={{ marginTop: "6px", display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ padding: "1px 5px", borderRadius: "4px", fontSize: "8px", fontFamily: "monospace", textTransform: "uppercase", background: "#1e293b", color: "#cbd5e1" }}>
                            {task.assignedRole}
                          </span>
                          {isCompleted && (
                            <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "9px", color: "#34d399", fontWeight: 600 }}>
                              <CheckCircle2 style={{ width: "10px", height: "10px" }} />
                              {locale === "tr" ? "Tamamlandı" : "Done"}
                            </span>
                          )}
                          {isInProgress && (
                            <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "9px", color: "#c084fc", fontWeight: 600 }}>
                              <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#c084fc" }} />
                              {locale === "tr" ? "İşleniyor..." : "In progress"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 2: AGENTS (Screenshot 2 exact parity) */}
        {activeInspectorTab === "agents" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "11px", fontWeight: 700, color: "#f1f5f9", display: "flex", alignItems: "center", gap: "6px" }}>
                <Users style={{ width: "13px", height: "13px", color: "#c084fc" }} />
                <span>Agent team</span>
              </span>
              <span style={{ fontSize: "9.5px", fontFamily: "monospace", color: "#64748b" }}>
                1 active · 4 total
              </span>
            </div>

            {/* Main Agent Card (Matches Screenshot 2) */}
            <div style={{ padding: "12px", borderRadius: "10px", border: "1px solid rgba(139, 92, 246, 0.4)", background: "#130f28", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <div style={{ width: "26px", height: "26px", borderRadius: "6px", background: "rgba(139, 92, 246, 0.3)", border: "1px solid rgba(139, 92, 246, 0.5)", display: "grid", placeItems: "center", color: "#d8b4fe" }}>
                    <Brain style={{ width: "14px", height: "14px" }} />
                  </div>
                  <div>
                    <strong style={{ display: "block", fontSize: "11.5px", color: "#f1f5f9" }}>Builder Agent</strong>
                    <span style={{ fontSize: "9px", color: "#94a3b8", fontFamily: "monospace" }}>Antigravity Active Model · builder</span>
                  </div>
                </div>
                <span style={{ padding: "2px 6px", borderRadius: "4px", fontSize: "8.5px", fontWeight: 800, textTransform: "uppercase", background: "rgba(16, 185, 129, 0.2)", color: "#34d399", border: "1px solid rgba(16, 185, 129, 0.4)" }}>
                  Active
                </span>
              </div>

              {/* CURRENT WORK */}
              <div style={{ paddingTop: "8px", borderTop: "1px solid #1e293b" }}>
                <span style={{ fontSize: "8.5px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b", display: "block", marginBottom: "4px" }}>
                  CURRENT WORK
                </span>
                <p style={{ margin: 0, fontSize: "10.5px", color: "#f1f5f9", background: "#090d16", padding: "6px 8px", borderRadius: "6px", border: "1px solid #1e293b" }}>
                  Task 2: Implement zod-validated Server Action & stream buffer
                </p>
              </div>

              {/* LIVE ACTIVITY */}
              <div>
                <span style={{ fontSize: "8.5px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b", display: "block", marginBottom: "4px" }}>
                  LIVE ACTIVITY
                </span>
                <div style={{ padding: "6px 8px", borderRadius: "6px", background: "#090d16", border: "1px solid #1e293b", fontSize: "9.5px", display: "flex", flexDirection: "column", gap: "2px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: "#94a3b8" }}>
                    <span style={{ fontFamily: "monospace", color: "#c084fc", fontWeight: 700, background: "rgba(168, 85, 247, 0.2)", padding: "1px 4px", borderRadius: "3px" }}>
                      AGENT_STARTED
                    </span>
                    <span style={{ fontFamily: "monospace" }}>01:19</span>
                  </div>
                  <p style={{ margin: 0, color: "#cbd5e1", fontFamily: "monospace", fontSize: "9px" }}>
                    builder started with antigravity-active-route.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: CHANGES DIFF */}
        {activeInspectorTab === "changes" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "9px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em", color: "#64748b" }}>
                {locale === "tr" ? "Worktree Diff" : "Changes Diff"}
              </span>
              <span style={{ fontSize: "10px", color: "#94a3b8", fontFamily: "monospace" }}>
                {diffsToDisplay.length} files
              </span>
            </div>

            {/* File selector */}
            {diffsToDisplay.length > 1 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                {diffsToDisplay.map((d: ChangedFileDiff, i: number) => (
                  <button
                    key={d.path}
                    type="button"
                    onClick={() => setSelectedDiffIndex(i)}
                    style={{ padding: "3px 6px", borderRadius: "4px", fontSize: "9px", fontFamily: "monospace", color: selectedDiffIndex === i ? "#d8b4fe" : "#94a3b8", background: selectedDiffIndex === i ? "rgba(168, 85, 247, 0.2)" : "#101623", border: `1px solid ${selectedDiffIndex === i ? "rgba(168, 85, 247, 0.5)" : "#1e293b"}`, cursor: "pointer" }}
                  >
                    {d.path.split("/").pop()}
                  </button>
                ))}
              </div>
            )}

            {activeDiff && (
              <div style={{ borderRadius: "8px", border: "1px solid #1e293b", background: "#050811", overflow: "hidden" }}>
                <div style={{ padding: "6px 8px", borderBottom: "1px solid #1e293b", background: "#090d16", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontFamily: "monospace", fontSize: "9.5px", color: "#cbd5e1" }}>
                    {activeDiff.path}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", fontFamily: "monospace", fontSize: "9px" }}>
                    <span style={{ color: "#34d399" }}>+{activeDiff.additions}</span>
                    <span style={{ color: "#f87171" }}>-{activeDiff.deletions}</span>
                  </div>
                </div>

                <pre style={{ margin: 0, padding: "8px", fontFamily: "monospace", fontSize: "9px", lineHeight: "1.5", color: "#e2e8f0", overflowX: "auto", maxHeight: "240px" }}>
                  {activeDiff.diffSnippet.split("\n").map((line: string, lIdx: number) => {
                    const isAdd = line.startsWith("+");
                    const isDel = line.startsWith("-");
                    return (
                      <div
                        key={lIdx}
                        style={{
                          background: isAdd ? "rgba(6, 78, 59, 0.3)" : isDel ? "rgba(136, 19, 55, 0.3)" : "transparent",
                          color: isAdd ? "#6ee7b7" : isDel ? "#fca5a5" : "#94a3b8",
                        }}
                      >
                        {line}
                      </div>
                    );
                  })}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* TAB 4: REVIEW / QA CHECKS */}
        {activeInspectorTab === "checks" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "9px", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.1em", color: "#64748b" }}>
                {locale === "tr" ? "QA Güvenlik & Test Doğrulaması" : "QA Review & Checks"}
              </span>
              <span style={{ fontSize: "10px", color: "#34d399", fontFamily: "monospace", fontWeight: 700 }}>
                {checksToDisplay.filter((c: QACheckItem) => c.passed).length} / {checksToDisplay.length} Passed
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {checksToDisplay.map((c: QACheckItem) => (
                <div
                  key={c.id}
                  style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid #1e293b", background: "#101623", display: "flex", flexDirection: "column", gap: "2px" }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <strong style={{ fontSize: "11px", color: "#f1f5f9" }}>{c.name}</strong>
                    <span style={{ display: "flex", alignItems: "center", gap: "3px", fontSize: "8.5px", color: "#34d399", fontFamily: "monospace", fontWeight: 700, background: "rgba(16, 185, 129, 0.15)", padding: "1px 4px", borderRadius: "3px", border: "1px solid rgba(16, 185, 129, 0.35)" }}>
                      <CheckCircle2 style={{ width: "9px", height: "9px" }} />
                      PASS
                    </span>
                  </div>
                  <p style={{ margin: "2px 0 0", fontSize: "9.5px", color: "#94a3b8" }}>{c.summary || c.details}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 5: MEMORY (Screenshot 3 Knowledge Graph visualization) */}
        {(activeInspectorTab as string) === "memory" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "11px", fontWeight: 700, color: "#f1f5f9", fontFamily: "monospace" }}>
                NEW_PRODUCT · active
              </span>
              <span style={{ fontSize: "9px", color: "#34d399", fontFamily: "monospace" }}>● active</span>
            </div>

            <div style={{ padding: "8px", borderRadius: "8px", border: "1px solid #1e293b", background: "#050811", display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "9px", fontFamily: "monospace", color: "#64748b", paddingBottom: "4px", borderBottom: "1px solid #1e293b" }}>
                <span>26 nodes</span>
                <span>33 links</span>
                <span>32 evidence</span>
              </div>

              {/* Simulated Visual Graph Network SVG */}
              <div style={{ height: "180px", width: "100%", borderRadius: "6px", background: "#03060c", position: "relative", overflow: "hidden", border: "1px solid #1e293b", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg style={{ width: "100%", height: "100%" }} viewBox="0 0 200 160">
                  {/* Edges */}
                  <line x1="100" y1="80" x2="40" y2="40" stroke="#7c3aed" strokeWidth="1" strokeOpacity="0.5" />
                  <line x1="100" y1="80" x2="160" y2="50" stroke="#7c3aed" strokeWidth="1" strokeOpacity="0.5" />
                  <line x1="100" y1="80" x2="140" y2="120" stroke="#06b6d4" strokeWidth="1" strokeOpacity="0.5" />
                  <line x1="100" y1="80" x2="50" y2="110" stroke="#06b6d4" strokeWidth="1" strokeOpacity="0.5" />
                  <line x1="40" y1="40" x2="20" y2="70" stroke="#64748b" strokeWidth="0.8" strokeOpacity="0.4" />
                  <line x1="160" y1="50" x2="180" y2="80" stroke="#64748b" strokeWidth="0.8" strokeOpacity="0.4" />
                  <line x1="140" y1="120" x2="170" y2="135" stroke="#f59e0b" strokeWidth="0.8" strokeOpacity="0.4" />
                  <line x1="50" y1="110" x2="25" y2="130" stroke="#ec4899" strokeWidth="0.8" strokeOpacity="0.4" />

                  {/* Central Node */}
                  <circle cx="100" cy="80" r="7" fill="#8b5cf6" />
                  <circle cx="100" cy="80" r="12" fill="none" stroke="#8b5cf6" strokeWidth="0.8" strokeOpacity="0.5" />

                  {/* Satellite Nodes */}
                  <circle cx="40" cy="40" r="4.5" fill="#38bdf8" />
                  <circle cx="160" cy="50" r="5" fill="#f43f5e" />
                  <circle cx="140" cy="120" r="4" fill="#a855f7" />
                  <circle cx="50" cy="110" r="4.5" fill="#eab308" />
                  <circle cx="20" cy="70" r="3" fill="#64748b" />
                  <circle cx="180" cy="80" r="3" fill="#64748b" />
                  <circle cx="170" cy="135" r="3.5" fill="#f59e0b" />
                  <circle cx="25" cy="130" r="3.5" fill="#ec4899" />
                </svg>

                <div style={{ position: "absolute", top: "6px", left: "6px", fontSize: "8px", fontFamily: "monospace", color: "#64748b", background: "rgba(15, 23, 42, 0.8)", padding: "2px 6px", borderRadius: "3px", border: "1px solid #1e293b" }}>
                  116% zoom
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
