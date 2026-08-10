import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let startupFailed = false;

const child = spawn(npmCommand, ["run", "start", "-w", "@atris-agent-code/public-server"], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "production",
    HOST: process.env.HOST || "127.0.0.1",
    PORT: process.env.PORT || "3003",
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("error", (error) => {
  startupFailed = true;
  console.error("[AtrisAgent landing] Failed to start public server:", error);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(startupFailed ? 1 : code ?? 0);
});
