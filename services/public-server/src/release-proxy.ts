import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Router, type Request, type Response as ExpressResponse } from "express";

type FetchLike = typeof fetch;

type ReleaseAsset = {
  id: number;
  name: string;
};

type GitHubRelease = {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  assets?: ReleaseAsset[];
};

export type ReleasePlatform = "windows" | "darwin" | "linux";

export type ReleaseRouterOptions = {
  fetchImpl?: FetchLike;
  cacheTtlMs?: number;
  publicBaseUrl?: string;
};

type CachedRelease = {
  data: GitHubRelease;
  expiresAt: number;
};

const isAssetId = (value: string) => /^\d+$/.test(value);

export function matchesPlatformAsset(platform: string, assetName: string) {
  const name = assetName.toLowerCase();
  const normalizedPlatform = normalizeReleasePlatform(platform) ?? platform.toLowerCase();

  switch (normalizedPlatform) {
    case "windows":
      return (
        name.endsWith("-setup.exe") ||
        name.endsWith(".exe") ||
        name.endsWith(".msi") ||
        name.endsWith(".msi.zip") ||
        name.endsWith(".nsis.zip")
      );
    case "darwin":
      return name.endsWith(".app.tar.gz") || name.endsWith(".dmg");
    case "linux":
      return name.endsWith(".appimage") || name.endsWith(".appimage.tar.gz") || name.endsWith(".deb");
    default:
      return false;
  }
}

export function assetPriority(platform: string, assetName: string) {
  const normalizedPlatform = normalizeReleasePlatform(platform) ?? platform.toLowerCase();
  const name = assetName.toLowerCase();

  if (name.endsWith(".sig")) return -1;

  if (normalizedPlatform.includes("windows")) {
    if (name.endsWith("-setup.exe")) return 40;
    if (name.endsWith(".exe")) return 35;
    if (name.endsWith(".msi")) return 30;
    if (name.endsWith(".nsis.zip")) return 20;
    if (name.endsWith(".msi.zip")) return 15;
  }

  if (normalizedPlatform.includes("darwin") || normalizedPlatform.includes("macos")) {
    if (name.endsWith(".app.tar.gz")) return 40;
    if (name.endsWith(".dmg")) return 20;
  }

  if (normalizedPlatform.includes("linux")) {
    if (name.endsWith(".appimage.tar.gz")) return 40;
    if (name.endsWith(".appimage")) return 30;
    if (name.endsWith(".deb")) return 20;
  }

  return 0;
}

function normalizeReleasePlatform(platform: string): ReleasePlatform | null {
  const normalized = platform.toLowerCase();
  if (normalized === "win" || normalized.startsWith("windows")) return "windows";
  if (normalized === "mac" || normalized.startsWith("macos") || normalized.startsWith("darwin")) return "darwin";
  if (normalized.startsWith("linux")) return "linux";
  return null;
}

export function configuredReleasePlatforms(): ReleasePlatform[] {
  const configured = process.env.AGENT_RELEASE_PLATFORMS?.trim();
  if (!configured) return ["windows"];
  const platforms = configured
    .split(",")
    .map((platform) => normalizeReleasePlatform(platform.trim()))
    .filter((platform): platform is ReleasePlatform => platform !== null);
  if (platforms.length === 0 || platforms.length !== configured.split(",").length) {
    throw new Error("AGENT_RELEASE_PLATFORMS contains an unsupported platform.");
  }
  return [...new Set(platforms)];
}

export function isAllowedReleaseAsset(asset: ReleaseAsset, supportedPlatforms: ReleasePlatform[] = configuredReleasePlatforms()) {
  return supportedPlatforms.some((platform) => assetPriority(platform, asset.name) > 0);
}

export function semverCompare(a: string, b: string) {
  const semverPattern = /^v?(\d+)\.(\d+)\.(\d+)/;
  const first = a.match(semverPattern);
  const second = b.match(semverPattern);

  if (!first || !second) return a.localeCompare(b);

  for (let index = 1; index <= 3; index += 1) {
    const firstPart = Number.parseInt(first[index], 10);
    const secondPart = Number.parseInt(second[index], 10);

    if (firstPart > secondPart) return 1;
    if (secondPart > firstPart) return -1;
  }

  return 0;
}

