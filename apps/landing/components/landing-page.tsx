"use client";

import { useEffect, useState } from "react";
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown,
  CircleHelp, Code2, Download, FolderGit2, Globe2,
  Laptop, Menu, Monitor, Moon, ShieldCheck, Sun, TerminalSquare,
  Workflow, X,
} from "lucide-react";
import { useLandingTranslation } from "../lib/landing-i18n";
import { ProductDemo } from "./product-demo";

type Theme = "light" | "dark";

const copy = {
  tr: {
    navDemo: "Ürünü keşfet", navFeatures: "Özellikler", navFlow: "İş akışı", navDownload: "İndir",
    eyebrow: "ATRIS EKOSİSTEMİ / GELİŞTİRİCİ ARAÇLARI",
    heroFirst: "Fikirden çalışan koda.", heroSecond: "Kontrol hep sizde.",
    heroDescription: "AtrisAgent, kullandığınız AI kodlama araçlarını tek bir masaüstü çalışma alanında bir araya getirir. Projeyi açın, işi ajanlara dağıtın, her adımı görün ve değişiklikleri onaylayın.",
    getApp: "Ücretsiz indir", explore: "Uygulamayı keşfet", heroNote: "Windows ve Linux için mevcut · macOS yakında",
    productLabel: "ÜRÜNÜN İÇİNDEN", productTitle: "Gerçek çalışma alanına yakından bakın.",
    productDescription: "Masaüstü uygulamasının ekran düzeni ve akışları temel alınarak hazırlanmış etkileşimli bir tarayıcı önizlemesi. Örnek bir projede ekranlar arasında geçiş yapın.",
    demoDisclaimer: "Örnek verilerle çalışan arayüz önizlemesi · Gerçek dosyalarınızda işlem yapmaz",
    featureLabel: "NEDEN ATRISAGENT", featureTitle: "Birden fazla ajan. Tek bir net akış.",
    featureDescription: "Günlük geliştirme işlerini dağınık terminal oturumlarından çıkarıp izlenebilir bir çalışma alanına taşıyın.",
    features: [
      ["01 / PROJE", "Projeniz merkezde", "Yerel proje klasörünüzden başlayın. Konuşmalar, görevler ve ajan oturumları aynı çalışma alanında düzenli kalsın."],
      ["02 / ARAÇLAR", "Seçim sizin", "Codex CLI, Claude Code, Antigravity ve OpenCode gibi mevcut araçlarınızı görev için uygun yerde kullanın."],
      ["03 / KONTROL", "Karar sizde", "Planı, araç adımlarını ve değişiklikleri görün. Hassas işlemlerde onay verin; sonucu inceleyerek uygulayın."],
    ],
    flowLabel: "İKİ ÇALIŞMA BİÇİMİ", flowTitle: "İhtiyacınız kadar otomasyon.",
    flowDescription: "Hızlı bir değişiklikte doğrudan yönetin; daha kapsamlı bir işte uzman ajanların birlikte çalışmasını izleyin.",
    manual: "Manual", manualDescription: "CLI ve modeli seçin. Bağımsız ajanlarla sohbet veya canlı terminal üzerinden doğrudan çalışın.",
    orchestrator: "Orchestrator", orchestratorDescription: "Hedefinizi anlatın. Plan, araştırma, geliştirme, doğrulama ve review tek konuşmada ilerlesin.",
    downloadLabel: "MASAÜSTÜ UYGULAMASI", downloadTitle: "Bir sonraki projeniz burada başlasın.",
    downloadDescription: "AtrisAgent erken erişimde ücretsiz. İşletim sisteminiz için güncel paketi indirin ve kendi bilgisayarınızda çalışmaya başlayın.",
    windows: "Windows için indir", linux: "Linux için indir", appimage: "AppImage indir", deb: ".deb indir", available: "İndirmeye hazır", unavailable: "İndirmeler şu anda kapalı", soon: "Yakında", macNote: "macOS paketi hazırlanıyor.",
    linuxNote: "AppImage çoğu dağıtımda çalışır; Debian/Ubuntu için .deb seçin.",
    windowsNote: "64-bit Windows kurulum paketi (.exe)",
    releaseLink: "Sürüm notlarını GitHub'da gör", footer: "Yerel çalışma alanınız. Sizin kontrolünüz.",
    theme: "Temayı değiştir", language: "Dil değiştir", menu: "Menüyü aç", closeMenu: "Menüyü kapat", top: "Başa dön",
  },
  en: {
    navDemo: "Explore the product", navFeatures: "Features", navFlow: "Workflow", navDownload: "Download",
    eyebrow: "ATRIS ECOSYSTEM / DEVELOPER TOOLS",
    heroFirst: "From idea to working code.", heroSecond: "You stay in control.",
    heroDescription: "AtrisAgent brings the AI coding tools you already use into one desktop workspace. Open a project, delegate the work, see every step, and approve the changes.",
    getApp: "Download for free", explore: "Explore the app", heroNote: "Available for Windows and Linux · macOS coming soon",
    productLabel: "INSIDE THE PRODUCT", productTitle: "Get closer to the real workspace.",
    productDescription: "An interactive browser preview based on the desktop app's screen layout and workflows. Switch between views in a sample project.",
    demoDisclaimer: "Interface preview with sample data · Does not modify your files",
    featureLabel: "WHY ATRISAGENT", featureTitle: "Multiple agents. One clear workflow.",
    featureDescription: "Move everyday development work out of scattered terminal sessions into a workspace you can follow.",
    features: [
      ["01 / PROJECT", "Your project at the center", "Start with a local project folder. Keep conversations, tasks and agent sessions organized in one workspace."],
      ["02 / TOOLS", "Your choice of tools", "Use your existing tools like Codex CLI, Claude Code, Antigravity and OpenCode where they fit the task."],
      ["03 / CONTROL", "Your decision", "See the plan, tool steps and changes. Approve sensitive actions and review the outcome before applying."],
    ],
    flowLabel: "TWO WAYS TO WORK", flowTitle: "As much automation as you need.",
    flowDescription: "Direct a quick change yourself, or follow specialist agents working together on a larger goal.",
    manual: "Manual", manualDescription: "Choose a CLI and model. Work directly with independent agents in chat or live terminals.",
    orchestrator: "Orchestrator", orchestratorDescription: "Describe your goal. Planning, research, building, verification and review happen in one conversation.",
    downloadLabel: "DESKTOP APP", downloadTitle: "Start your next project here.",
    downloadDescription: "AtrisAgent is free during early access. Download the latest package for your OS and get started on your own computer.",
    windows: "Download for Windows", linux: "Download for Linux", appimage: "Download AppImage", deb: "Download .deb", available: "Ready to download", unavailable: "Downloads are currently disabled", soon: "Coming soon", macNote: "A macOS package is in preparation.",
    linuxNote: "AppImage works on most distributions; choose .deb for Debian/Ubuntu.",
    windowsNote: "64-bit Windows installer (.exe)",
    releaseLink: "View release notes on GitHub", footer: "Your local workspace. Your control.",
    theme: "Change theme", language: "Change language", menu: "Open menu", closeMenu: "Close menu", top: "Back to top",
  },
} as const;

