import type { Metadata } from "next";
import "./globals.css";
import { LandingLanguageProvider } from "../lib/landing-i18n";

export const metadata: Metadata = {
  title: "AtrisAgent — Supervised AI agent workspace",
  description: "A local, approval-first desktop workspace for supervised AI agents.",
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
              "document.documentElement.classList.toggle('dark', saved !== 'light');",
              "} catch (_) { document.documentElement.classList.add('dark'); }",
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
