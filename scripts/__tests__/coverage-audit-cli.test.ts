import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertCandidateReportLimitChoice,
  createCandidateReportCliOptions,
  numberValue,
  stringValue,
} from "../lib/coverage-audit-cli";
import { parseCoverageAuditCliArgs, runCoverageAuditCli } from "../lib/coverage-audit-cli";

describe("coverage audit CLI helpers", () => {
  it("normalizes finite numbers and trimmed non-empty strings", () => {
    expect(numberValue(12.5)).toBe(12.5);
    expect(numberValue(Number.NaN)).toBeNull();
    expect(numberValue("12.5")).toBeNull();

    expect(stringValue("  USDC  ")).toBe("USDC");
    expect(stringValue("   ")).toBeNull();
    expect(stringValue(42)).toBeNull();
  });

  it("rejects --all combined with a custom limit", () => {
    const options = createCandidateReportCliOptions({
      defaultLimit: 50,
      defaultOutputPath: "agents/report.md",
    });
    options.all = true;
    options.limit = 10;

    expect(() => assertCandidateReportLimitChoice(options, 50)).toThrow("Choose either --all or --limit");
  });

  it("strictly parses descriptor options and routes the rendered report to stdout", async () => {
    type Options = { format: "markdown" | "json"; reportPath: string | null; limit: number };
    const parse = (argv: string[]) => parseCoverageAuditCliArgs<Options>(argv, {
      createOptions: () => ({ format: "markdown", reportPath: null, limit: 2 }),
      options: [{
        flag: "--limit",
        kind: "value",
        missingMessage: "--limit requires a value",
        apply: (options, value) => { options.limit = Number(value); },
      }],
    });
    expect(parse(["--limit", "1", "--json"])).toEqual({ format: "json", reportPath: null, limit: 1 });
    expect(() => parse(["--limit"])).toThrow("--limit requires a value");
    expect(() => parse(["--wat"])).toThrow("Unknown argument: --wat");

    const markdownWrites: string[] = [];
    await expect(runCoverageAuditCli([], {
      parse,
      build: () => ({ generatedAt: "2026-08-28T00:00:00.000Z", rows: ["usdc", "usdt"] }),
      renderMarkdown: () => "# Golden Audit\n",
      stdout: { write: (value) => { markdownWrites.push(String(value)); return true; } },
    })).resolves.toBe(0);
    expect(markdownWrites.join("")).toBe("# Golden Audit\n");

    const jsonWrites: string[] = [];
    await runCoverageAuditCli(["--json"], {
      parse,
      build: () => ({ generatedAt: "2026-08-28T00:00:00.000Z", rows: ["usdc", "usdt"] }),
      renderMarkdown: () => "unused",
      stdout: { write: (value) => { jsonWrites.push(String(value)); return true; } },
    });
    expect(jsonWrites.join("")).toBe(
      '{\n  "generatedAt": "2026-08-28T00:00:00.000Z",\n  "rows": [\n    "usdc",\n    "usdt"\n  ]\n}\n',
    );
  });

  it("writes one report file and nothing else when a report path is set", async ({ onTestFinished }) => {
    type Options = { format: "markdown" | "json"; reportPath: string | null; limit: number };
    const parse = (argv: string[]) => parseCoverageAuditCliArgs<Options>(argv, {
      createOptions: () => ({ format: "markdown", reportPath: null, limit: 2 }),
    });
    const cwd = mkdtempSync(join(tmpdir(), "pharos-coverage-audit-cli-"));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    const writes: string[] = [];
    const descriptor = {
      parse,
      build: () => ({ rows: ["usdc"] }),
      renderMarkdown: () => "# Report\n",
      cwd,
      stdout: { write: (value: string) => { writes.push(String(value)); return true; } },
    };

    await expect(runCoverageAuditCli(["--report", "audit.md"], descriptor)).resolves.toBe(0);
    expect(readFileSync(join(cwd, "audit.md"), "utf8")).toBe("# Report\n");
    expect(writes.join("")).toBe("");

    await expect(runCoverageAuditCli(["--report", "failed.md"], {
      ...descriptor,
      build: () => { throw new Error("audit unavailable"); },
    })).rejects.toThrow("audit unavailable");
    expect(existsSync(join(cwd, "failed.md"))).toBe(false);
  });
});
