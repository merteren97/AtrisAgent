import type { Metadata } from "next";
import "./globals.css";
import { LandingLanguageProvider } from "../lib/landing-i18n";

export const metadata: Metadata = {
  title: "AtrisAgent — Fikirden çalışan koda. Kontrol hep sizde.",
  description: "AtrisAgent ile AI kodlama araçlarınızı tek bir yerel çalışma alanında yönetin. Ajan akışlarını görün, değişiklikleri inceleyin ve Windows veya Linux için ücretsiz indirin.",
  metadataBase: new URL("https://agent.atrishub.com"),
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/logo.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: [
              "try {",
              "const saved = localStorage.getItem('atris_theme');",
              "document.documentElement.classList.toggle('dark', saved === 'dark');",
              "} catch (_) {}",
            ].join(""),
          }}
        />
      </head>
      <body>
        <LandingLanguageProvider>{children}</LandingLanguageProvider>
      </body>
    </html>
  );
}
