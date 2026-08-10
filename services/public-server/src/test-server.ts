import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { createPublicApp } from "./server.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const fixtureParent = fs.mkdtempSync(path.join(os.tmpdir(), "atris-public-server-"));
  const publicDir = path.join(fixtureParent, "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const secret = "outside-public-root-secret";
  fs.writeFileSync(path.join(fixtureParent, "secret.txt"), secret, "utf8");
  fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>AtrisAgent</title>", "utf8");
  fs.writeFileSync(path.join(publicDir, "logo.svg"), "<svg aria-hidden=\"true\"></svg>", "utf8");

  const app = createPublicApp({ publicDir, releaseRouter: express.Router() });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert(health.status === 200, "Health endpoint should return 200.");
    assert(health.headers.get("x-powered-by") === null, "Express power header must be disabled.");
    assert(health.headers.get("cache-control") === "no-store", "Health must not be cached.");

    const index = await fetch(`http://127.0.0.1:${port}/`);
    assert(index.status === 200, "Root should serve the exported landing index.");
    assert(index.headers.get("cache-control") === "no-cache", "HTML should revalidate promptly.");

    const asset = await fetch(`http://127.0.0.1:${port}/logo.svg`);
    assert(asset.status === 200, "Static branding asset should be served.");
    assert(asset.headers.get("cache-control") === "public, max-age=300", "Static assets should have bounded caching.");

    const api = await fetch(`http://127.0.0.1:${port}/api/runs`);
    assert(api.status === 404, "Public runtime API should stay unavailable.");
    assert(api.headers.get("cache-control") === "no-store", "Unavailable API responses must not be cached.");
    const apiBody = await api.json();
    assert(apiBody.code === "public-runtime-not-available", "Public API should expose the stable 404 code.");

    const traversal = await fetch(`http://127.0.0.1:${port}/%2e%2e/secret.txt`);
    const traversalBody = await traversal.text();
    assert(!traversalBody.includes(secret), "Encoded parent traversal must not expose files outside publicDir.");

    const fallback = await fetch(`http://127.0.0.1:${port}/download/landing`);
    assert(fallback.status === 200, "Unknown public routes should fall back to the landing index.");
    assert((await fallback.text()).includes("AtrisAgent"), "Fallback should return landing content.");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(fixtureParent, { recursive: true, force: true });
  }

  console.log("AtrisAgentCode public server tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
