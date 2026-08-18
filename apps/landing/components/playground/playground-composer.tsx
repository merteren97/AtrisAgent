"use client";

import React, { useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Pause,
  Play,
  RotateCcw,
  Send,
  Shield,
  Paperclip,
  AtSign,
  Terminal,
  StepForward,
  Sparkles,
} from "lucide-react";
import { PLAYGROUND_SCENARIOS } from "./playground-scenarios";
import type {
  RuntimeModel,
  TrustMode,
} from "./types";
import type { PlaygroundEngine } from "./playground-engine";

interface PlaygroundComposerProps {
  engine: PlaygroundEngine;
  compact?: boolean;
  locale?: string;
}

const RUNTIMES: RuntimeModel[] = [
  "Codex CLI",
  "Claude Code",
  "Antigravity CLI",
  "OpenCode",
];

export function PlaygroundComposer({
  engine,
  compact = false,
  locale = "tr",
}: PlaygroundComposerProps) {
  const {
    scenario,
    scenarioId,
    status,
    speed,
    trustMode,
    runtime,
    play,
    pause,
    stepForward,
    restart,
    setScenario,
    setTrustMode,
    setRuntime,
    setSpeed,
    injectCustomPrompt,
  } = engine;

  const [inputPrompt, setInputPrompt] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  const handleSendPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputPrompt.trim()) return;
    injectCustomPrompt(inputPrompt);
    setInputPrompt("");
  };

  const isRunning = status === "running";

  return (
    <div className="pg-composer">
      {/* Real Desktop Composer Box (Matching Screenshot 2/3/4) */}
      <form
        onSubmit={handleSendPrompt}
        className="pg-composer-box"
      >
        <input
          type="text"
          value={inputPrompt}
          onChange={(e) => setInputPrompt(e.target.value)}
          placeholder={
            locale === "tr"
              ? "AtrisAgent ile bu göreve devam et..."
              : "Continue this conversation with AtrisAgent..."
          }
          className="pg-composer-input"
        />

        {/* Bottom Tool Strip */}
        <div className="pg-composer-tools">
          {/* Left attachment icons */}
          <div className="pg-composer-icons">
            <button
              type="button"
              title={locale === "tr" ? "Dosya Ekle" : "Attach File"}
            >
              <Paperclip style={{ width: "14px", height: "14px" }} />
            </button>
            <button
              type="button"
              title={locale === "tr" ? "Ajan veya Dosya Etiketle" : "Mention Agent or File"}
            >
              <AtSign style={{ width: "14px", height: "14px" }} />
            </button>
            <button
              type="button"
              title={locale === "tr" ? "Terminal Modu" : "Terminal Mode"}
            >
              <Terminal style={{ width: "14px", height: "14px" }} />
            </button>
          </div>

          {/* Right Model Selector and Send Button */}
          <div className="pg-composer-right">
            {/* Model Selector Dropdown */}
            <div style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setModelDropdownOpen((p) => !p)}
                className="pg-model-btn"
              >
                <Bot style={{ width: "13px", height: "13px", color: "#c084fc" }} />
                <span>Antigravity Active Model</span>
                <ChevronDown style={{ width: "12px", height: "12px", color: "#64748b" }} />
              </button>

              {modelDropdownOpen && (
                <div style={{ position: "absolute", right: 0, bottom: "calc(100% + 6px)", width: "180px", borderRadius: "10px", border: "1px solid #1e293b", background: "#0c1220", padding: "6px", boxShadow: "0 10px 30px rgba(0,0,0,0.5)", zIndex: 50, display: "flex", flexDirection: "column", gap: "2px" }}>
                  {RUNTIMES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setRuntime(m);
                        setModelDropdownOpen(false);
                      }}
                      style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: "6px", fontSize: "10.5px", fontFamily: "monospace", color: runtime === m ? "#d8b4fe" : "#cbd5e1", background: runtime === m ? "rgba(168, 85, 247, 0.2)" : "transparent", cursor: "pointer", border: 0 }}
                    >
                      <span>{m}</span>
                      {runtime === m && <Check style={{ width: "12px", height: "12px", color: "#c084fc" }} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Send / Execute Button */}
            <button
              type="submit"
              className="pg-send-btn"
              title={locale === "tr" ? "Mesajı Gönder" : "Send"}
            >
              <Send style={{ width: "13px", height: "13px" }} />
            </button>
          </div>
        </div>
      </form>

      {/* Footer controls & Scenario switcher */}
      <div className="pg-composer-footer">
        <span>Enter to send · Shift+Enter for a new line</span>

        {/* Play / Step / Reset controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            type="button"
            onClick={isRunning ? pause : play}
            style={{ display: "flex", alignItems: "center", gap: "4px", padding: "3px 8px", borderRadius: "5px", fontSize: "9.5px", fontWeight: 700, background: isRunning ? "rgba(245, 158, 11, 0.2)" : "rgba(168, 85, 247, 0.2)", color: isRunning ? "#fbbf24" : "#d8b4fe", border: `1px solid ${isRunning ? "rgba(245, 158, 11, 0.4)" : "rgba(168, 85, 247, 0.4)"}`, cursor: "pointer" }}
          >
            {isRunning ? <Pause style={{ width: "10px", height: "10px" }} /> : <Play style={{ width: "10px", height: "10px" }} />}
            <span>{isRunning ? "Durdur" : "Oynat"}</span>
          </button>

          <button
            type="button"
            onClick={stepForward}
            style={{ display: "flex", alignItems: "center", gap: "4px", padding: "3px 8px", borderRadius: "5px", background: "#101623", color: "#cbd5e1", border: "1px solid #1e293b", fontSize: "9.5px", cursor: "pointer" }}
            title="Sonraki Adım"
          >
            <StepForward style={{ width: "10px", height: "10px" }} />
            <span>Adım</span>
          </button>

          <button
            type="button"
            onClick={restart}
            style={{ padding: "3px 6px", borderRadius: "5px", background: "#101623", color: "#94a3b8", border: "1px solid #1e293b", cursor: "pointer", display: "grid", placeItems: "center" }}
            title="Yeniden Başlat"
          >
            <RotateCcw style={{ width: "11px", height: "11px" }} />
          </button>
        </div>
      </div>
    </div>
  );
}
