#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOOKS_PATH = resolve(ROOT, ".codex/hooks.json");
const CODEX_CONFIG_PATH = resolve(homedir(), ".codex/config.toml");
const WORKTREE_NOTE =
  "Codex hooks are per-checkout; re-run with PHAROS_INSTALL_CODEX_HOOKS=1 in this worktree.";
const DISABLED_HOOK_HINT = "Enable in Codex: /hooks or set enabled = true";

const command = 'node --import tsx "$(git rev-parse --show-toplevel)/scripts/ci/pharos-change-contract.ts"';
// Observed in one captured Codex payload: apply_patch, exec_command.
const CODEX_SHELL_AND_WRITE_MATCHER = "^(apply_patch|exec_command)$";

type CodexHookEvent = "PermissionRequest" | "PreToolUse" | "SessionStart";

type CodexHookState = {
  event: CodexHookEvent;
  eventIndex: number;
  hookIndex: number;
  label: string;
  stateKey: string;
};

export type GitWorktreePaths = {
  checkoutRoot: string;
  commonDir: string;
};

export function buildCodexHookConfig() {
  return {
    hooks: {
      PermissionRequest: [
        {
          matcher: CODEX_SHELL_AND_WRITE_MATCHER,
          hooks: [{ type: "command", command: `${command} --hook=permission-request`, timeout: 5 }],
        },
      ],
      PreToolUse: [
        {
          matcher: CODEX_SHELL_AND_WRITE_MATCHER,
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

function toSnakeCase(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

export function getCodexHookStates(hooksPath = HOOKS_PATH): CodexHookState[] {
  const absoluteHooksPath = resolve(hooksPath);
  const hookEntries = Object.entries(buildCodexHookConfig().hooks) as Array<[
    CodexHookEvent,
    Array<{ hooks: unknown[] }>,
  ]>;

  return hookEntries.flatMap(([event, entries]) =>
    entries.flatMap((entry, eventIndex) =>
      entry.hooks.map((_hook, hookIndex) => ({
        event,
        eventIndex,
        hookIndex,
        label: `${toSnakeCase(event)}[${eventIndex}]`,
        stateKey: `${absoluteHooksPath}:${toSnakeCase(event)}:${eventIndex}:${hookIndex}`,
      })),
    ),
  );
}

export function parseCodexHookStates(configText: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  let activeStateKey: string | undefined;

  for (const line of configText.split(/\r?\n/)) {
    const table = line.match(/^\s*\[hooks\.state\."([^"]+)"\]\s*(?:#.*)?$/);
    if (table) {
      activeStateKey = table[1];
      continue;
    }

    if (/^\s*\[/.test(line)) {
      activeStateKey = undefined;
      continue;
    }

    if (!activeStateKey) {
      continue;
    }

    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (enabled) {
      states.set(activeStateKey, enabled[1] === "true");
    }
  }

  return states;
}

export function isLinkedWorktree({ checkoutRoot, commonDir }: GitWorktreePaths) {
  const absoluteCheckoutRoot = resolve(checkoutRoot);
  const absoluteCommonDir = resolve(absoluteCheckoutRoot, commonDir);
  return absoluteCheckoutRoot !== dirname(absoluteCommonDir);
}

function readGitWorktreePaths(): GitWorktreePaths | undefined {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [checkoutRoot, commonDir] = output.trim().split(/\r?\n/);
    if (!checkoutRoot || !commonDir) {
      return undefined;
    }
    return { checkoutRoot, commonDir };
  } catch {
    return undefined;
  }
}

function readCodexHookStates(configPath: string) {
  if (!existsSync(configPath)) {
    return new Map<string, boolean>();
  }

  try {
    return parseCodexHookStates(readFileSync(configPath, "utf8"));
  } catch {
    return new Map<string, boolean>();
  }
}

function reportCodexHookStates({ hooksPath, configPath, installed }: { hooksPath: string; configPath: string; installed: boolean }) {
  const states = readCodexHookStates(configPath);
  let hasDisabledHook = false;

  for (const hook of getCodexHookStates(hooksPath)) {
    const enabled = states.get(hook.stateKey);
    const state = enabled === undefined ? "unknown (no state recorded)" : `enabled=${enabled}`;
    console.log(`${hook.label}: ${installed ? "installed" : "not installed"}, ${state}`);
    hasDisabledHook ||= enabled === false;
  }

  if (hasDisabledHook) {
    console.log(DISABLED_HOOK_HINT);
  }
}

function reportWorktreeNote(worktreePaths: GitWorktreePaths | undefined) {
  if (worktreePaths && isLinkedWorktree(worktreePaths)) {
    console.log(WORKTREE_NOTE);
  }
}

export function runAgentHookSetup({
  hooksPath = HOOKS_PATH,
  configPath = CODEX_CONFIG_PATH,
  install = process.env.PHAROS_INSTALL_CODEX_HOOKS === "1",
  worktreePaths = readGitWorktreePaths(),
} = {}) {
  const expected = renderCodexHookConfig();
  if (!install) {
    const current = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";
    const installed = current === expected;
    console.log(
      installed
        ? "Codex project hooks are installed and current."
        : "Codex project hooks are not installed. Re-run with PHAROS_INSTALL_CODEX_HOOKS=1 after reviewing the trusted hook commands.",
    );
    reportCodexHookStates({ hooksPath, configPath, installed });
    reportWorktreeNote(worktreePaths);
    return installed ? 0 : 1;
  }

  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, expected);
  console.log("Installed user-approved Codex project hooks in ignored .codex/hooks.json.");
  reportCodexHookStates({ hooksPath, configPath, installed: true });
  reportWorktreeNote(worktreePaths);
  return 0;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = runAgentHookSetup();
}
