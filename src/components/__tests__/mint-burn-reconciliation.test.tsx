// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MintBurnConservationRecord, MintBurnReconciliationSummary } from "@shared/types";
import { MintBurnReconciliationCard } from "@/components/status/mint-burn-reconciliation";

function makeSummary(rowCount = 1): MintBurnReconciliationSummary {
  return {
    checkedAt: 1_773_000_000,
    comparedCoins: rowCount,
    criticalCount: rowCount,
    warnCount: 0,
    insufficientCount: 0,
    rows: Array.from({ length: rowCount }, (_, index) => ({
      stablecoinId: `coin-${index}`,
      symbol: `SYM${index}`,
      flowNet24hUsd: 1_000_000,
      chainSupplyDelta24hUsd: 900_000,
      absoluteDiffUsd: 100_000,
      diffRatio: 0.12,
      status: "critical",
      coverageStatus: "full",
    })),
  };
}

function record(overrides: Partial<MintBurnConservationRecord> = {}): MintBurnConservationRecord {
  return {
    version: 1,
    key: "ethereum-token",
    configFingerprint: "fingerprint",
    stablecoinId: "coin-0",
    chainId: "ethereum",
    address: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    checkedAt: 1_773_000_000,
    status: "ok",
    fromBlock: 100,
    toBlock: 200,
    mintRaw: "1234567890123456789",
    burnRaw: "0",
    supplyDeltaRaw: "1234567890123456789",
    residualRaw: "0",
    ...overrides,
  };
}

function group(symbol = "SYM0") {
  return within(screen.getByRole("group", { name: `${symbol} mint/burn integrity` }));
}

