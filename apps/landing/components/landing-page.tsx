"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  GitBranch,
  Globe2,
  Laptop,
  Moon,
  Monitor,
  Network,
  Play,
  ShieldCheck,
  Sparkles,
  Sun,
  Workflow,
} from "lucide-react";
import { AtrisPlayground } from "./playground/atris-playground";
import { useLandingTranslation, type LandingLanguage } from "../lib/landing-i18n";

type Theme = "light" | "dark";

type DownloadCardProps = {
  platform: "win" | "mac" | "linux";
  icon: typeof Monitor;
  title: string;
  format: string;
  description: string;
};

function DownloadCard({ platform, icon: Icon, title, format, description }: DownloadCardProps) {
  const { t } = useLandingTranslation();
  // Windows and Linux are available; macOS is coming soon.
  const platformUnavailable = platform === "mac";
  const downloadsDisabled = process.env.NEXT_PUBLIC_ATRIS_AGENT_DOWNLOADS_DISABLED === "true";
  const unavailable = platformUnavailable || downloadsDisabled;
  const availabilityLabel = platformUnavailable ? t("comingSoon") : t("unavailable");
  const availabilityNote = platformUnavailable ? t("platformComingSoon") : t("unavailable");

  const downloadEndpoint =
    platform === "win"
      ? "/api/agent-github/download/windows"
      : platform === "linux"
      ? "/api/agent-github/download/linux"
      : "/api/agent-github/download/darwin";

  return (
    <article className={unavailable ? "download-card is-unavailable" : "download-card"}>
      <div>
        <div className="download-card-heading">
          <span className="download-card-icon">
            <Icon aria-hidden="true" />
          </span>
          <div>
            <strong>{title}</strong>
            <small>{format}</small>
          </div>
        </div>
        <p>{description}</p>
      </div>
      <div className="download-card-footer">
        <span className={unavailable ? "availability is-unavailable" : "availability"}>
          {unavailable ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
          {unavailable ? availabilityLabel : t("available")}
        </span>
        {unavailable ? (
          <span className="download-unavailable-note">{availabilityNote}</span>
        ) : (
          <a
            href={downloadEndpoint}
            className="download-link"
            aria-label={`${t("download")} ${title}`}
          >
            <ArrowDownToLine aria-hidden="true" />
            {t("download")}
          </a>
        )}
      </div>
    </article>
  );
}

export function LandingPage() {
  const { t, language, setLanguage } = useLandingTranslation();
  const [theme, setTheme] = useState<Theme>("dark");
  const [themeMounted, setThemeMounted] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
    const savedTheme = window.localStorage.getItem("atris_theme");
    const nextTheme: Theme = savedTheme === "light" ? "light" : "dark";
    setTheme(nextTheme);
    setThemeMounted(true);
    document.documentElement.classList.toggle("dark", nextTheme === "dark");

    const handleScroll = () => {
      setShowBackToTop(window.scrollY > 350);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setLanguageOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLanguageOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const toggleTheme = () => {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    window.localStorage.setItem("atris_theme", nextTheme);
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
  };

  const selectLanguage = (nextLanguage: LandingLanguage) => {
    setLanguage(nextLanguage);
    setLanguageOpen(false);
  };

  return (
    <div className="landing-page">
      <header className="landing-header">
        <a className="brand-link" href="/" aria-label="AtrisAgent home">
          <img src="/logo.svg" alt="" />
          <span>ATRISAGENT</span>
        </a>
        <nav className="landing-nav" aria-label="Primary navigation">
          <a href="#playground">{t("navPlayground")}</a>
          <a href="#capabilities">{t("navProduct")}</a>
          <a href="#workflow">{t("navWorkflow")}</a>
          <a href="#download">{t("navDownload")}</a>
        </nav>
        <div className="header-actions">
          <div className="language-menu" ref={dropdownRef}>
            <button
              className="control-button language-button"
              type="button"
              aria-label={t("languageLabel")}
              aria-haspopup="menu"
              aria-expanded={languageOpen}
              onClick={() => setLanguageOpen((open) => !open)}
            >
              <Globe2 aria-hidden="true" />
              <span>{language.toUpperCase()}</span>
              <ChevronDown aria-hidden="true" />
            </button>
            {languageOpen && (
              <div className="language-popover" role="menu">
                <button
                  className={language === "tr" ? "language-option is-selected" : "language-option"}
                  type="button"
                  role="menuitem"
                  onClick={() => selectLanguage("tr")}
                >
                  Türkçe
                </button>
                <button
                  className={language === "en" ? "language-option is-selected" : "language-option"}
                  type="button"
                  role="menuitem"
                  onClick={() => selectLanguage("en")}
                >
                  English
                </button>
              </div>
            )}
          </div>
          <button
            className="control-button theme-button"
            type="button"
            aria-label={t("themeLabel")}
            onClick={toggleTheme}
          >
            {!themeMounted ? (
              <span className="icon-placeholder" />
            ) : theme === "dark" ? (
              <Sun aria-hidden="true" />
            ) : (
              <Moon aria-hidden="true" />
            )}
          </button>
          <a className="header-cta" href="#download">
            {t("downloadApp")}
          </a>
        </div>
      </header>

      <main>
        {/* HERO SECTION - Centered, Proportional, High Authority */}
        <section className="hero-centered">
          <h1 className="hero-title">
            {t("heroTitle")} <span>{t("heroAccent")}</span> {t("heroEnding")}
          </h1>

          <p className="hero-desc">
            {t("heroDesc")}
          </p>

          <div className="hero-cta-row">
            <a className="primary-cta" href="#download">
              <ArrowDownToLine className="w-4 h-4" />
              {t("primaryCta")}
            </a>
            <a className="secondary-cta" href="#playground">
              <Play className="w-4 h-4 text-[#20bfae] fill-current" />
              {t("secondaryCta")}
            </a>
          </div>

          {/* Key Value Cards: Why AtrisAgent? */}
          <div className="value-cards-grid">
            <div className="value-card">
              <div className="value-card-icon" style={{ background: "rgba(32, 191, 174, 0.1)", border: "1px solid rgba(32, 191, 174, 0.25)", color: "#20bfae" }}>
                <Network className="w-4 h-4" />
              </div>
              <strong>
                {language === "tr" ? "Uzman Çoklu Ajan Takımı" : "Specialist Multi-Agent Team"}
              </strong>
              <p>
                {language === "tr"
                  ? "Orchestrator planlar, Researcher bağlam toplar, Builder yazar, QA test eder. Tek bir genel modele bağlı kalmaz."
                  : "Orchestrator decomposes goals, Researcher collects context, Builder edits, and QA verifies with live tests."}
              </p>
            </div>

            <div className="value-card">
              <div className="value-card-icon" style={{ background: "rgba(27, 77, 120, 0.2)", border: "1px solid rgba(27, 77, 120, 0.35)", color: "#38bdf8" }}>
                <Laptop className="w-4 h-4" />
              </div>
              <strong>
                {language === "tr" ? "Yerel & İzole Worktree" : "Local & Isolated Worktrees"}
              </strong>
              <p>
                {language === "tr"
                  ? "Kodunuz kapalı üçüncü taraf bulutlara gitmez. Kendi bilgisayarınızda izole Git worktree dallarında güvenle çalışır."
                  : "Your code stays on your machine. All changes run in isolated Git worktree branches without polluting main."}
              </p>
            </div>

            <div className="value-card">
              <div className="value-card-icon" style={{ background: "rgba(168, 85, 247, 0.12)", border: "1px solid rgba(168, 85, 247, 0.25)", color: "#c084fc" }}>
                <ShieldCheck className="w-4 h-4" />
              </div>
              <strong>
                {language === "tr" ? "Approval-First İnsan Kontrolü" : "Approval-First Human Gates"}
              </strong>
              <p>
                {language === "tr"
                  ? "Kritik dosya silme, bağımlılık ekleme ve veritabanı işlemlerinde zorunlu onay kapıları ile kontrol sizde kalır."
                  : "High-impact changes and shell operations require explicit human approval before being applied."}
              </p>
            </div>
          </div>
        </section>

        {/* INTERACTIVE PLAYGROUND SANDBOX SECTION */}
        <section id="playground" className="section-shell">
          <div className="section-heading">
            <span className="eyebrow">
              <Sparkles className="w-3.5 h-3.5" />
              {t("playgroundEyebrow")}
            </span>
            <h2>{t("playgroundTitle")}</h2>
            <p>{t("playgroundDesc")}</p>
          </div>

          <div className="desktop-playground-frame">
            <AtrisPlayground locale={language} />
          </div>
        </section>

        {/* CAPABILITIES SECTION */}
        <section id="capabilities" className="section-shell">
          <div className="section-heading">
            <span className="eyebrow">{t("productEyebrow")}</span>
            <h2>{t("productTitle")}</h2>
            <p>{t("productDesc")}</p>
          </div>

          <div className="capabilities-grid">
            <div className="capability-card">
              <div className="value-card-icon" style={{ background: "rgba(32, 191, 174, 0.1)", border: "1px solid rgba(32, 191, 174, 0.2)", color: "#20bfae" }}>
                <Workflow className="w-4 h-4" />
              </div>
              <strong>{t("missionFirstTitle")}</strong>
              <p>{t("missionFirstDesc")}</p>
            </div>

            <div className="capability-card">
              <div className="value-card-icon" style={{ background: "rgba(56, 189, 248, 0.1)", border: "1px solid rgba(56, 189, 248, 0.2)", color: "#38bdf8" }}>
                <Network className="w-4 h-4" />
              </div>
              <strong>{t("runtimeTitle")}</strong>
              <p>{t("runtimeDesc")}</p>
            </div>

            <div className="capability-card">
              <div className="value-card-icon" style={{ background: "rgba(168, 85, 247, 0.1)", border: "1px solid rgba(168, 85, 247, 0.2)", color: "#c084fc" }}>
                <GitBranch className="w-4 h-4" />
              </div>
              <strong>{t("workspaceTitle")}</strong>
              <p>{t("workspaceDesc")}</p>
            </div>

            <div className="capability-card">
              <div className="value-card-icon" style={{ background: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.2)", color: "#fbbf24" }}>
                <ShieldCheck className="w-4 h-4" />
              </div>
              <strong>{t("reviewControlTitle")}</strong>
              <p>{t("reviewControlDesc")}</p>
            </div>
          </div>
        </section>

        {/* WORKFLOW PIPELINE SECTION */}
        <section id="workflow" className="section-shell">
          <div className="section-heading">
            <span className="eyebrow">{t("workflowEyebrow")}</span>
            <h2>{t("workflowTitle")}</h2>
            <p>{t("workflowDesc")}</p>
          </div>

          <div className="workflow-grid">
            <article className="workflow-card">
              <span className="workflow-step-num">01</span>
              <strong>{t("planTitle")}</strong>
              <p>{t("planDescription")}</p>
            </article>

            <article className="workflow-card">
              <span className="workflow-step-num">02</span>
              <strong>{t("buildTitle")}</strong>
              <p>{t("buildDescription")}</p>
            </article>

            <article className="workflow-card">
              <span className="workflow-step-num">03</span>
              <strong>{t("verifyTitle")}</strong>
              <p>{t("verifyDescription")}</p>
            </article>

            <article className="workflow-card">
              <span className="workflow-step-num">04</span>
              <strong>{t("reviewTitle")}</strong>
              <p>{t("reviewDescription")}</p>
            </article>
          </div>
        </section>

        {/* DOWNLOADS SECTION */}
        <section id="download" className="section-shell">
          <div className="section-heading">
            <span className="eyebrow">{t("downloadsEyebrow")}</span>
            <h2>{t("downloadsTitle")}</h2>
            <p>{t("downloadsDesc")}</p>
          </div>

          <div className="downloads-grid">
            <DownloadCard
              platform="win"
              icon={Monitor}
              title="Windows"
              format=".exe / MSI"
              description={t("windowsDescription")}
            />
            <DownloadCard
              platform="linux"
              icon={Monitor}
              title="Linux"
              format=".AppImage / .deb"
              description={t("linuxDescription")}
            />
            <DownloadCard
              platform="mac"
              icon={Laptop}
              title="macOS"
              format=".dmg"
              description={t("macDescription")}
            />
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="footer-inner">
          <div className="footer-grid">
            {/* Col 1: Brand */}
            <div className="footer-col">
              <div className="footer-brand">
                <img src="/logo.svg" alt="AtrisAgent" />
                <span>AtrisAgent</span>
              </div>
              <p className="footer-brand-desc">
                {language === "tr"
                  ? "Yerel ve denetimli yapay zeka ajan orkestrasyonu. Codex CLI, Claude Code, Antigravity ve OpenCode çalışma ortamlarını tek bir güvenli geliştirici merkezinde yönetin."
                  : "Mission-driven AI coding runtimes orchestration. Coordinate Codex CLI, Claude Code, Antigravity, and OpenCode in local isolated workspaces."}
              </p>
            </div>

            {/* Col 2: Ecosystem Products */}
            <div className="footer-col">
              <h4>{language === "tr" ? "Atris Ekosistemi" : "Ecosystem"}</h4>
              <ul className="footer-links">
                <li><a href="http://localhost:3000" target="_blank" rel="noopener noreferrer">AtrisHub <ExternalLink style={{ width: "11px", height: "11px" }} /></a></li>
                <li><a href="http://localhost:3001" target="_blank" rel="noopener noreferrer">AtrisChat</a></li>
                <li><a href="http://localhost:3005" target="_blank" rel="noopener noreferrer">AtrisVoice</a></li>
                <li><a href="http://localhost:3013" target="_blank" rel="noopener noreferrer">AtrisWork</a></li>
                <li><a href="http://localhost:3010" target="_blank" rel="noopener noreferrer">AtrisShot</a></li>
                <li><a href="http://localhost:3000#products">AtrisTracker</a></li>
              </ul>
            </div>

            {/* Col 3: Quick Navigation */}
            <div className="footer-col">
              <h4>{language === "tr" ? "Hızlı Bağlantılar" : "Navigation"}</h4>
              <ul className="footer-links">
                <li><a href="#product">{t("navProduct")}</a></li>
                <li><a href="#workflow">{t("navWorkflow")}</a></li>
                <li><a href="#playground">{t("navPlayground")}</a></li>
                <li><a href="#download">{t("navDownload")}</a></li>
                <li><a href="https://github.com/merteren97" target="_blank" rel="noopener noreferrer">GitHub Repo <ExternalLink style={{ width: "11px", height: "11px" }} /></a></li>
              </ul>
            </div>

            {/* Col 4: Creator / Developer Social */}
            <div className="footer-col">
              <h4>{language === "tr" ? "Geliştirici & Tasarım" : "Creator & Designer"}</h4>
              
              <a
                href="https://github.com/merteren97"
                target="_blank"
                rel="noopener noreferrer"
                className="footer-social-card"
                title="GitHub - merteren97"
              >
                <div className="social-icon-name">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                  <span>merteren97</span>
                </div>
                <ExternalLink style={{ width: "13px", height: "13px" }} />
              </a>

              <a
                href="https://www.linkedin.com/in/edip-mert-eren-232627160/"
                target="_blank"
                rel="noopener noreferrer"
                className="footer-social-card"
                title="LinkedIn - E. Mert EREN"
              >
                <div className="social-icon-name">
                  <svg viewBox="0 0 24 24" fill="#0a66c2">
                    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                  </svg>
                  <span>E. Mert EREN</span>
                </div>
                <ExternalLink style={{ width: "13px", height: "13px" }} />
              </a>
            </div>
          </div>

          <div className="footer-bottom">
            <div>
              {language === "tr"
                ? "© 2026 AtrisAgent · Atris Corporation. Tüm hakları saklıdır."
                : "© 2026 AtrisAgent · Atris Corporation. All rights reserved."}
            </div>
            <div className="footer-bottom-links">
              <span>E. Mert EREN tarafından geliştirildi</span>
              <span>·</span>
              <a href="https://github.com/merteren97" target="_blank" rel="noopener noreferrer">GitHub</a>
              <span>·</span>
              <a href="https://www.linkedin.com/in/edip-mert-eren-232627160/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
            </div>
          </div>
        </div>
      </footer>

      {showBackToTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="back-to-top-btn"
          title={language === "tr" ? "Yukarı Çık" : "Back to top"}
          aria-label="Back to top"
        >
          <ArrowUp style={{ width: "18px", height: "18px" }} />
        </button>
      )}
    </div>
  );
}

