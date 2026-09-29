"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight, BarChart2, Bot, Check, ChevronDown, ChevronRight, ClipboardList,
  Code2, FileCode2, FolderGit2, History, House, MessageSquare, Minus,
  Moon, PanelLeft, Plus, Search, Send, ShieldCheck, Square, Sun,
  TerminalSquare, UsersRound, Workflow, X,
} from "lucide-react";
import type { LandingLanguage } from "../lib/landing-i18n";
import "./product-demo.css";

type Scene = "home" | "manual" | "mission";
type WorkbenchTab = "plan" | "changes" | "checks";

const copy = {
  tr: {
    explore: "Uygulama ekranlarını keşfedin", sample: "ÖRNEK VERİ İLE ETKİLEŞİMLİ ÖN İZLEME",
    home: "Çalışma alanı", manual: "Manual", mission: "Orchestrator",
    sampleNote: "Tarayıcı ön izlemesi · Gerçek proje dosyaları değiştirilmez",
    project: "Proje çalışma alanı", welcome: "Bir konuşma başlatın. Ajanları ve çalışmalarını tek yerde tutun.",
    choose: "Bir çalışma biçimi seçin", chooseDetail: "Aynı proje, farklı kontrol düzeyleri",
    manualDetail: "Bir CLI ve model seçin. Bağımsız ajanları Chat veya canlı terminallerinde yönetin.",
    missionDetail: "Bir hedef tanımlayın. Planı, görev dağılımını ve incelemeyi tek konuşmada izleyin.",
    recent: "Son konuşmalar", conversation: "Ödeme akışını iyileştir", waiting: "İnceleme bekliyor",
    task: "Checkout hatalarını ele al ve değişiklikleri test et.",
    userRequest: "Ödeme akışındaki hataları düzelt ve testleri güncelle.",
    plan: "Orchestrator planı oluşturdu", research: "Researcher bağlamı topladı",
    build: "Builder iki dosyada değişiklik hazırladı", checks: "QA üç testi doğruladı",
    ready: "Değişiklikler incelemeye hazır", review: "Mission Workbench'i aç",
    manualIntro: "Bağımsız ajanlar", manualSub: "Ajanların her biri kendi bağlamında ve terminalinde çalışır.",
    agentCard: "Claude Code · Sohbet", agentAnswer: "Checkout akışını incelemek için önce ilgili dosyaları tarayacağım.",
    codeLine: "src/checkout/checkout.tsx dosyası inceleniyor", prompt: "Örnek bir görev yazın…",
    sent: "Örnek mesajınız alındı. Gerçek bir AI çalıştırılmadı.",
    planTitle: "Plan ve görevler", planDetail: "Plan, uzman ajanlar ve inceleme tek akışta.",
    changesTitle: "Değişiklikler", checksTitle: "Doğrulama", testsPassed: "3 test başarılı",
    approve: "Örneği tamamla", approved: "Örnek tamamlandı", reset: "Örneği sıfırla",
    search: "Ekranlarda ara…", searchHint: "Ekranlar arasında geçiş yapmak için bir sonuç seçin.",
    dialog: "Mission Workbench", previewOnly: "Bu bir arayüz ön izlemesidir; hiçbir dosyaya yazılmaz.",
    openProject: "Projeyi aç", viewMission: "Görevi görüntüle", openManual: "Manual'i aç", appearance: "Görünüm", light: "Açık tema", dark: "Koyu tema",
  },
  en: {
    explore: "Explore the app screens", sample: "INTERACTIVE PREVIEW WITH SAMPLE DATA",
    home: "Workspace", manual: "Manual", mission: "Orchestrator",
    sampleNote: "Browser preview · No real project files are changed",
    project: "Project workspace", welcome: "Start a conversation. Keep your agents and their work in one place.",
    choose: "Choose a workflow", chooseDetail: "Same project, different levels of control",
    manualDetail: "Choose a CLI and model. Direct independent agents in Chat or their live terminals.",
    missionDetail: "Describe a goal. Follow the plan, delegation, and review in one conversation.",
    recent: "Recent conversations", conversation: "Improve checkout flow", waiting: "Awaiting review",
    task: "Handle checkout errors and test the changes.",
    userRequest: "Fix checkout errors and update the tests.",
    plan: "Orchestrator created a plan", research: "Researcher gathered context",
    build: "Builder prepared changes in two files", checks: "QA verified three tests",
    ready: "Changes are ready for review", review: "Open Mission Workbench",
    manualIntro: "Independent agents", manualSub: "Each agent has its own context and terminal.",
    agentCard: "Claude Code · Chat", agentAnswer: "I’ll inspect the relevant files before changing the checkout flow.",
    codeLine: "Inspecting src/checkout/checkout.tsx", prompt: "Write a sample task…",
    sent: "Sample message received. No real AI was run.",
    planTitle: "Plan and tasks", planDetail: "Plan, specialist agents, and review in one flow.",
    changesTitle: "Changes", checksTitle: "Verification", testsPassed: "3 tests passed",
    approve: "Complete sample", approved: "Sample complete", reset: "Reset sample",
    search: "Search screens…", searchHint: "Choose a result to switch between the sample screens.",
    dialog: "Mission Workbench", previewOnly: "This is an interface preview; it never writes to your files.",
    openProject: "Open project", viewMission: "View mission", openManual: "Open Manual", appearance: "Appearance", light: "Light", dark: "Dark",
  },
} as const;

