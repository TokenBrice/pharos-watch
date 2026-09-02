import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexHookConfig,
  getCodexHookStates,
  isLinkedWorktree,
  parseCodexHookStates,
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

    expect(config.hooks.PermissionRequest[0].matcher).toBe("^(apply_patch|exec_command)$");
    expect(config.hooks.PreToolUse[0].matcher).toBe("^(apply_patch|exec_command)$");
    expect(config.hooks.PermissionRequest[0].hooks[0].timeout).toBe(5);
    expect(config.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
    expect(config.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
    expect(renderCodexHookConfig()).not.toContain('"matcher": ".*"');
  });

  it("parses enabled state from matching tables and ignores absent tables", () => {
    const enabledKey = "/repo/.codex/hooks.json:pre_tool_use:0:0";
    const disabledKey = "/repo/.codex/hooks.json:permission_request:0:0";
    const missingKey = "/repo/.codex/hooks.json:session_start:0:0";
    const configText = [
      `[hooks.state."${enabledKey}"]`,
      "enabled = true",
      `[hooks.state."${disabledKey}"]`,
      "enabled = false",
      "",
    ].join("\n");

    const states = parseCodexHookStates(configText);

    expect(states.get(enabledKey)).toBe(true);
    expect(states.get(disabledKey)).toBe(false);
    expect(states.has(missingKey)).toBe(false);
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
    expect(output).toContain("Enable in Codex: /hooks or set enabled = true");
  });

  it("detects linked worktrees from injected Git paths", () => {
    expect(isLinkedWorktree({ checkoutRoot: "/repo", commonDir: ".git" })).toBe(false);
    expect(isLinkedWorktree({ checkoutRoot: "/repo/worktrees/feature", commonDir: "/repo/.git" })).toBe(true);
    expect(isLinkedWorktree({ checkoutRoot: "/repo/worktrees/feature", commonDir: "../../.git" })).toBe(true);
  });
});
