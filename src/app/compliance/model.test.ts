import { describe, expect, it } from "vitest";
import {
  buildComplianceViewModel,
  normalizeComplianceRegimeFilter,
  normalizeComplianceStatusFilter,
  normalizeMicaTokenTypeFilter,
} from "./model";

describe("Compliance model", () => {
  it("builds current compliance rows without frozen or pre-launch assets in the main table", () => {
    const { rows, watchRows } = buildComplianceViewModel({
      regime: "all",
      status: "all",
      tokenType: "all",
      peg: "all",
      search: "",
    });

    expect(rows.some((row) => row.id === "euroe-membrane")).toBe(false);
    expect(rows.some((row) => row.id === "tgld-tenbin")).toBe(false);
    expect(rows.find((row) => row.id === "usdt-tether" && row.regime === "mica")?.references.length).toBeGreaterThan(1);
    expect(watchRows.every((row) => row.regime === "genius")).toBe(true);
  });

  it("filters MiCA rows by status, token type, peg, and search", () => {
    const { rows, watchRows } = buildComplianceViewModel({
      regime: "mica",
      status: "authorized",
      tokenType: "EMT",
      peg: "EUR",
      search: "eur",
    });

    expect(watchRows).toHaveLength(0);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.regime === "mica")).toBe(true);
    expect(rows.every((row) => row.status === "authorized")).toBe(true);
    expect(rows.every((row) => row.regime === "mica" && row.tokenType === "EMT")).toBe(true);
    expect(rows.every((row) => row.peg === "EUR")).toBe(true);
    expect(rows.every((row) => `${row.name} ${row.symbol}`.toLowerCase().includes("eur"))).toBe(true);
  });

  it("keeps pre-effective GENIUS rows in implementation watch", () => {
    const { rows, watchRows, isGeniusEffective } = buildComplianceViewModel({
      regime: "genius",
      status: "issuer-announced-intent",
      tokenType: "all",
      peg: "USD",
      search: "",
    });

    expect(isGeniusEffective).toBe(false);
    expect(rows).toHaveLength(0);
    expect(watchRows.every((row) => row.regime === "genius")).toBe(true);
    expect(watchRows.every((row) => row.status === "issuer-announced-intent")).toBe(true);
    expect(watchRows.every((row) => row.peg === "USD")).toBe(true);
  });

  it("searches GENIUS issuer and authority fields", () => {
    const { watchRows } = buildComplianceViewModel({
      regime: "genius",
      status: "all",
      tokenType: "all",
      peg: "all",
      search: "Nebraska",
    });

    expect(watchRows.some((row) => row.id === "eusd-telcoin")).toBe(true);
  });

  it("projects GENIUS disclosure, regulator, review, and nested source fields", () => {
    const { watchRows } = buildComplianceViewModel({
      regime: "genius",
      status: "all",
      tokenType: "all",
      peg: "all",
      search: "",
    });

    const pyusd = watchRows.find((row) => row.id === "pyusd-paypal" && row.regime === "genius");
    expect(pyusd?.primaryFederalRegulator).toBe("OCC");
    expect(pyusd?.latestReportDate).toBe("2026-04-30");
    expect(pyusd?.monthlyAttestationPresent).toBe(true);

    const cusd = watchRows.find((row) => row.id === "cusd-celo" && row.regime === "genius");
    expect(cusd?.foreignExceptionStatus).toBe("unknown");
    expect(cusd?.negativeEvidenceSummary).toContain("Mento Labs");
    expect(cusd?.negativeEvidenceSourcesChecked.length).toBeGreaterThan(0);
    expect(cusd?.references.some((reference) => reference.url.includes("registercheck.de"))).toBe(true);
  });

  it("normalizes unknown URL filter values to all", () => {
    expect(normalizeComplianceRegimeFilter("bogus")).toBe("all");
    expect(normalizeComplianceStatusFilter("bogus")).toBe("all");
    expect(normalizeComplianceStatusFilter("authorized", "genius")).toBe("all");
    expect(normalizeMicaTokenTypeFilter("bogus")).toBe("all");
  });
});
