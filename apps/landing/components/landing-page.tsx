"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  CircleAlert,
  Globe2,
  Laptop,
  Moon,
  Monitor,
  ShieldCheck,
  Sparkles,
  Sun,
  Workflow,
} from "lucide-react";
import AtrisAgentExplainerVideo from "./atris-agent-explainer-video";
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
  const platformUnavailable = platform !== "win";
  const downloadsDisabled = process.env.NEXT_PUBLIC_ATRIS_AGENT_DOWNLOADS_DISABLED === "true";
  const unavailable = platformUnavailable || downloadsDisabled;
  const availabilityLabel = platformUnavailable ? t("comingSoon") : t("unavailable");
  const availabilityNote = platformUnavailable ? t("platformComingSoon") : t("unavailable");

  return (
    <article className={unavailable ? "download-card is-unavailable" : "download-card"}>
      <div className="download-card-heading">
        <span className="download-card-icon"><Icon aria-hidden="true" /></span>
        <span>
          <strong>{title}</strong>
          <small>{format}</small>
        </span>
      </div>
      <p>{description}</p>
      <div className="download-card-footer">
        <span className={unavailable ? "availability is-unavailable" : "availability"}>
          {unavailable ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}
          {unavailable ? availabilityLabel : t("available")}
        </span>
        {unavailable ? (
          <span className="download-unavailable-note">{availabilityNote}</span>
        ) : (
          <a
            href={"/api/agent-github/download/" + platform}
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
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("atris_theme");
    const nextTheme: Theme = savedTheme === "light" ? "light" : "dark";
    setTheme(nextTheme);
    setThemeMounted(true);
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
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
          <a href="#product">{t("navProduct")}</a>
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
                <button className={language === "tr" ? "language-option is-selected" : "language-option"} type="button" role="menuitem" onClick={() => selectLanguage("tr")}>
                  Türkçe
                </button>
                <button className={language === "en" ? "language-option is-selected" : "language-option"} type="button" role="menuitem" onClick={() => selectLanguage("en")}>
                  English
                </button>
              </div>
            )}
          </div>
          <button className="control-button theme-button" type="button" aria-label={t("themeLabel")} onClick={toggleTheme}>
            {!themeMounted ? <span className="icon-placeholder" /> : theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </button>
          <a className="header-cta" href="#download">{t("downloadApp")}</a>
        </div>
      </header>

      <main>
        <section className="hero-section">
          <div className="hero-copy">
            <span className="eyebrow"><Sparkles aria-hidden="true" />{t("eyebrow")}</span>
            <h1>
              {t("heroTitle")} <span>{t("heroAccent")}</span> {t("heroEnding")}
            </h1>
            <p className="hero-description">{t("heroDesc")}</p>
            <div className="hero-actions">
              <a className="primary-cta" href="#download">
                <ArrowDownToLine aria-hidden="true" />
                {t("primaryCta")}
              </a>
              <a className="secondary-cta" href="#workflow">
                {t("secondaryCta")}
                <Workflow aria-hidden="true" />
              </a>
            </div>
            <div className="trust-row">
              <span><Check aria-hidden="true" />{t("trustLocal")}</span>
              <span><Check aria-hidden="true" />{t("trustApproval")}</span>
              <span><Check aria-hidden="true" />{t("trustEvidence")}</span>
            </div>
          </div>

          <div className="hero-orbit" aria-hidden="true">
            <div className="orbit-glow" />
            <div className="orbit-ring orbit-ring-one" />
            <div className="orbit-ring orbit-ring-two" />
            <div className="orbit-core"><img src="/logo.svg" alt="" /></div>
            <span className="orbit-node orbit-node-one"><ShieldCheck /></span>
            <span className="orbit-node orbit-node-two"><Workflow /></span>
            <span className="orbit-node orbit-node-three"><Laptop /></span>
          </div>
        </section>

        <section className="workflow-section section-shell" id="product">
          <span className="section-anchor" id="workflow" aria-hidden="true" />
          <div className="section-heading">
            <span className="eyebrow">{t("workflowEyebrow")}</span>
            <h2>{t("workflowTitle")}</h2>
            <p>{t("workflowDesc")}</p>
          </div>
          <AtrisAgentExplainerVideo locale={language} />
        </section>

        <section className="download-section section-shell" id="download">
          <div className="section-heading">
            <span className="eyebrow"><ArrowDownToLine aria-hidden="true" />{t("downloadsEyebrow")}</span>
            <h2>{t("downloadsTitle")}</h2>
            <p>{t("downloadsDesc")}</p>
          </div>
          <div className="download-grid">
            <DownloadCard platform="win" icon={Monitor} title="Windows" format=".exe / .msi" description={t("windowsDescription")} />
            <DownloadCard platform="mac" icon={Laptop} title="macOS" format=".dmg / Universal" description={t("macDescription")} />
            <DownloadCard platform="linux" icon={Laptop} title="Linux" format=".AppImage / .deb" description={t("linuxDescription")} />
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span>{t("footer")}</span>
        <span className="footer-boundary">agent.atrishub.com</span>
      </footer>
    </div>
  );
}
