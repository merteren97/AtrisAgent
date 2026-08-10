import assertStrict from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  assetPriority,
  createAgentReleaseRouter,
  configuredReleasePlatforms,
  isAllowedReleaseAsset,
  matchesPlatformAsset,
  semverCompare,
  validateGithubAssetRedirect,
} from "./release-proxy.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const initialNodeEnv = process.env.NODE_ENV;
  const initialReleasePlatforms = process.env.AGENT_RELEASE_PLATFORMS;
  process.env.NODE_ENV = "test";
  delete process.env.AGENT_RELEASE_PLATFORMS;
  assert(matchesPlatformAsset("win", "AtrisAgent_0.1.0_x64-setup.exe"), "Windows asset should match.");
  assert(matchesPlatformAsset("mac", "AtrisAgent.app.tar.gz"), "macOS asset should match.");
  assert(matchesPlatformAsset("linux", "AtrisAgent.AppImage"), "Linux asset should match.");
  assert(!matchesPlatformAsset("linux", "AtrisAgent.dmg"), "Wrong platform asset must not match.");
  assert(
    assetPriority("windows-x86_64", "AtrisAgent-setup.exe") > assetPriority("windows-x86_64", "AtrisAgent.msi"),
    "Windows setup exe should be preferred.",
  );
  assertStrict.deepEqual(configuredReleasePlatforms(), ["windows"], "Windows must be the default supported release platform.");
  assert(isAllowedReleaseAsset({ id: 101, name: "AtrisAgent-setup.exe" }), "Main installer should be downloadable.");
  assert(!isAllowedReleaseAsset({ id: 102, name: "AtrisAgent-setup.exe.sig" }), "Signature assets must not be directly downloadable.");
  assert(!isAllowedReleaseAsset({ id: 201, name: "AtrisAgent.AppImage" }), "Linux assets must stay disabled by default.");
  assert(isAllowedReleaseAsset({ id: 201, name: "AtrisAgent.AppImage" }, ["linux"]), "Explicit Linux allowlist should remain testable.");
  assert(semverCompare("0.2.0", "0.1.9") > 0, "Newer semantic version should compare higher.");
  assert(
    validateGithubAssetRedirect("https://objects.githubusercontent.com/atris-agent.exe") ===
      "https://objects.githubusercontent.com/atris-agent.exe",
    "GitHub asset redirects must allow the canonical objects host",
  );
  assert(validateGithubAssetRedirect(null) === null, "Missing GitHub asset redirects must be rejected");
  assert(validateGithubAssetRedirect("not-a-url") === null, "Malformed GitHub asset redirects must be rejected");
  assert(validateGithubAssetRedirect("https://attacker.example/atris-agent.exe") === null, "Untrusted redirect hosts must be rejected");
  assert(validateGithubAssetRedirect("http://objects.githubusercontent.com/atris-agent.exe") === null, "Non-HTTPS redirects must be rejected");

  const release = {
    tag_name: "v0.2.0",
    published_at: "2026-06-19T12:00:00.000Z",
    body: "Release notes",
    assets: [
      { id: 101, name: "AtrisAgent_0.2.0_x64-setup.exe" },
      { id: 102, name: "AtrisAgent_0.2.0_x64-setup.exe.sig" },
      { id: 201, name: "AtrisAgent_0.2.0_x64.AppImage" },
    ],
  };

  let assetFetchCount = 0;
  let assetRedirectLocation: string | null = "https://objects.githubusercontent.com/atris-agent.exe";
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/releases/latest")) return Response.json(release);
    if (url.includes("/releases/assets/")) assetFetchCount += 1;
    if (url.endsWith("/releases/assets/101")) {
      return new Response(null, {
        status: 302,
        headers: assetRedirectLocation ? { Location: assetRedirectLocation } : undefined,
      });
    }
    if (url.endsWith("/releases/assets/102")) return new Response("signed-update-value");
    return new Response("not found", { status: 404 });
  };

  const app = express();
  app.use(
    "/api/agent-github",
    createAgentReleaseRouter({ fetchImpl, cacheTtlMs: 0, publicBaseUrl: "https://agent.atrishub.com" }),
  );
  app.use(
    "/missing-signature/api/agent-github",
    createAgentReleaseRouter({
      cacheTtlMs: 0,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/releases/latest")) {
          return Response.json({ ...release, assets: [{ id: 101, name: "AtrisAgent_0.2.0_x64-setup.exe" }] });
        }
        return new Response("not found", { status: 404 });
      },
    }),
  );
  app.use(
    "/upstream-failure/api/agent-github",
    createAgentReleaseRouter({ cacheTtlMs: 0, fetchImpl: async () => new Response("unavailable", { status: 503 }) }),
  );

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const downloadResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/win`, { redirect: "manual" });
    assert(downloadResponse.status === 302, "Platform download should redirect to the GitHub asset.");
    assert(
      downloadResponse.headers.get("location") === "https://objects.githubusercontent.com/atris-agent.exe",
      "Download should preserve a validated GitHub asset redirect.",
    );
    const architectureDownloadResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/windows-x86_64`, { redirect: "manual" });
    assert(architectureDownloadResponse.status === 302, "Windows architecture aliases should redirect to the GitHub asset.");

    const directAssetResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/101`, { redirect: "manual" });
    assert(directAssetResponse.status === 302, "Direct asset ID should be downloadable.");

    assetRedirectLocation = "https://attacker.example/atris-agent.exe";
    const hostileRedirectResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/101`, { redirect: "manual" });
    assert(hostileRedirectResponse.status === 502, "Untrusted GitHub redirects must fail closed.");
    assert(hostileRedirectResponse.headers.get("location") === null, "Untrusted redirect must not be forwarded.");
    assetRedirectLocation = "not-a-url";
    const malformedRedirectResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/101`, { redirect: "manual" });
    assert(malformedRedirectResponse.status === 502, "Malformed GitHub redirects must fail closed.");
    assetRedirectLocation = null;
    const missingRedirectResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/101`, { redirect: "manual" });
    assert(missingRedirectResponse.status === 502, "Missing GitHub redirects must fail closed.");
    assetRedirectLocation = "https://objects.githubusercontent.com/atris-agent.exe";

    const beforeRejectedAssetFetch = assetFetchCount;
    const guessedAssetResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/999999`, { redirect: "manual" });
    assert(guessedAssetResponse.status === 404, "Unknown numeric asset IDs must be rejected.");
    assert(assetFetchCount === beforeRejectedAssetFetch, "Rejected numeric IDs must not trigger an upstream asset fetch.");
    const signatureAssetResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/102`, { redirect: "manual" });
    assert(signatureAssetResponse.status === 404, "Signature asset IDs must not be downloadable.");
    assert(assetFetchCount === beforeRejectedAssetFetch, "Rejected signature IDs must not trigger an upstream asset fetch.");

    const updateResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/update/windows-x86_64/0.1.0`);
    assert(updateResponse.status === 200, "New signed release should return updater metadata.");
    const update = await updateResponse.json();
    assert(update.version === "0.2.0", "Updater version should omit the v prefix.");
    assert(update.url === "https://agent.atrishub.com/api/agent-github/download/101", "Updater URL should use the public domain.");
    assert(update.signature === "signed-update-value", "Updater signature should be returned.");

    const currentResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/update/windows-x86_64/0.2.0`);
    assert(currentResponse.status === 204, "Current version should return no update.");
    const missingResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/unknown-platform`);
    assert(missingResponse.status === 404, "Unknown platform should return a controlled 404.");
    const linuxResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/download/linux`);
    assert(linuxResponse.status === 404, "Linux downloads must remain unavailable while the runtime is Windows-only.");
    const linuxUpdateResponse = await fetch(`http://127.0.0.1:${port}/api/agent-github/update/linux-x86_64/0.1.0`);
    assert(linuxUpdateResponse.status === 204, "Linux updater metadata must remain unavailable while unsupported.");
    const missingSignatureResponse = await fetch(`http://127.0.0.1:${port}/missing-signature/api/agent-github/update/windows-x86_64/0.1.0`);
    assert(missingSignatureResponse.status === 204, "Unsigned update should not be offered.");
    const upstreamFailureResponse = await fetch(`http://127.0.0.1:${port}/upstream-failure/api/agent-github/download/win`);
    assert(upstreamFailureResponse.status === 502, "GitHub failure should return a controlled 502.");

    const previousNodeEnv = process.env.NODE_ENV;
    const previousPublicBase = process.env.AGENT_PUBLIC_BASE_URL;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.AGENT_PUBLIC_BASE_URL;
      assertStrict.throws(
        () => createAgentReleaseRouter({ fetchImpl }),
        /AGENT_PUBLIC_BASE_URL is required/,
        "Production router startup must fail without an explicit public base URL.",
      );
      process.env.AGENT_PUBLIC_BASE_URL = "https://agent.atrishub.com";
      const productionRouterApp = express();
      productionRouterApp.use("/api/agent-github", createAgentReleaseRouter({ fetchImpl, cacheTtlMs: 0 }));
      const productionServer = productionRouterApp.listen(0);
      await new Promise<void>((resolve) => productionServer.once("listening", resolve));
      const productionPort = (productionServer.address() as AddressInfo).port;
      try {
        const poisonedHostResponse = await fetch(`http://127.0.0.1:${productionPort}/api/agent-github/update/windows-x86_64/0.1.0`, {
          headers: { Host: "attacker.example", "X-Forwarded-Proto": "http" },
        });
        assert(poisonedHostResponse.status === 200, "Configured production base should allow updater metadata.");
        const poisonedHostPayload = await poisonedHostResponse.json();
        assert(poisonedHostPayload.url.startsWith("https://agent.atrishub.com/"), "Host headers must not control updater URLs.");
        assert(!poisonedHostPayload.url.includes("attacker.example"), "Poisoned host must not appear in updater URLs.");
      } finally {
        await new Promise<void>((resolve, reject) => productionServer.close((error) => (error ? reject(error) : resolve())));
      }
      process.env.AGENT_PUBLIC_BASE_URL = "http://attacker.example";
      assertStrict.throws(
        () => createAgentReleaseRouter({ fetchImpl }),
        /https URL|agent\.atrishub\.com/,
        "Production router startup must reject an invalid public base URL.",
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousPublicBase === undefined) delete process.env.AGENT_PUBLIC_BASE_URL;
      else process.env.AGENT_PUBLIC_BASE_URL = previousPublicBase;
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (initialNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = initialNodeEnv;
    if (initialReleasePlatforms === undefined) delete process.env.AGENT_RELEASE_PLATFORMS;
    else process.env.AGENT_RELEASE_PLATFORMS = initialReleasePlatforms;
  }

  console.log("AtrisAgentCode release proxy tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