function MiniPreview({ language }: { language: LandingLanguage }) {
  const c = copy[language];
  return <div className="agent-mini agent-preview" aria-hidden="true">
    <div className="agent-mini-bar"><img src="/logo.svg" alt="" />Workspace overview <span>Atris Studio</span><span>− &nbsp; □ &nbsp; ×</span></div>
    <div className="agent-mini-body"><div className="agent-mini-rail"><Search /><House /><FolderGit2 /><History /><UsersRound /></div><aside><strong>Workspaces</strong><small>PROJECTS &nbsp; 1</small><span>⌄ &nbsp; Atris Studio</span><small>MANUAL &nbsp; 1</small><span>　{c.manual}</span><small>ORCHESTRATOR &nbsp; 1</small><span>　{c.conversation}</span></aside><main><small>{c.project}</small><h3>Atris Studio</h3><p>{c.welcome}</p><h4>{c.choose}</h4><div><article><TerminalSquare /><strong>Manual</strong><span>{c.manualDetail}</span></article><article><Workflow /><strong>Orchestrator</strong><span>{c.missionDetail}</span></article></div></main></div>
  </div>;
}

export function ProductDemo({ language, theme, onToggleTheme, compact = false }: { language: LandingLanguage; theme: "light" | "dark"; onToggleTheme?: () => void; compact?: boolean }) {
  const [scene, setScene] = useState<Scene>("home");
  const [paneOpen, setPaneOpen] = useState(true);
  const [workbench, setWorkbench] = useState(false);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("plan");
  const [searchOpen, setSearchOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const [missionDraft, setMissionDraft] = useState("");
  const [missionMessage, setMissionMessage] = useState("");
  const [approved, setApproved] = useState(false);
  const [surface, setSurface] = useState<"chat" | "code">("chat");
  const c = copy[language];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSearchOpen(false); setWorkbench(false); setAppearanceOpen(false); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (compact) return <MiniPreview language={language} />;

  const selectScene = (next: Scene) => { setScene(next); setSearchOpen(false); setWorkbench(false); };
  const tabs: Scene[] = ["home", "manual", "mission"];

  return <div className="agent-preview">
    <div className="agent-preview-heading"><span>{c.sample}</span><span>ATRISAGENT / DESKTOP UI</span></div>
    <div className="agent-preview-tabs" role="tablist" aria-label={c.explore}>
      {tabs.map((tab, index) => <button key={tab} id={`agent-demo-tab-${tab}`} type="button" role="tab" aria-controls={`agent-demo-panel-${tab}`} aria-selected={scene === tab} tabIndex={scene === tab ? 0 : -1} onClick={() => selectScene(tab)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = tabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % tabs.length]; selectScene(next); document.getElementById(`agent-demo-tab-${next}`)?.focus(); } }}>{c[tab]}</button>)}
    </div>
    <div className="agent-window" role="tabpanel" id={`agent-demo-panel-${scene}`} aria-labelledby={`agent-demo-tab-${scene}`}>
      <header className="agent-titlebar"><img src="/logo.svg" alt="" /><strong>{scene === "home" ? "Workspace overview" : scene === "manual" ? "Manual workspace" : c.conversation}</strong><span className="agent-project-badge">ATRIS STUDIO</span><span className="agent-titlebar-spacer" /><span className="agent-window-controls" aria-hidden="true"><Minus /><Square /><X /></span></header>
      <div className="agent-window-body">
        <aside className={paneOpen ? "agent-sidebar" : "agent-sidebar collapsed"} aria-label="Sample project navigation">
          <nav className="agent-rail" aria-label="Sample main navigation">
            <button type="button" onClick={() => setSearchOpen(true)} aria-label={c.search} title={c.search}><Search /></button>
            <span className="agent-rail-rule" />
            <button type="button" className={scene === "home" ? "active" : ""} onClick={() => selectScene("home")} aria-label={c.home} title={c.home}><House /></button>
            <button type="button" onClick={() => selectScene("home")} aria-label="Projects" title="Projects"><FolderGit2 /></button>
            <button type="button" className={paneOpen ? "active" : ""} onClick={() => setPaneOpen(!paneOpen)} aria-label={paneOpen ? "Hide workspaces" : "Show workspaces"} aria-expanded={paneOpen} title="Workspaces"><PanelLeft /></button>
            <button type="button" onClick={() => selectScene("mission")} aria-label="History" title="History"><History /></button>
            <button type="button" onClick={() => { setScene("mission"); setWorkbenchTab("checks"); setWorkbench(true); }} aria-label="Insights" title="Insights"><BarChart2 /></button>
            <button type="button" onClick={() => selectScene("manual")} aria-label="Agents" title="Agents"><UsersRound /></button>
            <button type="button" className="agent-rail-account" onClick={() => setAppearanceOpen(!appearanceOpen)} aria-label={c.appearance} aria-expanded={appearanceOpen} title={c.appearance}><span>DE</span></button>
          </nav>
          {paneOpen && <div className="agent-pane"><div className="agent-pane-header">Workspaces <button type="button" onClick={() => setPaneOpen(false)} aria-label="Hide workspaces"><PanelLeft /></button></div><div className="agent-pane-projects"><div className="agent-pane-label">Projects <span>1</span><button type="button" onClick={() => selectScene("home")} aria-label={c.openProject}><Plus /></button></div><button type="button" className="agent-project-row" onClick={() => selectScene("home")}><ChevronDown /><FolderGit2 />Atris Studio</button><div className="agent-pane-group"><div><TerminalSquare />Manual <span>1</span><button type="button" onClick={() => selectScene("manual")} aria-label={c.openManual}><Plus /></button></div><button type="button" onClick={() => selectScene("manual")} className={scene === "manual" ? "active" : ""}>{c.manual}</button><div><Workflow />Orchestrator <span>1</span><button type="button" onClick={() => selectScene("mission")} aria-label={c.viewMission}><Plus /></button></div><button type="button" onClick={() => selectScene("mission")} className={scene === "mission" ? "active" : ""}>{c.conversation}<small>{approved ? c.approved : c.waiting}</small></button></div></div></div>}
          {appearanceOpen && <div className="agent-appearance" role="group" aria-label={c.appearance}><strong>{c.appearance}</strong><div><button type="button" aria-pressed={theme === "light"} onClick={() => { if (theme !== "light") onToggleTheme?.(); }}><Sun /> {c.light}</button><button type="button" aria-pressed={theme === "dark"} onClick={() => { if (theme !== "dark") onToggleTheme?.(); }}><Moon /> {c.dark}</button></div></div>}
        </aside>
        <main className="agent-main">
          {scene === "home" ? <div className="agent-home"><div className="agent-home-top"><span><FolderGit2 /> {c.project}</span><span>Projects</span></div><h2>Atris Studio</h2><p>{c.welcome}</p><div className="agent-section-title"><strong>{c.choose}</strong><span>{c.chooseDetail}</span></div><div className="agent-workflow-cards"><button type="button" onClick={() => selectScene("manual")}><span className="agent-workflow-icon"><TerminalSquare /></span><span className="agent-workflow-label">You lead</span><strong>Manual</strong><p>{c.manualDetail}</p><span className="agent-workflow-foot">Start manual conversation <ArrowRight /></span></button><button type="button" onClick={() => selectScene("mission")}><span className="agent-workflow-icon"><Workflow /></span><span className="agent-workflow-label">Agents coordinate</span><strong>Orchestrator</strong><p>{c.missionDetail}</p><span className="agent-workflow-foot">Start orchestrated conversation <ArrowRight /></span></button></div><div className="agent-section-title"><strong>{c.recent}</strong><span>In this project</span></div><button type="button" className="agent-recent" onClick={() => selectScene("mission")}><span><Workflow /></span><span>{c.conversation}<small>{approved ? c.approved : c.waiting}</small></span><span>Orchestrator</span><ArrowRight /></button></div> : scene === "manual" ? <div className="agent-manual"><div className="agent-manual-head"><div><small>Manual workspace / Atris Studio</small><h2>{c.manualIntro}</h2><p>{c.manualSub}</p></div><span>1 agent</span></div><div className="agent-manual-tabs" role="group" aria-label="Manual surface"><button type="button" className={surface === "chat" ? "selected" : ""} aria-pressed={surface === "chat"} onClick={() => setSurface("chat")}><MessageSquare /> Chat</button><button type="button" className={surface === "code" ? "selected" : ""} aria-pressed={surface === "code"} onClick={() => setSurface("code")}><Code2 /> Code</button></div><div className="agent-manual-agent"><span><Bot /> Claude Code</span><span>Default model <ChevronDown /></span></div>{surface === "chat" ? <div className="agent-manual-feed"><div className="agent-manual-message"><span>DE</span><div><strong>You</strong><p>{c.userRequest}</p></div></div><div className="agent-manual-message"><span><Bot /></span><div><strong>Claude Code</strong><p>{c.agentAnswer}</p><small><FileCode2 /> {c.codeLine}</small></div></div>{message && <div className="agent-manual-message"><span>DE</span><div><strong>You</strong><p>{message}</p><small>{c.sent}</small></div></div>}</div> : <div className="agent-terminal"><div><TerminalSquare /> Claude Code <span>LOCAL TERMINAL · SAMPLE</span></div><pre>{`$ claude\n> ${c.userRequest}\n\n  ${c.codeLine}\n  ✓ checkout.tsx\n  ✓ checkout.test.tsx\n\n$ _`}</pre></div>}<form className="agent-composer" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { setMessage(draft.trim()); setDraft(""); setSurface("chat"); } }}><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={c.prompt} aria-label={c.prompt} /><div><span><Plus /> Claude Code · Chat</span><button type="submit" disabled={!draft.trim()} aria-label="Send sample message"><Send /></button></div></form></div> : <div className="agent-mission"><div className="agent-mission-tabs"><span>Chat</span><button type="button" onClick={() => { setWorkbenchTab("checks"); setWorkbench(true); }}>Diagnostics</button></div><div className="agent-mission-state"><span>4 of 4 steps complete</span><span><ShieldCheck />{approved ? c.approved : c.waiting}</span></div><div className="agent-mission-stream"><div className="agent-mission-user"><span>You</span><p>{c.userRequest}</p></div><div className="agent-stream-event"><span><Workflow /></span><div><small>Orchestrator · Mission started</small><strong>{c.plan}</strong><p>{c.planDetail}</p></div></div><div className="agent-stream-event"><span><Search /></span><div><small>Researcher · Context</small><strong>{c.research}</strong><p>src/checkout/checkout.tsx</p></div></div><div className="agent-stream-event"><span><Code2 /></span><div><small>Builder · Changes</small><strong>{c.build}</strong><p>checkout.tsx · checkout.test.tsx</p></div></div><div className="agent-stream-event"><span><Check /></span><div><small>QA · Verified</small><strong>{c.checks}</strong><p>{c.testsPassed}</p></div></div><div className="agent-review-callout"><ShieldCheck /><div><strong>{approved ? c.approved : c.ready}</strong><p>{c.previewOnly}</p><button type="button" onClick={() => { setWorkbenchTab("changes"); setWorkbench(true); }}>{c.review}<ArrowRight /></button></div></div>{missionMessage && <div className="agent-mission-user"><span>You</span><p>{missionMessage}</p><small>{c.sent}</small></div>}</div><form className="agent-mission-composer" onSubmit={(event) => { event.preventDefault(); if (missionDraft.trim()) { setMissionMessage(missionDraft.trim()); setMissionDraft(""); } }}><input value={missionDraft} onChange={(event) => setMissionDraft(event.target.value)} placeholder={c.prompt} aria-label={c.prompt} /><button type="submit" disabled={!missionDraft.trim()} aria-label="Send sample message"><Send /></button></form></div>}
        </main>
      </div>
      {searchOpen && <div className="agent-overlay" onClick={() => setSearchOpen(false)}><div className="agent-search-dialog" role="dialog" aria-modal="true" aria-label={c.search} onClick={(event) => event.stopPropagation()}><div><Search /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={c.search} aria-label={c.search} /><button type="button" onClick={() => setSearchOpen(false)} aria-label="Close search"><X /></button></div><p>{c.searchHint}</p>{tabs.filter((tab) => !search || c[tab].toLowerCase().includes(search.toLowerCase())).map((tab) => <button type="button" key={tab} onClick={() => { selectScene(tab); setSearch(""); }}><ChevronRight />{c[tab]}<ArrowRight /></button>)}</div></div>}
      {workbench && <div className="agent-overlay" onClick={() => setWorkbench(false)}><div className="agent-workbench" role="dialog" aria-modal="true" aria-label={c.dialog} onClick={(event) => event.stopPropagation()}><header><div><small>Orchestrator</small><h2>Mission Workbench</h2><p>{c.planDetail}</p></div><button type="button" onClick={() => setWorkbench(false)} aria-label="Close inspector"><X /></button></header><div className="agent-workbench-body"><nav aria-label="Workbench sections">{(["plan", "changes", "checks"] as const).map((tab) => <button key={tab} type="button" className={workbenchTab === tab ? "active" : ""} onClick={() => setWorkbenchTab(tab)}>{tab === "plan" ? <ClipboardList /> : tab === "changes" ? <Code2 /> : <ShieldCheck />}{tab === "plan" ? "Plan" : tab === "changes" ? "Changes" : "Checks"}</button>)}</nav><section><div className="agent-workbench-label">{workbenchTab === "plan" ? "Overview" : workbenchTab === "changes" ? c.changesTitle : c.checksTitle}</div>{workbenchTab === "plan" ? <><h3>{c.planTitle}</h3><p>{c.planDetail}</p>{[c.plan, c.research, c.build, c.checks].map((text) => <div className="agent-workbench-row" key={text}><Check />{text}<span>Complete</span></div>)}</> : workbenchTab === "changes" ? <><h3>{c.changesTitle}</h3><p>{c.ready}</p><div className="agent-workbench-row"><FileCode2 />src/checkout/checkout.tsx <span>+16 −4</span></div><div className="agent-workbench-row"><FileCode2 />src/checkout/checkout.test.tsx <span>+8 −4</span></div><div className="agent-workbench-notice"><ShieldCheck /><span>{approved ? c.approved : c.previewOnly}</span></div><button type="button" className="agent-workbench-action" onClick={() => setApproved(!approved)}>{approved ? c.reset : c.approve}{approved ? <X /> : <Check />}</button></> : <><h3>{c.checksTitle}</h3><p>{c.testsPassed}</p>{["Checkout error handling", "Payment retry", "Order confirmation"].map((test) => <div className="agent-workbench-row" key={test}><Check />{test}<span>Passed</span></div>)}</>}</section></div></div></div>}
    </div>
    <div className="agent-preview-foot"><span>{c.sampleNote}</span><button type="button" onClick={() => selectScene(scene === "home" ? "manual" : scene === "manual" ? "mission" : "home")}>{scene === "home" ? c.openManual : scene === "manual" ? c.viewMission : c.home}<ArrowRight /></button></div>
  </div>;
}
