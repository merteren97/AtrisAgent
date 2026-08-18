"use client";

import React, { useState } from "react";
import {
  Activity,
  Bug,
  Check,
  Clock,
  Code,
  Flame,
  Maximize2,
  Minimize2,
  Sparkles,
  Terminal,
} from "lucide-react";
import { usePlaygroundEngine } from "./playground-engine";
import { PlaygroundSidebar } from "./playground-sidebar";
import { PlaygroundTimeline } from "./playground-timeline";
import { PlaygroundInspector } from "./playground-inspector";
import { PlaygroundComposer } from "./playground-composer";

interface AtrisPlaygroundProps {
  initialScenarioId?: string;
  compact?: boolean;
  locale?: string;
  className?: string;
}

export function AtrisPlayground({
  initialScenarioId = "fullstack-refactor",
  compact = false,
  locale = "tr",
  className = "",
}: AtrisPlaygroundProps) {
  const engine = usePlaygroundEngine(initialScenarioId);
  const {
    tokensCount,
    elapsedSeconds,
    devMode,
    toggleDevMode,
    status,
    currentEventIndex,
    scenario,
    visibleEvents,
    activeAgents,
  } = engine;

  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div
      className={`pg-window ${className}`}
      style={compact ? { height: "500px" } : undefined}
    >
      {/* Top Window Titlebar (Matches Screenshot 2/3/4) */}
      <div className="pg-titlebar">
        {/* Left: Brand Icon, Title, Theme toggle & Panel toggle */}
        <div className="pg-titlebar-left">
          <div className="pg-brand-badge">
            <img
              src="/logo.svg"
              alt="AtrisAgent"
            />
            <span>AtrisAgent</span>
          </div>

          <div className="pg-titlebar-workspace">
            <span>{scenario.workspaceName}</span>
          </div>
        </div>

        {/* Center: Status Badge & Actions */}
        <div className="pg-titlebar-center">
          {status === "running" && (
            <span className="pg-status-pill is-running">
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#38bdf8", display: "inline-block" }} />
              <span>LIVE ORCHESTRATION</span>
            </span>
          )}
          {status === "waiting_for_approval" && (
            <span className="pg-status-pill is-approval">
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#fbbf24", display: "inline-block" }} />
              <span>APPROVAL REQUIRED</span>
            </span>
          )}
          {status === "completed" && (
            <span className="pg-status-pill is-completed">
              <Check style={{ width: "12px", height: "12px" }} />
              <span>MISSION COMPLETED</span>
            </span>
          )}
        </div>

        {/* Right: Tokens, Developer Mode & Windows controls */}
        <div className="pg-titlebar-right">
          <div className="pg-token-chip">
            <Flame style={{ width: "12px", height: "12px", color: "#f59e0b" }} />
            <span>{tokensCount.toLocaleString()} tkn</span>
          </div>

          <button
            type="button"
            onClick={toggleDevMode}
            className={`pg-devmode-btn ${devMode ? "is-active" : ""}`}
          >
            <Bug style={{ width: "12px", height: "12px" }} />
            <span>Dev Mode</span>
          </button>

          {/* Windows Window Controls (— ▢ ✕) */}
          <div className="pg-window-controls">
            <span className="pg-win-btn">—</span>
            <span className="pg-win-btn">▢</span>
            <span className="pg-win-btn is-close">✕</span>
          </div>
        </div>
      </div>

      {/* Main 3-Column Layout: Sidebar + Timeline + Inspector */}
      <div className="pg-body">
        {/* Left Sidebar */}
        <PlaygroundSidebar
          engine={engine}
          compact={compact}
          locale={locale}
        />

        {/* Center Timeline */}
        <PlaygroundTimeline
          engine={engine}
          compact={compact}
          locale={locale}
        />

        {/* Right Inspector */}
        {!compact && (
          <PlaygroundInspector
            engine={engine}
            compact={compact}
            locale={locale}
          />
        )}
      </div>

      {/* Bottom Composer & Mission Controls */}
      <PlaygroundComposer
        engine={engine}
        compact={compact}
        locale={locale}
      />
    </div>
  );
}

export default AtrisPlayground;
