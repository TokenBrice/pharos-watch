import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexHookConfig,
  getCodexHookStates,
  renderCodexHookConfig,
  runAgentHookSetup,
} from "../maintenance/setup-agent-hooks.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("agent hook setup", () => {
  it("uses the observed shell/write tool matcher and keeps SessionStart unchanged", () => {
    const config = buildCodexHookConfig();

    expect(config.hooks.PermissionRequest[0].matcher).toBe("^(Bash|apply_patch|exec_command)$");
    expect(config.hooks.PreToolUse[0].matcher).toBe("^(Bash|apply_patch|exec_command)$");
    expect(config.hooks.PermissionRequest[0].hooks[0].timeout).toBe(5);
    expect(config.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
    expect(config.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
    expect(renderCodexHookConfig()).not.toContain('"matcher": ".*"');
  });

  it("reports per-hook state and keeps disabled hooks non-fatal", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "pharos-agent-hooks-"));
    temporaryDirectories.push(directory);
    const hooksPath = resolve(directory, "hooks.json");
    const configPath = resolve(directory, "config.toml");
    const preToolUse = getCodexHookStates(hooksPath).find(({ event }) => event === "PreToolUse");
    if (!preToolUse) {
      throw new Error("PreToolUse hook state entry was not generated");
    }
    writeFileSync(configPath, `[hooks.state."${preToolUse.stateKey}"]\nenabled = false\n`);

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      output.push(String(message));
    });

    expect(
      runAgentHookSetup({
        hooksPath,
        configPath,
        install: true,
        worktreePaths: { checkoutRoot: directory, commonDir: resolve(directory, ".git") },
      }),
    ).toBe(0);
    expect(readFileSync(hooksPath, "utf8")).toBe(renderCodexHookConfig());
    expect(output).toContain("pre_tool_use[0]: installed, enabled=false");
    expect(output).toContain("permission_request[0]: installed, unknown (no state recorded)");
    expect(output).toContain("session_start[0]: installed, unknown (no state recorded)");
    expect(output).toContain("Review disabled hooks in Codex /hooks; installation alone does not prove invocation.");
  });
});


