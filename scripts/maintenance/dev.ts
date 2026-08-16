#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";

const children = new Set<ChildProcess>();
let shuttingDown = false;

function spawnChild(label: string, command: string, args: string[]): void {
  const child = spawn(command, args, {
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    if (label === "proxy" && code === 0) return;

    shuttingDown = true;
    for (const other of children) {
      other.kill("SIGTERM");
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(`[dev:${label}] ${error.message}`);
    process.exit(1);
  });
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

spawnChild("proxy", process.execPath, ["--import", "tsx", "scripts/maintenance/dev-api-proxy.ts"]);
spawnChild("next", "next", ["dev", "--webpack"]);
