import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCodexHookConfig, renderCodexHookConfig, runAgentHookSetup } from "../maintenance/setup-agent-hooks.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("agent hook setup", () => {
  it("keeps the Codex hook surface stateless and deterministic", () => {
    expect(Object.keys(buildCodexHookConfig().hooks).sort()).toEqual([
      "PermissionRequest",
      "PreToolUse",
      "SessionStart",
    ]);
    expect(renderCodexHookConfig()).toContain("pharos-change-contract.ts");
    expect(renderCodexHookConfig()).not.toContain("PostToolUse");
    expect(renderCodexHookConfig()).not.toContain("Stop");
  });

  it("requires opt-in, then detects the installed config without rewriting it", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "pharos-agent-hooks-"));
    temporaryDirectories.push(directory);
    const hooksPath = resolve(directory, "hooks.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runAgentHookSetup({ hooksPath, install: false })).toBe(1);
    expect(runAgentHookSetup({ hooksPath, install: true })).toBe(0);
    expect(readFileSync(hooksPath, "utf8")).toBe(renderCodexHookConfig());
    expect(runAgentHookSetup({ hooksPath, install: false })).toBe(0);
  });
});
