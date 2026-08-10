import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import dotenv from "dotenv";
import { createAgentReleaseRouter } from "./release-proxy.js";

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

export type PublicAppOptions = {
  publicDir?: string;
  releaseRouter?: express.Router;
};

function setStaticCacheHeaders(response: express.Response, filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const isHtml = extension === ".html" || path.basename(filePath).toLowerCase() === "index";
  response.setHeader("Cache-Control", isHtml ? "no-cache" : "public, max-age=300");
}

export function createPublicApp(options: PublicAppOptions = {}): Express {
  const app = express();
  const publicDir = path.resolve(options.publicDir || path.resolve(process.cwd(), "public"));
  const indexPath = path.join(publicDir, "index.html");

  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ status: "ok", service: "atris-agent-public" });
  });
  app.use("/api/agent-github", options.releaseRouter || createAgentReleaseRouter());
  app.use("/api", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(404).json({
      code: "public-runtime-not-available",
      error: "Public AtrisAgent runtime API does not exist. Install the desktop app to use local workspaces and runs.",
    });
  });
  app.use(
    express.static(publicDir, {
      extensions: ["html"],
      fallthrough: true,
      setHeaders: setStaticCacheHeaders,
    }),
  );
  app.get("*", (_request, response, next) => {
    response.sendFile(indexPath, (error) => {
      if (error) next(error);
    });
  });

  return app;
}

export type PublicServerOptions = PublicAppOptions & {
  port?: number;
  host?: string;
};

export function startPublicServer(options: PublicServerOptions = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3003);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const server = createPublicApp(options).listen(port, host, () => {
    console.log(`[AtrisAgent Public] Listening on http://${host}:${port}`);
  });
  return server;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === currentFile) startPublicServer();
