"use client";

import React from "react";
import {
  Brain,
  Hammer,
  Eye,
  Shield,
  Search,
  Bot,
  FolderGit2,
  GitBranch,
  Home,
  History,
  Check,
  Loader2,
  Clock,
  GitCompare,
  KeyRound,
  Settings,
  Plus,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Sparkles,
  LogOut,
  User,
} from "lucide-react";
import type { AgentInfo, AgentRole } from "./types";
import type { PlaygroundEngine } from "./playground-engine";
import { PLAYGROUND_SCENARIOS } from "./playground-scenarios";

interface PlaygroundSidebarProps {
  engine: PlaygroundEngine;
  compact?: boolean;
  locale?: string;
}

function getAgentRoleIcon(role: AgentRole) {
  switch (role) {
    case "orchestrator":
      return <Brain className="w-3.5 h-3.5 text-violet-400" />;
    case "builder":
      return <Hammer className="w-3.5 h-3.5 text-blue-400" />;
    case "builder_b":
      return <GitCompare className="w-3.5 h-3.5 text-emerald-400" />;
    case "reviewer":
      return <Eye className="w-3.5 h-3.5 text-amber-400" />;
    case "researcher":
      return <Search className="w-3.5 h-3.5 text-emerald-400" />;
    case "qa":
      return <Shield className="w-3.5 h-3.5 text-cyan-400" />;
    default:
      return <Bot className="w-3.5 h-3.5 text-muted-foreground" />;
  }
}

export function PlaygroundSidebar({
  engine,
  compact = false,
  locale = "tr",
}: PlaygroundSidebarProps) {
  const { scenario, activeAgents, setScenario } = engine;

  return (
    <aside
      className="pg-sidebar"
      style={compact ? { width: "160px" } : undefined}
    >
      {/* Top Search Bar with ⌘K */}
      <div className="pg-search-box">
        <div className="pg-search-input-wrap">
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <Search style={{ width: "13px", height: "13px", color: "#64748b" }} />
            <span>{locale === "tr" ? "Ara..." : "Search"}</span>
          </div>
          <kbd>⌘K</kbd>
        </div>
      </div>

      {/* Main Nav items */}
      <div className="pg-nav-list">
        <div className="pg-nav-item">
          <Home style={{ width: "14px", height: "14px", color: "#60a5fa" }} />
          <span>{locale === "tr" ? "Ana Sayfa" : "Home"}</span>
        </div>
        <div className="pg-nav-item">
          <FolderGit2 style={{ width: "14px", height: "14px", color: "#c084fc" }} />
          <span>{locale === "tr" ? "Projeler" : "Projects"}</span>
        </div>
        <div className="pg-nav-item">
          <History style={{ width: "14px", height: "14px", color: "#fbbf24" }} />
          <span>{locale === "tr" ? "Geçmiş" : "History"}</span>
        </div>
      </div>

      {/* WORKSPACES SECTION (Tree matching real desktop app) */}
      <div className="pg-workspaces-section">
        <div className="pg-section-label">
          <span>WORKSPACES</span>
          <Plus style={{ width: "12px", height: "12px", cursor: "pointer" }} />
        </div>

        {/* NEW_PRODUCT Folder Tree */}
        <div>
          <div className="pg-tree-root">
            <ChevronDown style={{ width: "13px", height: "13px", color: "#94a3b8" }} />
            <FolderGit2 style={{ width: "14px", height: "14px", color: "#38bdf8" }} />
            <span>NEW_PRODUCT</span>
          </div>

          <div className="pg-conversations-list">
            <div style={{ fontSize: "8.5px", fontWeight: 800, textTransform: "uppercase", color: "#64748b", padding: "3px 6px" }}>
              CONVERSATIONS
            </div>

            {PLAYGROUND_SCENARIOS.map((sc) => {
              const isSelected = sc.id === scenario.id;
              return (
                <button
                  key={sc.id}
                  type="button"
                  onClick={() => setScenario(sc.id)}
                  className={`pg-conv-item ${isSelected ? "is-active" : ""}`}
                >
                  <Search style={{ width: "12px", height: "12px", color: isSelected ? "#c084fc" : "#64748b" }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sc.title[locale === "tr" ? "tr" : "en"]}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Sibling workspace */}
          <div className="pg-tree-root" style={{ opacity: 0.6, marginTop: "6px" }}>
            <ChevronRight style={{ width: "13px", height: "13px", color: "#64748b" }} />
            <FolderGit2 style={{ width: "14px", height: "14px", color: "#64748b" }} />
            <span>AtrisTracker</span>
          </div>
        </div>
      </div>

      {/* Bottom Profile & Settings Section (Matches Screenshot 2) */}
      <div className="pg-sidebar-footer">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px 6px", color: "#94a3b8", fontSize: "11px", cursor: "pointer" }}>
          <KeyRound style={{ width: "13px", height: "13px", color: "#f59e0b" }} />
          <span>{locale === "tr" ? "Hesaplar (Accounts)" : "Accounts"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px 6px", color: "#94a3b8", fontSize: "11px", cursor: "pointer" }}>
          <Settings style={{ width: "13px", height: "13px", color: "#94a3b8" }} />
          <span>{locale === "tr" ? "Ayarlar (Settings)" : "Settings"}</span>
        </div>

        {/* User Status Card */}
        <div className="pg-user-badge">
          <div className="pg-user-avatar">
            M
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: "11px", fontWeight: 700, color: "#f1f5f9" }}>
              Mert
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "9px", color: "#34d399", fontFamily: "monospace" }}>
              <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#34d399" }} />
              Local service ready
            </span>
          </div>
          <LogOut style={{ width: "13px", height: "13px", color: "#64748b", cursor: "pointer" }} />
        </div>
      </div>
    </aside>
  );
}