export function LandingPage() {
  const { language, setLanguage } = useLandingTranslation();
  const c = copy[language];
  const downloadsDisabled = process.env.NEXT_PUBLIC_ATRIS_AGENT_DOWNLOADS_DISABLED === "true";
  const [theme, setTheme] = useState<Theme>("light");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("atris_theme");
    const next = saved === "dark" ? "dark" : "light";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
  }, []);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    window.localStorage.setItem("atris_theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="landing-page">
      <a className="skip-link" href="#main">{language === "tr" ? "İçeriğe geç" : "Skip to content"}</a>
      <header className="site-header">
        <div className="site-header-inner wrap">
          <a className="brand" href="#top" onClick={closeMenu} aria-label="AtrisAgent">
            <img src="/logo.svg" alt="" /><span>Atris<span>Agent</span></span>
          </a>
          <nav className={menuOpen ? "site-nav is-open" : "site-nav"} aria-label={language === "tr" ? "Ana menü" : "Main navigation"}>
            <a href="#demo" onClick={closeMenu}>{c.navDemo}</a>
            <a href="#features" onClick={closeMenu}>{c.navFeatures}</a>
            <a href="#workflow" onClick={closeMenu}>{c.navFlow}</a>
            <a href="#download" onClick={closeMenu}>{c.navDownload}</a>
          </nav>
          <div className="header-tools">
            <button className="icon-control language-control" type="button" onClick={() => setLanguage(language === "tr" ? "en" : "tr")} aria-label={c.language} title={c.language}>
              <Globe2 aria-hidden="true" /><span>{language.toUpperCase()}</span>
            </button>
            <button className="icon-control" type="button" onClick={toggleTheme} aria-label={c.theme} title={c.theme}>
              {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </button>
            <a className="header-download" href="#download">{c.getApp} <ArrowDownToLine aria-hidden="true" /></a>
            <button className="icon-control mobile-menu-button" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? c.closeMenu : c.menu} aria-expanded={menuOpen}>
              {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            </button>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="hero wrap" id="top">
          <div className="hero-copy">
            <p className="eyebrow"><span className="signal" />{c.eyebrow}</p>
            <h1>{c.heroFirst}<br /><span>{c.heroSecond}</span></h1>
            <p className="hero-description">{c.heroDescription}</p>
            <div className="hero-actions">
              <a href="#download" className="button button-primary">{c.getApp}<ArrowDownToLine aria-hidden="true" /></a>
              <a href="#demo" className="button button-quiet">{c.explore}<ArrowRight aria-hidden="true" /></a>
            </div>
            <p className="hero-note"><Check aria-hidden="true" /> {c.heroNote}</p>
          </div>
          <a className="hero-visual" href="#demo" aria-label={c.explore}>
            <div className="hero-visual-top"><span><span className="signal" /> ATRISAGENT / WORKSPACE</span><span>01 — 03</span></div>
            <div className="hero-visual-image"><ProductDemo language={language} theme={theme} compact /></div>
            <div className="hero-visual-bottom"><span>{language === "tr" ? "ÜRÜN ARAYÜZÜNDEN BİR KESİT" : "A LOOK INSIDE THE PRODUCT"}</span><ArrowUpRight aria-hidden="true" /></div>
          </a>
        </section>

        <div className="product-strip"><div className="wrap strip-inner"><span>{language === "tr" ? "KULLANDIĞINIZ ARAÇLARLA ÇALIŞIR" : "WORKS WITH YOUR TOOLS"}</span><strong>Codex CLI</strong><strong>Claude Code</strong><strong>Antigravity</strong><strong>OpenCode</strong></div></div>

        <section className="section demo-section" id="demo">
          <div className="wrap">
            <div className="section-intro"><div><p className="eyebrow">{c.productLabel}</p><h2>{c.productTitle}</h2></div><p>{c.productDescription}</p></div>
            <ProductDemo language={language} theme={theme} onToggleTheme={toggleTheme} />
            <p className="demo-caption"><CircleHelp aria-hidden="true" />{c.demoDisclaimer}</p>
          </div>
        </section>

        <section className="section features-section wrap" id="features">
          <div className="section-intro"><div><p className="eyebrow">{c.featureLabel}</p><h2>{c.featureTitle}</h2></div><p>{c.featureDescription}</p></div>
          <div className="features-grid">
            {[FolderGit2, Code2, ShieldCheck].map((Icon, index) => (
              <article className="feature" key={index}>
                <div className="feature-top"><span>{c.features[index][0]}</span><Icon aria-hidden="true" /></div>
                <h3>{c.features[index][1]}</h3><p>{c.features[index][2]}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="section workflow-section" id="workflow"><div className="wrap workflow-layout">
          <div><p className="eyebrow">{c.flowLabel}</p><h2>{c.flowTitle}</h2><p className="section-lead">{c.flowDescription}</p><a href="#demo" className="text-link">{c.explore}<ArrowRight aria-hidden="true" /></a></div>
          <div className="workflow-options">
            <article><span className="workflow-icon"><TerminalSquare aria-hidden="true" /></span><div><span className="small-index">01 / YOU LEAD</span><h3>{c.manual}</h3><p>{c.manualDescription}</p></div><ArrowUpRight aria-hidden="true" /></article>
            <article><span className="workflow-icon"><Workflow aria-hidden="true" /></span><div><span className="small-index">02 / AGENTS COORDINATE</span><h3>{c.orchestrator}</h3><p>{c.orchestratorDescription}</p></div><ArrowUpRight aria-hidden="true" /></article>
          </div>
        </div></section>

        <section className="section download-section wrap" id="download">
          <div className="section-intro"><div><p className="eyebrow">{c.downloadLabel}</p><h2>{c.downloadTitle}</h2></div><p>{c.downloadDescription}</p></div>
          <div className="download-grid">
            <article className="download-card"><div className="download-card-top"><Monitor aria-hidden="true" /><span>{downloadsDisabled ? c.unavailable : c.available}</span></div><h3>Windows</h3><p>{c.windowsNote}</p>{downloadsDisabled ? <span className="download-placeholder">{c.unavailable}</span> : <a className="download-action" href="/api/agent-github/download/windows">{c.windows}<Download aria-hidden="true" /></a>}</article>
            <article className="download-card featured-download"><div className="download-card-top"><Laptop aria-hidden="true" /><span>{downloadsDisabled ? c.unavailable : c.available}</span></div><h3>Linux</h3><p>{c.linuxNote}</p>{downloadsDisabled ? <span className="download-placeholder">{c.unavailable}</span> : <div className="linux-actions"><a className="download-action" href="/api/agent-github/download/linux">{c.appimage}<Download aria-hidden="true" /></a><a className="download-action secondary-download" href="/api/agent-github/download/linux-deb">{c.deb}<Download aria-hidden="true" /></a></div>}</article>
            <article className="download-card muted-download"><div className="download-card-top"><Laptop aria-hidden="true" /><span>{c.soon}</span></div><h3>macOS</h3><p>{c.macNote}</p><span className="download-placeholder">{c.soon}<ChevronDown aria-hidden="true" /></span></article>
          </div>
          <a className="release-link" href="https://github.com/merteren97/AtrisAgent/releases/latest" target="_blank" rel="noopener noreferrer">{c.releaseLink}<ArrowUpRight aria-hidden="true" /></a>
        </section>
      </main>
      <footer className="site-footer"><div className="wrap footer-inner"><div><a className="brand" href="#top"><img src="/logo.svg" alt="" /><span>Atris<span>Agent</span></span></a><p>{c.footer}</p></div><div className="footer-links"><a href="https://atrishub.com" target="_blank" rel="noopener noreferrer">AtrisHub <ArrowUpRight aria-hidden="true" /></a><a href="https://github.com/merteren97/AtrisAgent" target="_blank" rel="noopener noreferrer">GitHub <ArrowUpRight aria-hidden="true" /></a><a href="#top">{c.top} ↑</a></div></div><div className="wrap footer-bottom">© 2026 AtrisAgent <span>PART OF THE ATRIS ECOSYSTEM</span></div></footer>
    </div>
  );
}
