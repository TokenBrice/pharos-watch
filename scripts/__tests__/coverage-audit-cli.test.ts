import { describe, expect, it } from "vitest";

import {
  assertCandidateReportLimitChoice,
  createCandidateReportCliOptions,
  formatNumber,
  formatUsd,
  numberValue,
  parseCandidateReportOption,
  stringValue,
} from "../lib/coverage-audit-cli";
import { parseReportCliArgs, renderReport, runReportCli } from "../lib/report-cli";

describe("coverage audit CLI helpers", () => {
  it("preserves compact-USD report bytes across tiers and invalid values", () => {
    expect(formatUsd(1_250_000_000_000)).toBe("$1,250B");
    expect(formatUsd(2_500_000_000)).toBe("$2.5B");
    expect(formatUsd(3_500_000)).toBe("$3.5M");
    expect(formatUsd(4_500)).toBe("$4.5K");
    expect(formatUsd(999.25)).toBe("$999.25");
    expect(formatUsd(-2_500_000)).toBe("$-2,500,000");
    expect(formatUsd(null)).toBe("");
    expect(formatUsd(Number.NaN)).toBe("$NaN");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$∞");
    expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe("-∞");
  });

  it("normalizes finite numbers and trimmed non-empty strings", () => {
    expect(numberValue(12.5)).toBe(12.5);
    expect(numberValue(Number.NaN)).toBeNull();
    expect(numberValue("12.5")).toBeNull();

    expect(stringValue("  USDC  ")).toBe("USDC");
    expect(stringValue("   ")).toBeNull();
    expect(stringValue(42)).toBeNull();
  });

  it("can preserve untrimmed non-empty strings for legacy callers", () => {
    expect(stringValue("  USDC  ", { trim: false })).toBe("  USDC  ");
    expect(stringValue("", { trim: false })).toBeNull();
  });

  it("parses common candidate report options", () => {
    const options = createCandidateReportCliOptions({
      defaultLimit: 50,
      defaultOutputPath: "agents/report.md",
    });
    const argv = [
      "--coin",
      "usdc-circle",
      "--limit",
      "10",
      "--json",
      "--stdout",
      "--generated-at",
      "2026-06-12T00:00:00.000Z",
    ];

    for (let index = 0; index < argv.length; index += 1) {
      const nextIndex = parseCandidateReportOption(options, argv, index, { usage: () => "usage" });
      expect(nextIndex).not.toBeNull();
      index = nextIndex!;
    }

    expect(options).toMatchObject({
      coinIds: ["usdc-circle"],
      limit: 10,
      format: "json",
      stdout: true,
      generatedAt: "2026-06-12T00:00:00.000Z",
    });
    expect(renderReport({ ok: true }, options.format, () => "markdown\n")).toBe(
      '{\n  "ok": true\n}\n',
    );
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
    const parse = (argv: string[]) => parseReportCliArgs<Options>(argv, {
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
    await expect(runReportCli([], {
      parse,
      build: () => ({ generatedAt: "2026-08-28T00:00:00.000Z", rows: ["usdc", "usdt"] }),
      renderMarkdown: (audit) => `# Golden Audit\n\nGenerated: ${audit.generatedAt}\n\n## Rows\n\n${audit.rows.join("\n")}\n`,
      stdout: { write: (value) => { markdownWrites.push(String(value)); return true; } },
    })).resolves.toBe(0);
    expect(markdownWrites.join("")).toBe(
      "# Golden Audit\n\nGenerated: 2026-08-28T00:00:00.000Z\n\n## Rows\n\nusdc\nusdt\n",
    );

    const jsonWrites: string[] = [];
    await runReportCli(["--json"], {
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