function githubHeaders(accept: string) {
  const token = process.env.AGENT_RELEASE_REPO_ACCESS_TOKEN;
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "AtrisAgentCode-Release-Proxy",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

const GITHUB_ASSET_HOSTNAMES = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export function validateGithubAssetRedirect(value: string | null): string | null {
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !GITHUB_ASSET_HOSTNAMES.has(parsed.hostname.toLowerCase())
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function noUpdate(response: ExpressResponse, reason: string, debug: boolean) {
  if (debug) return response.status(200).json({ update: false, reason });
  return response.status(204).end();
}

function validatePublicBaseUrl(value: string, production: boolean) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("AGENT_PUBLIC_BASE_URL must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("AGENT_PUBLIC_BASE_URL must be an https URL without credentials or query parameters.");
  }
  if (production && parsed.hostname !== "agent.atrishub.com") {
    throw new Error("AGENT_PUBLIC_BASE_URL must use agent.atrishub.com in production.");
  }
  return parsed.origin.replace(/\/+$/, "");
}

function publicBaseUrl(request: Request, configuredBaseUrl?: string) {
  const production = process.env.NODE_ENV === "production";
  const environmentBaseUrl = process.env.AGENT_PUBLIC_BASE_URL?.trim();
  if (production && !environmentBaseUrl) {
    throw new Error("AGENT_PUBLIC_BASE_URL is required in production.");
  }
  const configured = environmentBaseUrl || configuredBaseUrl?.trim();
  if (configured) return validatePublicBaseUrl(configured, production);

  const host = request.get("host") || "";
  const forwardedProtocol = request.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || request.protocol;
  if (protocol !== "http" || !/^(127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host)) {
    throw new Error("A loopback request is required when AGENT_PUBLIC_BASE_URL is not configured.");
  }
  return `http://${host}`;
}

export function createAgentReleaseRouter(options: ReleaseRouterOptions = {}) {
  if (process.env.NODE_ENV === "production") {
    const configuredBaseUrl = process.env.AGENT_PUBLIC_BASE_URL?.trim();
    if (!configuredBaseUrl) throw new Error("AGENT_PUBLIC_BASE_URL is required in production.");
    validatePublicBaseUrl(configuredBaseUrl, true);
  }
  const router = Router();
  const fetchImpl = options.fetchImpl || fetch;
  const cacheTtlMs = options.cacheTtlMs ?? 300_000;
  const supportedPlatforms = configuredReleasePlatforms();
  let cachedRelease: CachedRelease | null = null;

  const repoOwner = () => process.env.AGENT_RELEASE_REPO_OWNER || "merteren97";
  const repoName = () => process.env.AGENT_RELEASE_REPO_NAME || "AtrisAgent";

  async function getLatestRelease() {
    if (cachedRelease && cachedRelease.expiresAt > Date.now()) {
      return { ok: true as const, data: cachedRelease.data };
    }

    const response = await fetchImpl(
      `https://api.github.com/repos/${repoOwner()}/${repoName()}/releases/latest`,
      { headers: githubHeaders("application/vnd.github+json") },
    );

    if (!response.ok) return { ok: false as const, status: response.status };

    const data = (await response.json()) as GitHubRelease;
    cachedRelease = { data, expiresAt: Date.now() + cacheTtlMs };
    return { ok: true as const, data };
  }

  router.get("/download/:assetOrPlatform", async (request, response) => {
    try {
      const assetOrPlatform = request.params.assetOrPlatform;
      const latestRelease = await getLatestRelease();
      if (!latestRelease.ok) {
        const status = latestRelease.status === 404 ? 404 : 502;
        return response.status(status).send(
          status === 404
            ? "AtrisAgent latest release is not available yet"
            : "GitHub release service is temporarily unavailable",
        );
      }

      const eligibleAssets = (latestRelease.data.assets || []).filter((asset) =>
        isAllowedReleaseAsset(asset, supportedPlatforms),
      );
      let asset: ReleaseAsset | undefined;
      if (isAssetId(assetOrPlatform)) {
        asset = eligibleAssets.find((candidate) => String(candidate.id) === assetOrPlatform);
        if (!asset) {
          return response.status(404).send("AtrisAgent release asset was not found in the latest eligible release");
        }
      } else {
        const requestedPlatform = normalizeReleasePlatform(assetOrPlatform);
        if (!requestedPlatform || !supportedPlatforms.includes(requestedPlatform)) {
          return response.status(404).send(`No AtrisAgent release asset found for platform: ${assetOrPlatform}`);
        }
        asset = eligibleAssets
          .filter((candidate) => matchesPlatformAsset(assetOrPlatform, candidate.name))
          .sort((first, second) => assetPriority(assetOrPlatform, second.name) - assetPriority(assetOrPlatform, first.name))[0];
        if (!asset) {
          return response.status(404).send(`No AtrisAgent release asset found for platform: ${assetOrPlatform}`);
        }
      }
      const assetId = String(asset.id);

      const githubResponse = await fetchImpl(
        `https://api.github.com/repos/${repoOwner()}/${repoName()}/releases/assets/${assetId}`,
        { headers: githubHeaders("application/octet-stream"), redirect: "manual" },
      );

      if (githubResponse.status >= 300 && githubResponse.status < 400) {
        const redirectUrl = validateGithubAssetRedirect(githubResponse.headers.get("location"));
        if (!redirectUrl) {
          return response.status(502).send("GitHub release asset returned an invalid redirect");
        }
        return response.redirect(302, redirectUrl);
      }

      if (!githubResponse.ok || !githubResponse.body) {
        return response.status(githubResponse.status === 404 ? 404 : 502).send(
          "AtrisAgent release asset could not be downloaded",
        );
      }

      response.status(200);
      response.setHeader("Content-Type", githubResponse.headers.get("content-type") || "application/octet-stream");
      response.setHeader(
        "Content-Disposition",
        githubResponse.headers.get("content-disposition") || 'attachment; filename="atris-agent-asset"',
      );
      const contentLength = githubResponse.headers.get("content-length");
      if (contentLength) response.setHeader("Content-Length", contentLength);

      Readable.fromWeb(githubResponse.body as unknown as NodeReadableStream).pipe(response);
      return;
    } catch (error) {
      console.error("AtrisAgentCode release download proxy failed.", error);
      return response.status(502).send("GitHub release service is temporarily unavailable");
    }
  });

  router.get("/update/:platform/:version", async (request, response) => {
    const debug = request.query.debug === "1";

    try {
      const requestedPlatform = normalizeReleasePlatform(request.params.platform);
      if (!requestedPlatform || !supportedPlatforms.includes(requestedPlatform)) {
        return noUpdate(response, `platform_not_supported_${request.params.platform}`, debug);
      }
      const latestRelease = await getLatestRelease();
      if (!latestRelease.ok) {
        console.error("AtrisAgentCode latest release lookup failed.", latestRelease.status);
        return noUpdate(response, `github_latest_release_${latestRelease.status}`, debug);
      }

      const release = latestRelease.data;
      const latestVersion = release.tag_name || release.name || "0.0.0";
      const cleanLatestVersion = latestVersion.replace(/^v/, "");
      const cleanCurrentVersion = request.params.version.replace(/^v/, "");
      if (semverCompare(cleanLatestVersion, cleanCurrentVersion) <= 0) {
        return noUpdate(response, "current_version_is_latest", debug);
      }

      const mainAsset =
        (release.assets || [])
          .map((asset) => ({ asset, priority: assetPriority(request.params.platform, asset.name) }))
          .filter((entry) => entry.priority > 0)
          .sort((first, second) => second.priority - first.priority)[0]?.asset || null;
      if (!mainAsset) return noUpdate(response, `asset_not_found_for_${request.params.platform}`, debug);

      const signatureAsset = (release.assets || []).find((asset) => asset.name === `${mainAsset.name}.sig`) || null;
      if (!signatureAsset) return noUpdate(response, `signature_not_found_for_${mainAsset.name}`, debug);

      const signatureResponse = await fetchImpl(
        `https://api.github.com/repos/${repoOwner()}/${repoName()}/releases/assets/${signatureAsset.id}`,
        { headers: githubHeaders("application/octet-stream") },
      );
      if (!signatureResponse.ok) return noUpdate(response, `signature_fetch_failed_${signatureResponse.status}`, debug);

      const signature = (await signatureResponse.text()).trim();
      if (!signature) return noUpdate(response, `signature_empty_for_${mainAsset.name}`, debug);

      return response.json({
        version: latestVersion.replace(/^v/, ""),
        pub_date: release.published_at,
        url: `${publicBaseUrl(request, options.publicBaseUrl)}/api/agent-github/download/${mainAsset.id}`,
        signature,
        notes: release.body || "No release notes provided.",
      });
    } catch (error) {
      console.error("AtrisAgentCode updater metadata lookup failed.", error);
      return noUpdate(response, "internal_error", debug);
    }
  });

  return router;
}
