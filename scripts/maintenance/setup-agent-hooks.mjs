#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOOKS_PATH = resolve(ROOT, ".codex/hooks.json");

const command = 'node "$(git rev-parse --show-toplevel)/scripts/ci/pharos-change-contract.mjs"';
export function buildCodexHookConfig() {
  return {
    hooks: {
      PermissionRequest: [
        {
          matcher: ".*",
          hooks: [{ type: "command", command: `${command} --hook=permission-request`, timeout: 5 }],
        },
      ],
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [{ type: "command", command: `${command} --hook=pre-tool-use`, timeout: 5 }],
        },
      ],
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [{ type: "command", command: `${command} --hook=session-start`, timeout: 10 }],
        },
      ],
    },
  };
}

export function renderCodexHookConfig() {
  return `${JSON.stringify(buildCodexHookConfig(), null, 2)}\n`;
}

export function runAgentHookSetup({
  hooksPath = HOOKS_PATH,
  install = process.env.PHAROS_INSTALL_CODEX_HOOKS === "1",
} = {}) {
  const expected = renderCodexHookConfig();
  if (!install) {
    const current = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";
    console.log(
      current === expected
        ? "Codex project hooks are installed and current."
        : "Codex project hooks are not installed. Re-run with PHAROS_INSTALL_CODEX_HOOKS=1 after reviewing the trusted hook commands.",
    );
    return current === expected ? 0 : 1;
  }

  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, expected);
  console.log("Installed user-approved Codex project hooks in ignored .codex/hooks.json.");
  return 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = runAgentHookSetup();
}
