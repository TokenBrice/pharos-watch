import { describe, expect, it } from "vitest";

import {
  assertCandidateReportLimitChoice,
  createCandidateReportCliOptions,
  numberValue,
  parseCandidateReportOption,
  renderCoverageAuditReport,
  stringValue,
} from "../lib/coverage-audit-cli";

describe("coverage audit CLI helpers", () => {
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
    expect(renderCoverageAuditReport({ ok: true }, options.format, () => "markdown\n")).toBe(
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
});
