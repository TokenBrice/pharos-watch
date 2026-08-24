#!/usr/bin/env node

import { spawn } from "node:child_process";

function runNpmScript(name: string): Promise<void> {
  console.log(`[pages-release-checks] npm run ${name}`);
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", name], { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} failed (${signal ? `signal ${signal}` : `exit ${code ?? 1}`}).`));
    });
  });
}

async function main(): Promise<void> {
  try {
    await Promise.all([
      runNpmScript("check:feature-flag-inlining"),
      runNpmScript("check:build-size"),
      runNpmScript("check:phishing-signatures"),
    ]);
    await runNpmScript("seo:check");
  } catch (error) {
    console.error(`[pages-release-checks] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
