"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  FolderGit2,
  History,
  Home,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useLandingTranslation, type LandingLanguage } from "../lib/landing-i18n";

type PreviewPhase = "loading" | "ready" | "unavailable";

type AtrisAgentExplainerVideoProps = {
  locale: LandingLanguage;
  compact?: boolean;
};

const agents = [
  { role: "Orchestrator", runtime: "Codex CLI", state: "done" },
  { role: "Researcher", runtime: "Claude Code", state: "done" },
  { role: "Builder", runtime: "Antigravity", state: "running" },
  { role: "QA", runtime: "Codex CLI", state: "queued" },
  { role: "Reviewer", runtime: "OpenCode", state: "queued" },
] as const;

export default function AtrisAgentExplainerVideo({ locale, compact = false }: AtrisAgentExplainerVideoProps) {
  const { t } = useLandingTranslation();
  const [phase, setPhase] = useState<PreviewPhase>("loading");
  const [sceneIndex, setSceneIndex] = useState(2);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_LANDING_VIDEO_DISABLED === "true") {
      setPhase("unavailable");
      return;
    }
    const readyTimer = window.setTimeout(() => setPhase("ready"), 220);
    const sceneTimer = window.setInterval(() => setSceneIndex((current) => (current + 1) % agents.length), 2800);
    return () => {
      window.clearTimeout(readyTimer);
      window.clearInterval(sceneTimer);
    };
  }, []);

  if (phase === "loading") {
    return <div className="preview-shell preview-loading" role="status" aria-live="polite"><div className="preview-loading-orb" /><p>{t("previewLoading")}</p></div>;
  }

  if (phase === "unavailable") {
    return (
      <div className="preview-shell preview-unavailable" role="status" aria-live="polite">
        <div className="preview-unavailable-icon"><Bot aria-hidden="true" /></div>
        <div><strong>{t("previewUnavailableTitle")}</strong><p>{t("previewUnavailableDesc")}</p></div>
        <button className="preview-retry" type="button" onClick={() => setPhase("ready")}>{t("previewRetry")}</button>
      </div>
    );
  }

  const active = agents[sceneIndex];
  const completed = agents.filter((_, index) => index < sceneIndex).length;

  return (
    <div className="preview-shell preview-ready" aria-label={locale === "tr" ? "AtrisAgent güncel uygulama önizlemesi" : "Current AtrisAgent application preview"} style={compact ? { minHeight: 430 } : undefined}>
      <div className="preview-window-bar" style={{ padding: compact ? "14px 17px" : undefined }}>
        <div className="window-dots" aria-hidden="true"><span className="window-dot window-dot-red" /><span className="window-dot window-dot-yellow" /><span className="window-dot window-dot-green" /></div>
        <span className="preview-status"><span className="status-pulse" />{t("previewStatus")}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: compact ? "126px minmax(0,1fr)" : "170px minmax(0,1fr)", minHeight: compact ? 380 : 440 }}>
        <aside style={{ borderRight: "1px solid rgba(216,231,248,.1)", background: "rgba(9,16,24,.82)", padding: compact ? 11 : 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 12, borderBottom: "1px solid rgba(216,231,248,.08)" }}>
            <img src="/logo.svg" alt="" style={{ width: compact ? 24 : 29, height: compact ? 24 : 29, objectFit: "contain" }} />
            {!compact && <div><strong style={{ display: "block", color: "#e8f0f8", fontSize: 11 }}>AtrisAgent</strong><span style={{ color: "#6f8094", fontSize: 8 }}>Mission workspace</span></div>}
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 3 }}>
            {[{ icon: Home, label: "Home" }, { icon: FolderGit2, label: "Projects" }, { icon: History, label: "History" }].map(({ icon: Icon, label }, index) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 8px", borderRadius: 8, background: index === 0 ? "rgba(93,125,242,.12)" : "transparent", color: index === 0 ? "#b9c6ff" : "#718095", fontSize: 9, fontWeight: 700 }}><Icon size={12} />{!compact && label}</div>
            ))}
          </div>

          <div style={{ marginTop: 17, color: "#607086", fontSize: 8, fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase" }}>Workspaces</div>
          <div style={{ marginTop: 7, padding: "8px 7px", borderRadius: 8, background: "rgba(255,255,255,.035)", border: "1px solid rgba(216,231,248,.08)" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", color: "#dbe6f4", fontSize: 9, fontWeight: 700 }}><FolderGit2 size={11} />{compact ? "Atris…" : "AtrisAgent"}</div>
            {!compact && <div style={{ marginTop: 7, marginLeft: 17, display: "grid", gap: 5 }}><span style={{ color: "#9fb0c4", fontSize: 8 }}>Conversations</span><span style={{ padding: "5px 6px", borderRadius: 6, color: "#b8c5d6", background: "rgba(93,125,242,.09)", fontSize: 8 }}>Landing refresh</span></div>}
          </div>
        </aside>

        <div style={{ minWidth: 0, padding: compact ? 14 : 20, background: "linear-gradient(145deg, rgba(17,27,39,.86), rgba(8,15,23,.96))" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
            <div>
              <span style={{ color: "#8495ab", fontSize: 8, fontWeight: 800, letterSpacing: ".14em", textTransform: "uppercase" }}>Mission</span>
              <h2 style={{ margin: "4px 0 0", color: "#f1f5fb", fontSize: compact ? 14 : 18, lineHeight: 1.25, letterSpacing: "-.02em" }}>{locale === "tr" ? "AtrisAgent landing deneyimini güncelle" : "Refresh the AtrisAgent landing experience"}</h2>
              <p style={{ marginTop: 5, color: "#708096", fontSize: 8 }}>AtrisAgent · main · approval-first</p>
            </div>
            <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "6px 8px", border: "1px solid rgba(216,231,248,.08)", borderRadius: 8, color: "#8fa0b5", fontSize: 8 }}><Search size={11} />Mission</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(3,1fr)" : "repeat(3, minmax(100px,1fr))", gap: 7, marginTop: 13 }}>
            {[['Agents', agents.length], ['Active', active.state === 'running' ? 1 : 0], ['Tasks', `${completed}/${agents.length}`]].map(([label, value]) => <div key={label} style={{ border: "1px solid rgba(216,231,248,.08)", borderRadius: 9, padding: "8px 9px", background: "rgba(255,255,255,.025)" }}><span style={{ display: "block", color: "#65758a", fontSize: 7, textTransform: "uppercase", letterSpacing: ".1em" }}>{label}</span><strong style={{ display: "block", marginTop: 3, color: "#e5edf7", fontSize: 11 }}>{value}</strong></div>)}
          </div>

          <div style={{ display: "grid", gap: 7, marginTop: 12 }}>
            {agents.map((agent, index) => {
              const done = index < sceneIndex;
              const running = index === sceneIndex;
              return (
                <div key={agent.role} style={{ display: "flex", alignItems: "center", gap: 9, padding: compact ? "7px 8px" : "9px 10px", borderRadius: 10, border: `1px solid ${running ? 'rgba(93,125,242,.32)' : 'rgba(216,231,248,.075)'}`, background: running ? "rgba(93,125,242,.08)" : "rgba(255,255,255,.025)" }}>
                  <span style={{ display: "grid", width: 24, height: 24, placeItems: "center", borderRadius: 7, background: done ? "rgba(49,209,154,.1)" : running ? "rgba(93,125,242,.14)" : "rgba(255,255,255,.035)", color: done ? "#58ddae" : running ? "#aebcff" : "#67768a" }}>{done ? <Check size={12} /> : running ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Bot size={12} />}</span>
                  <div style={{ minWidth: 0, flex: 1 }}><strong style={{ display: "block", color: "#dfe8f3", fontSize: 9 }}>{agent.role}</strong><span style={{ display: "block", marginTop: 1, color: "#68788d", fontSize: 7 }}>{agent.runtime}</span></div>
                  <span style={{ color: running ? "#aebcff" : done ? "#58ddae" : "#617087", fontSize: 7, fontWeight: 800, textTransform: "uppercase" }}>{running ? 'running' : done ? 'done' : 'queued'}</span>
                </div>
              );
            })}
          </div>

          {!compact && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
              <div style={{ border: "1px solid rgba(93,125,242,.2)", borderRadius: 10, padding: 10, background: "rgba(93,125,242,.055)" }}><Sparkles size={13} color="#aebcff" /><strong style={{ display: "block", marginTop: 6, color: "#dfe8f3", fontSize: 9 }}>Official runtimes</strong><span style={{ display: "block", marginTop: 3, color: "#69798e", fontSize: 7 }}>Codex · Claude Code · Antigravity · OpenCode</span></div>
              <div style={{ border: "1px solid rgba(49,209,154,.18)", borderRadius: 10, padding: 10, background: "rgba(49,209,154,.045)" }}><ShieldCheck size={13} color="#58ddae" /><strong style={{ display: "block", marginTop: 6, color: "#dfe8f3", fontSize: 9 }}>Review boundary</strong><span style={{ display: "block", marginTop: 3, color: "#69798e", fontSize: 7 }}>Apply, approvals and rollback stay explicit.</span></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
