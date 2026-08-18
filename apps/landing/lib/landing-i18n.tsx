"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type LandingLanguage = "tr" | "en";

const translations = {
  tr: {
    navProduct: "Ürün",
    navWorkflow: "Nasıl çalışır?",
    navPlayground: "Canlı Demo",
    navDownload: "İndir",
    languageLabel: "Dil seç",
    themeLabel: "Temayı değiştir",
    downloadApp: "Uygulamayı indir",
    eyebrow: "Mission-driven · local-first AI çalışma alanı",
    earlyAccess: "Erken erişimde ücretsiz",
    heroTitle: "Bir geliştirme hedefini",
    heroAccent: "uzman AI ajanlarına",
    heroEnding: "kontrollü biçimde dağıtın.",
    heroDesc: "AtrisAgent, Codex CLI, Claude Code, Antigravity ve OpenCode gibi resmi AI coding runtime'larını yerel workspace üzerinde orkestre eder. Mission planı, uzman ajanlar, review ve onay sınırları aynı masaüstü akışında kalır.",
    primaryCta: "Uygulamayı indir",
    secondaryCta: "Canlı Demoyu Dene",
    trustLocal: "Yerel workspace",
    trustApproval: "Approval-first kontrol",
    trustEvidence: "Review ve rollback sınırları",
    playgroundEyebrow: "Sıfır Kurulum · Tarayıcıda Canlı Sandbox",
    playgroundTitle: "AtrisAgent'ı şimdi doğrudan deneyimleyin.",
    playgroundDesc: "Gerçekçi geliştirici senaryolarını çalıştırın, çoklu ajan düşüncelerini izleyin, terminal tool yürütümlerini ve onay mekanizmasını interaktif test edin.",
    productEyebrow: "Bir model sağlayıcısı değil, orkestrasyon katmanı",
    productTitle: "AI coding runtime'larınız için mission control.",
    productDesc: "AtrisAgent kendi modelini satmaz. Mevcut resmi CLI hesaplarınızı görev, rol, workspace izolasyonu ve review akışı etrafında düzenler.",
    missionFirstTitle: "Mission-first çalışma",
    missionFirstDesc: "Her konuşma kendi mission timeline'ına, planına, agent takımına ve geçmişine sahip olur.",
    runtimeTitle: "Runtime ve model routing",
    runtimeDesc: "Codex CLI, Claude Code, Antigravity ve OpenCode arasında göreve uygun runtime/model seçimini yönetin.",
    workspaceTitle: "İzole workspace",
    workspaceDesc: "Worktree ve candidate workspace yaklaşımıyla ana çalışma alanını koruyarak değişiklik hazırlayın.",
    reviewControlTitle: "Review, approval ve rollback",
    reviewControlDesc: "Restricted işlemleri görünür tutun; değişiklikleri review edin, apply kararını açık verin ve gerektiğinde geri alın.",
    workflowEyebrow: "Güncel AtrisAgent uygulama akışı",
    workflowTitle: "Mission'dan review'e kadar tek görünür çalışma alanı.",
    workflowDesc: "Orchestrator işi planlar; Researcher, Builder, QA ve Reviewer uzman görevleri yürütür. Her agent session workspace ağacında ve mission timeline'da izlenebilir kalır.",
    previewLoading: "AtrisAgent çalışma alanı hazırlanıyor…",
    previewUnavailableTitle: "Önizleme şu anda kullanılamıyor.",
    previewUnavailableDesc: "Güncel ürün deneyimini görmek için masaüstü uygulamasını açın.",
    previewRetry: "Tekrar dene",
    previewStatus: "Mission çalışıyor",
    planApproval: "Plan onayı",
    fileChange: "Dosya değişikliği",
    testReport: "QA doğrulaması",
    reviewPack: "Review paketi",
    planTitle: "Planla",
    planDescription: "Orchestrator hedefi mission planına dönüştürür ve uzman ajanlara dağıtır.",
    buildTitle: "Araştır ve geliştir",
    buildDescription: "Researcher bağlam toplar; Builder izole workspace üzerinde değişiklik hazırlar.",
    verifyTitle: "Doğrula",
    verifyDescription: "QA agent test ve doğrulama adımlarını yürütür, evidence üretir.",
    reviewTitle: "Review et",
    reviewDescription: "Reviewer sonucu, diff'i ve riskleri inceler; apply/rollback sınırı kullanıcıda kalır.",
    downloadsEyebrow: "Masaüstü uygulaması",
    downloadsTitle: "AtrisAgent'ı yerel workspace'inize indirin.",
    downloadsDesc: "AtrisAgent erken erişim döneminde ücretsizdir. Yerel proje workspace'lerinizi ve resmi CLI hesaplarınızı kendi bilgisayarınızda yönetin.",
    available: "İndirmeye hazır",
    unavailable: "Sürüm şu anda kullanılamıyor",
    comingSoon: "Yakında",
    platformComingSoon: "Bu platform için sürüm hazırlanıyor.",
    download: "İndir",
    windowsDescription: "Windows için güncel AtrisAgent masaüstü paketi ve otomatik güncelleme akışı.",
    macDescription: "macOS desteği ürün yol haritasında hazırlanıyor.",
    linuxDescription: "Linux masaüstü paketleri ürün yol haritasında hazırlanıyor.",
    footer: "© 2026 AtrisAgent. Tüm hakları saklıdır.",
  },
  en: {
    navProduct: "Product",
    navWorkflow: "How it works",
    navPlayground: "Live Demo",
    navDownload: "Download",
    languageLabel: "Choose language",
    themeLabel: "Change theme",
    downloadApp: "Download app",
    eyebrow: "Mission-driven · local-first AI workspace",
    earlyAccess: "Free during early access",
    heroTitle: "Turn one development goal into",
    heroAccent: "supervised specialist agents",
    heroEnding: "working as one team.",
    heroDesc: "AtrisAgent orchestrates official AI coding runtimes such as Codex CLI, Claude Code, Antigravity, and OpenCode in local workspaces. Mission plans, specialist agents, review, and approval boundaries stay in one desktop flow.",
    primaryCta: "Download the app",
    secondaryCta: "Try Live Demo",
    trustLocal: "Local workspaces",
    trustApproval: "Approval-first control",
    trustEvidence: "Review and rollback boundaries",
    playgroundEyebrow: "Zero Install · Interactive Browser Sandbox",
    playgroundTitle: "Experience AtrisAgent live right now.",
    playgroundDesc: "Run realistic developer scenarios, watch multi-agent thoughts, inspect terminal tool execution, and test interactive approval gates.",
    productEyebrow: "An orchestration layer, not another model provider",
    productTitle: "Mission control for your AI coding runtimes.",
    productDesc: "AtrisAgent does not sell its own model. It organizes your existing official CLI accounts around missions, roles, workspace isolation, and review.",
    missionFirstTitle: "Mission-first workflow",
    missionFirstDesc: "Each conversation gets its own mission timeline, plan, agent team, and persistent history.",
    runtimeTitle: "Runtime and model routing",
    runtimeDesc: "Route work across Codex CLI, Claude Code, Antigravity, and OpenCode using the runtime and model suited to the task.",
    workspaceTitle: "Isolated workspace",
    workspaceDesc: "Prepare changes through worktrees and candidate workspaces while keeping the main working tree protected.",
    reviewControlTitle: "Review, approval, and rollback",
    reviewControlDesc: "Keep restricted operations visible, review changes before apply, and retain an explicit rollback boundary.",
    workflowEyebrow: "Current AtrisAgent application flow",
    workflowTitle: "One visible workspace from mission to review.",
    workflowDesc: "The Orchestrator plans the work while Researcher, Builder, QA, and Reviewer handle specialist tasks. Every agent session remains visible in the workspace tree and mission timeline.",
    previewLoading: "Preparing the AtrisAgent workspace…",
    previewUnavailableTitle: "Preview is unavailable right now.",
    previewUnavailableDesc: "Open the desktop app to experience the current product flow.",
    previewRetry: "Try again",
    previewStatus: "Mission running",
    planApproval: "Plan approval",
    fileChange: "File change",
    testReport: "QA verification",
    reviewPack: "Review pack",
    planTitle: "Plan",
    planDescription: "The Orchestrator turns the goal into a mission plan and delegates specialist work.",
    buildTitle: "Research and build",
    buildDescription: "Researcher gathers context while Builder prepares changes inside an isolated workspace.",
    verifyTitle: "Verify",
    verifyDescription: "The QA agent runs validation steps and produces evidence for the mission.",
    reviewTitle: "Review",
    reviewDescription: "Reviewer inspects the result, diff, and risks while apply and rollback remain explicit user decisions.",
    downloadsEyebrow: "Desktop application",
    downloadsTitle: "Bring AtrisAgent to your local workspace.",
    downloadsDesc: "AtrisAgent is free during early access. Keep local project workspaces and official CLI accounts under your control on your own computer.",
    available: "Ready to download",
    unavailable: "Release currently unavailable",
    comingSoon: "Coming soon",
    platformComingSoon: "A release for this platform is in preparation.",
    download: "Download",
    windowsDescription: "Current AtrisAgent desktop package for Windows with the automatic update flow.",
    macDescription: "macOS support is being prepared on the product roadmap.",
    linuxDescription: "Linux desktop packages are being prepared on the product roadmap.",
    footer: "© 2026 AtrisAgent. All rights reserved.",
  },
} as const;

