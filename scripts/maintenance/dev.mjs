#!/usr/bin/env node

import { spawn } from "node:child_process";

const children = new Set();
let shuttingDown = false;

function spawnChild(label, command, args) {
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

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

spawnChild("proxy", process.execPath, ["scripts/maintenance/dev-api-proxy.mjs"]);
spawnChild("next", "next", ["dev", "--webpack"]);