describe("MintBurnReconciliationCard", () => {
  it("keeps legacy critical and healthy rows unverified, with indicative values collapsed", () => {
    const summary = makeSummary(2);
    summary.rows[1]!.status = "ok";
    render(<MintBurnReconciliationCard summary={summary} />);
    expect(group().getByText("Unverified")).toBeTruthy();
    expect(group("SYM1").getByText("Unverified")).toBeTruthy();
    expect(group().queryByText("Critical")).toBeNull();
    expect(group("SYM1").queryByText("Verified")).toBeNull();
    const disclosure = group().getByText("Indicative circulating-supply comparison").closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(within(disclosure).getByText(/Timing, filters and valuation are unverified/)).toBeTruthy();
    expect(within(disclosure).getByText("Classified flow net 24h")).toBeTruthy();
    expect(within(disclosure).getByText("Indicative gap")).toBeTruthy();
  });

  it("shows exact token precision for a verified latest scan without presenting a 24h audit", () => {
    const summary = makeSummary();
    summary.conservationVersion = 1;
    summary.rows[0]!.status = "ok";
    summary.rows[0]!.conservation = [record()];
    render(<MintBurnReconciliationCard summary={summary} />);
    expect(group().getByText("Verified")).toBeTruthy();
    expect(group().getByText("Audit coverage: All configured contracts verified")).toBeTruthy();
    expect(group().getAllByText("1.234567890123456789")).toHaveLength(2);
    expect(group().getByText("Supply checkpoints 100–200")).toBeTruthy();
    expect(group().getByText("Residual (SYM0)")).toBeTruthy();
    expect(screen.getByText(/This is not a 24-hour audit/)).toBeTruthy();
    expect(group().getByText("Matched")).toBeTruthy();
  });

  it("reserves critical for matched-block mismatches and does not round a one-wei residual away", () => {
    const summary = makeSummary();
    summary.conservationVersion = 1;
    summary.rows[0]!.conservation = [record({ status: "mismatch", residualRaw: "-1" })];
    render(<MintBurnReconciliationCard summary={summary} />);
    expect(group().getByText("Critical")).toBeTruthy();
    expect(group().getByText("-0.000000000000000001")).toBeTruthy();
    expect(group().getByText("Mismatch")).toBeTruthy();
  });

  it("shows each contract range and leaves partial, stale or unsupported coverage unverified", () => {
    const summary = makeSummary();
    summary.conservationVersion = 1;
    summary.rows[0]!.status = "insufficient-source";
    summary.rows[0]!.conservation = [
      record(),
      record({ key: "base-token", chainId: "base", fromBlock: 300, toBlock: 450, decimals: 6, mintRaw: "10000001", status: "unsupported", reason: "Rebasing token requires a specialized conservation audit." }),
    ];
    render(<MintBurnReconciliationCard summary={summary} />);
    expect(group().getByText("Unverified")).toBeTruthy();
    expect(group().getByText("Supply checkpoints 100–200")).toBeTruthy();
    expect(group().getByText("Supply checkpoints 300–450")).toBeTruthy();
    expect(group().getByText("10.000001")).toBeTruthy();
    expect(group().getByText("Unsupported")).toBeTruthy();
    expect(group().getByText(/Rebasing token requires/)).toBeTruthy();
    expect(group().queryByText("Verified")).toBeNull();
  });

  it("does not turn a stale recorded match or version-only payload green", () => {
    const summary = makeSummary(2);
    summary.conservationVersion = 1;
    summary.rows[0]!.status = "insufficient-source";
    summary.rows[0]!.conservation = [record()];
    summary.rows[1]!.status = "ok";
    render(<MintBurnReconciliationCard summary={summary} />);
    expect(group().getByText("Unverified")).toBeTruthy();
    expect(group("SYM1").getByText("No matched-block audit available.")).toBeTruthy();
    expect(group("SYM1").queryByText("Verified")).toBeNull();
  });

  it("keeps source incompatibility explanations inside indicative context", () => {
    const summary = makeSummary();
    summary.rows[0]!.comparisonIssue = "Rebases change token supply without mint/burn events.";
    render(<MintBurnReconciliationCard summary={summary} />);
    const explanation = screen.getByText("Rebases change token supply without mint/burn events.");
    expect(explanation.closest("details")?.open).toBe(false);
  });

  it("expands and collapses the long tail while prioritizing audit mismatches", () => {
    const summary = makeSummary(8);
    summary.conservationVersion = 1;
    summary.rows[7]!.conservation = [record({ stablecoinId: "coin-7", status: "mismatch" })];
    render(<MintBurnReconciliationCard summary={summary} />);
    expect(screen.getAllByRole("group")[0]!.getAttribute("aria-label")).toBe("SYM7 mint/burn integrity");
    expect(screen.queryByText("SYM6")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "See all 8 assets" }));
    expect(screen.getByText("SYM6")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show fewer" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByText("SYM6")).toBeNull();
  });
  it("puts verified audits ahead of wholly unsupported rows, after actionable unverified rows", () => {
    const summary = makeSummary(4);
    summary.conservationVersion = 1;
    summary.rows[0]!.status = "insufficient-source";
    summary.rows[0]!.conservation = [record({ status: "unsupported" })];
    summary.rows[1]!.status = "ok";
    summary.rows[1]!.conservation = [record()];
    summary.rows[2]!.status = "insufficient-source";
    summary.rows[2]!.conservation = [record({ status: "unavailable" })];
    summary.rows[3]!.conservation = [record({ status: "mismatch" })];
    render(<MintBurnReconciliationCard summary={summary} />);
    expect(screen.getAllByRole("group", { name: /mint\/burn integrity/ }).map((element) => element.getAttribute("aria-label"))).toEqual([
      "SYM3 mint/burn integrity", "SYM2 mint/burn integrity", "SYM1 mint/burn integrity", "SYM0 mint/burn integrity",
    ]);
  });

  it("handles out-of-range audit timestamps without crashing", () => {
    const summary = makeSummary();
    summary.conservationVersion = 1;
    summary.rows[0]!.conservation = [record({ checkedAt: Number.MAX_SAFE_INTEGER })];
    render(<MintBurnReconciliationCard summary={summary} />);
    expect(group().getByText("Checked date unavailable")).toBeTruthy();
  });

});