type TranslationKey = keyof (typeof translations)["tr"];

type LandingLanguageContextValue = {
  language: LandingLanguage;
  setLanguage: (language: LandingLanguage) => void;
  t: (key: TranslationKey) => string;
};

const LandingLanguageContext = createContext<LandingLanguageContextValue | null>(null);

export function LandingLanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<LandingLanguage>("tr");

  useEffect(() => {
    const saved = window.localStorage.getItem("atris_language");
    const next = saved === "tr" || saved === "en" ? saved : window.navigator.language.toLowerCase().startsWith("tr") ? "tr" : "en";
    setLanguageState(next);
    document.documentElement.lang = next;
  }, []);

  const value = useMemo<LandingLanguageContextValue>(() => ({
    language,
    setLanguage: (nextLanguage) => {
      window.localStorage.setItem("atris_language", nextLanguage);
      document.documentElement.lang = nextLanguage;
      setLanguageState(nextLanguage);
    },
    t: (key) => translations[language][key],
  }), [language]);

  return <LandingLanguageContext.Provider value={value}>{children}</LandingLanguageContext.Provider>;
}

export function useLandingTranslation() {
  const context = useContext(LandingLanguageContext);
  if (!context) throw new Error("useLandingTranslation must be used inside LandingLanguageProvider.");
  return context;
}
