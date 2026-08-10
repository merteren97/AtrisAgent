"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type LandingLanguage = "tr" | "en";

const translations = {
  tr: {
    navProduct: "Ürün",
    navWorkflow: "Nasıl çalışır?",
    navDownload: "İndir",
    languageLabel: "Dil seç",
    themeLabel: "Temayı değiştir",
    downloadApp: "Uygulamayı indir",
    eyebrow: "Onay öncelikli masaüstü ajan çalışma alanı",
    heroTitle: "AtrisAgent ile",
    heroAccent: "kontrollü AI ajanlarını",
    heroEnding: "güvenle yönetin.",
    heroDesc:
      "Project Manager, Researcher, Developer ve Tester ajanlarını yerel, kontrollü ve kanıt odaklı bir masaüstü çalışma alanında bir araya getirin.",
    primaryCta: "Uygulamayı indir",
    secondaryCta: "Akışı keşfet",
    trustLocal: "Yerel çalışma alanları",
    trustApproval: "Her adımda onay",
    trustEvidence: "Kanıtlanabilir sonuçlar",
    workflowEyebrow: "Tek akış, net sorumluluk",
    workflowTitle: "Fikirden review'e kadar görünür bir çalışma alanı.",
    workflowDesc:
      "Her ajan kendi rolünü bilir. Plan, izole değişiklik, test kanıtı ve review paketi aynı akışta izlenebilir kalır.",
    previewLoading: "Çalışma alanı önizlemesi hazırlanıyor…",
    previewUnavailableTitle: "Önizleme şu anda kullanılamıyor.",
    previewUnavailableDesc: "Ürün akışını görmek için masaüstü uygulamasını açın.",
    previewRetry: "Tekrar dene",
    previewStatus: "Denetimli çalışma",
    planApproval: "Plan onayı",
    fileChange: "Dosya değişikliği",
    testReport: "Test raporu",
    reviewPack: "Review paketi",
    planTitle: "Planla",
    planDescription: "Project Manager görevi parçalara ayırır ve onay ister.",
    buildTitle: "Geliştir",
    buildDescription: "Developer ajan izole alanda kontrollü değişiklik hazırlar.",
    verifyTitle: "Doğrula",
    verifyDescription: "Tester ajan komutları çalıştırır ve kanıt toplar.",
    reviewTitle: "Review'e hazırla",
    reviewDescription: "Sonuç branch, diff, test raporu ve review akışı olarak döner.",
    downloadsEyebrow: "Masaüstü uygulaması",
    downloadsTitle: "Çalışma alanını bilgisayarına indir.",
    downloadsDesc:
      "AtrisAgent yerel çalışma alanlarını ve hassas onay akışını bilgisayarında tutar. İşletim sistemine uygun imzalı paketi indir.",
    available: "İndirmeye hazır",
    unavailable: "Sürüm şu anda kullanılamıyor",
    comingSoon: "Yakında",
    platformComingSoon: "Bu platform için sürüm hazırlanıyor.",
    download: "İndir",
    windowsDescription: "Windows x64 ve ARM64 için otomatik güncellemeli masaüstü paketi.",
    macDescription: "Apple Silicon ve Intel Mac için evrensel masaüstü paketi.",
    linuxDescription: "Popüler Linux dağıtımları için AppImage ve Debian paketleri.",
    footer: "© 2026 AtrisAgent. Tüm hakları saklıdır.",
  },
  en: {
    navProduct: "Product",
    navWorkflow: "How it works",
    navDownload: "Download",
    languageLabel: "Choose language",
    themeLabel: "Change theme",
    downloadApp: "Download app",
    eyebrow: "Approval-first desktop agent workspace",
    heroTitle: "Build with",
    heroAccent: "supervised AI agents",
    heroEnding: "you can trust.",
    heroDesc:
      "Bring Project Manager, Researcher, Developer, and Tester agents together in a local, controlled, evidence-first desktop workspace.",
    primaryCta: "Download the app",
    secondaryCta: "Explore the flow",
    trustLocal: "Local workspaces",
    trustApproval: "Approval at every step",
    trustEvidence: "Evidence-ready results",
    workflowEyebrow: "One flow, clear ownership",
    workflowTitle: "A visible workspace from idea to review.",
    workflowDesc:
      "Each agent knows its role. Plans, isolated changes, test evidence, and review packs stay traceable in one flow.",
    previewLoading: "Preparing the workspace preview…",
    previewUnavailableTitle: "Preview is unavailable right now.",
    previewUnavailableDesc: "Open the desktop app to experience the product flow.",
    previewRetry: "Try again",
    previewStatus: "Supervised run",
    planApproval: "Plan approval",
    fileChange: "File change",
    testReport: "Test report",
    reviewPack: "Review pack",
    planTitle: "Plan",
    planDescription: "The Project Manager agent breaks down the task and asks for approval.",
    buildTitle: "Build",
    buildDescription: "The Developer agent prepares a controlled change in an isolated workspace.",
    verifyTitle: "Verify",
    verifyDescription: "The Tester agent runs commands and gathers evidence.",
    reviewTitle: "Prepare for review",
    reviewDescription: "The result becomes a branch, diff, test report, and review flow.",
    downloadsEyebrow: "Desktop application",
    downloadsTitle: "Bring the workspace to your computer.",
    downloadsDesc:
      "AtrisAgent keeps local workspaces and sensitive approval flows on your computer. Download the signed package for your operating system.",
    available: "Ready to download",
    unavailable: "Release currently unavailable",
    comingSoon: "Coming soon",
    platformComingSoon: "A release for this platform is in preparation.",
    download: "Download",
    windowsDescription: "Desktop package for Windows x64 and ARM64 with automatic updates.",
    macDescription: "Universal desktop package for Apple Silicon and Intel Macs.",
    linuxDescription: "AppImage and Debian packages for popular Linux distributions.",
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
    const next = saved === "tr" || saved === "en"
      ? saved
      : window.navigator.language.toLowerCase().startsWith("tr")
        ? "tr"
        : "en";
    setLanguageState(next);
    document.documentElement.lang = next;
  }, []);

  const value = useMemo<LandingLanguageContextValue>(
    () => ({
      language,
      setLanguage: (nextLanguage) => {
        window.localStorage.setItem("atris_language", nextLanguage);
        document.documentElement.lang = nextLanguage;
        setLanguageState(nextLanguage);
      },
      t: (key) => translations[language][key],
    }),
    [language],
  );

  return <LandingLanguageContext.Provider value={value}>{children}</LandingLanguageContext.Provider>;
}

export function useLandingTranslation() {
  const context = useContext(LandingLanguageContext);
  if (!context) {
    throw new Error("useLandingTranslation must be used inside LandingLanguageProvider.");
  }
  return context;
}
