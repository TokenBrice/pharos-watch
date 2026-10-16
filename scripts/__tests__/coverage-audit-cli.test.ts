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

  it("strictly parses descriptor options and preserves golden Markdown/JSON bytes", async () => {
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
      renderMarkdown: (audit) => `# Golden Audit\n\nGenerated: ${audit.generatedAt}\n\n## Rows\n\n${audit.rows.join("\n")}\n`,
      stdout: { write: (value) => { markdownWrites.push(String(value)); return true; } },
    })).resolves.toBe(0);
    expect(markdownWrites.join("")).toBe(
      "# Golden Audit\n\nGenerated: 2026-08-28T00:00:00.000Z\n\n## Rows\n\nusdc\nusdt\n",
    );

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
});
