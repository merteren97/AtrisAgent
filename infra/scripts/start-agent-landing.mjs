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
  detached: process.platform !== "win32",
  stdio: "inherit",
});

let shuttingDown = false;
function forwardTermination(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* ignore already exited */ }
  }
}

process.on("SIGINT", () => forwardTermination("SIGINT"));
process.on("SIGTERM", () => forwardTermination("SIGTERM"));

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
