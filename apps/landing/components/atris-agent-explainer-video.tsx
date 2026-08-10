"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  CheckCircle2,
  GitPullRequest,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useLandingTranslation, type LandingLanguage } from "../lib/landing-i18n";

type PreviewPhase = "loading" | "ready" | "unavailable";

type AtrisAgentExplainerVideoProps = {
  locale: LandingLanguage;
};

export default function AtrisAgentExplainerVideo({ locale }: AtrisAgentExplainerVideoProps) {
  const { t } = useLandingTranslation();
  const [phase, setPhase] = useState<PreviewPhase>("loading");
  const [sceneIndex, setSceneIndex] = useState(0);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_LANDING_VIDEO_DISABLED === "true") {
      setPhase("unavailable");
      return;
    }

    const readyTimer = window.setTimeout(() => setPhase("ready"), 320);
    const sceneTimer = window.setInterval(() => {
      setSceneIndex((current) => (current + 1) % 4);
    }, 4200);

    return () => {
      window.clearTimeout(readyTimer);
      window.clearInterval(sceneTimer);
    };
  }, []);

  if (phase === "loading") {
    return (
      <div className="preview-shell preview-loading" role="status" aria-live="polite">
        <div className="preview-loading-orb" />
        <p>{t("previewLoading")}</p>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <div className="preview-shell preview-unavailable" role="status" aria-live="polite">
        <div className="preview-unavailable-icon"><Bot aria-hidden="true" /></div>
        <div>
          <strong>{t("previewUnavailableTitle")}</strong>
          <p>{t("previewUnavailableDesc")}</p>
        </div>
        <button
          className="preview-retry"
          type="button"
          onClick={() => setPhase("ready")}
        >
          {t("previewRetry")}
        </button>
      </div>
    );
  }

  const sceneTitles = [t("planTitle"), t("buildTitle"), t("verifyTitle"), t("reviewTitle")];
  const sceneDescriptions = [
    t("planDescription"),
    t("buildDescription"),
    t("verifyDescription"),
    t("reviewDescription"),
  ];
  const cards = [t("planApproval"), t("fileChange"), t("testReport"), t("reviewPack")];
  const icons = [Bot, ShieldCheck, TerminalSquare, GitPullRequest];

  return (
    <div
      className="preview-shell preview-ready"
      aria-label={locale === "tr" ? "AtrisAgent ürün önizlemesi" : "AtrisAgent product preview"}
    >
      <div className="preview-window-bar">
        <div className="window-dots" aria-hidden="true">
          <span className="window-dot window-dot-red" />
          <span className="window-dot window-dot-yellow" />
          <span className="window-dot window-dot-green" />
        </div>
        <span className="preview-status"><span className="status-pulse" />{t("previewStatus")}</span>
      </div>

      <div className="preview-content">
        <div className="preview-story">
          <div className="preview-brand-chip"><Bot aria-hidden="true" /> AtrisAgent</div>
          <h2 key={sceneTitles[sceneIndex]}>{sceneTitles[sceneIndex]}</h2>
          <p>{sceneDescriptions[sceneIndex]}</p>
          <div className="preview-progress" aria-hidden="true">
            <span style={{ width: String(((sceneIndex + 1) / 4) * 100) + "%" }} />
          </div>
        </div>

        <div className="preview-board">
          <div className="preview-steps">
            {icons.map((Icon, index) => (
              <div className={index <= sceneIndex ? "preview-step is-active" : "preview-step"} key={index}>
                <Icon aria-hidden="true" />
                <span>{locale === "tr" ? "Ajan " : "Agent "}{index + 1}</span>
              </div>
            ))}
          </div>
          <div className="preview-cards">
            {cards.map((card, index) => (
              <div className={index <= sceneIndex ? "preview-card is-visible" : "preview-card"} key={card}>
                <div className="preview-card-heading">
                  <span>{card}</span>
                  {index <= sceneIndex ? <CheckCircle2 aria-hidden="true" /> : <span className="preview-card-pending" />}
                </div>
                <div className="preview-lines" aria-hidden="true">
                  <span />
                  <span />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
