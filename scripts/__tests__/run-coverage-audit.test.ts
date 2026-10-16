import { describe, expect, it, vi } from "vitest";
import type { CommandResult, SpawnCommand } from "../lib/command-runner.mts";
import {
  DOMAIN_SCRIPTS,
  runCoverageAudit,
  type RunCoverageAuditOptions,
} from "../maintenance/run-coverage-audit";

const domains = Object.keys(DOMAIN_SCRIPTS);

function quietOptions(overrides: Partial<RunCoverageAuditOptions> = {}): RunCoverageAuditOptions {
  return {
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe("run-coverage-audit", () => {
  it("runs every selected domain after failures and returns the last non-zero status", async () => {
    const commands: SpawnCommand[] = [];
    const statuses = [7, 0, 9];
    const runCommandImpl = vi.fn((command: SpawnCommand): CommandResult => {
      commands.push(command);
      return { status: statuses[commands.length - 1] ?? 0, aborted: false };
    });
    const options = quietOptions({ runCommandImpl });

    const status = await runCoverageAudit(
      ["--domain=dependency-coverage", "--domain=reserve-coverage", "--domain=oracle-risk", "--json"],
      options,
    );

    expect(status).toBe(9);
    expect(commands.map((command) => command.args)).toEqual([
      [DOMAIN_SCRIPTS["dependency-coverage"], "--json"],
      [DOMAIN_SCRIPTS["reserve-coverage"], "--json"],
      [DOMAIN_SCRIPTS["oracle-risk"], "--json"],
    ]);
    expect(options.error).toHaveBeenCalledWith("[audit:coverage] dependency-coverage exited with status 7");
    expect(options.error).toHaveBeenCalledWith("[audit:coverage] oracle-risk exited with status 9");
  });

  it("runs --all through the spawn runner and preserves signal-backed failure status", async () => {
    const commands: SpawnCommand[] = [];
    const runCommandImpl = vi.fn((command: SpawnCommand): CommandResult => {
      commands.push(command);
      return commands.length === 4
        ? { status: 1, aborted: false, signal: "SIGTERM" }
        : { status: 0, aborted: false };
    });
    const options = quietOptions({ runCommandImpl });

    const status = await runCoverageAudit(["--all"], options);

    expect(status).toBe(1);
    expect(commands).toHaveLength(domains.length);
    expect(commands.map((command) => command.args[0])).toEqual(
      domains.map((domain) => DOMAIN_SCRIPTS[domain as keyof typeof DOMAIN_SCRIPTS]),
    );
    expect(options.error).toHaveBeenCalledWith("[audit:coverage] reserve-coverage exited with status 1");
  });

});
