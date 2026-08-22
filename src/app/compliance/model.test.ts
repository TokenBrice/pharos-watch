import { describe, expect, it } from "vitest";
import {
  buildComplianceOverviewModel,
  buildComplianceStatusDistribution,
  buildComplianceSummary,
  buildComplianceViewModel,
  groupComplianceRowsIntoBands,
  normalizeComplianceRegimeFilter,
  normalizeComplianceStatusFilter,
  normalizeMicaTokenTypeFilter,
} from "@/lib/compliance-model";

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
    expect(pyusd?.regime).toBe("genius");
    if (pyusd?.regime !== "genius") throw new Error("Expected PYUSD GENIUS row");
    expect(pyusd?.primaryFederalRegulator).toBe("OCC");
    expect(pyusd?.latestReportDate).toBe("2026-04-30");
    expect(pyusd?.monthlyAttestationPresent).toBe(true);

    const cusd = watchRows.find((row) => row.id === "cusd-celo" && row.regime === "genius");
    expect(cusd?.regime).toBe("genius");
    if (cusd?.regime !== "genius") throw new Error("Expected cUSD GENIUS row");
    expect(cusd?.foreignExceptionStatus).toBe("unknown");
    expect(cusd?.negativeEvidenceSummary).toContain("Mento Labs");
    expect(cusd?.negativeEvidenceSourcesChecked.length).toBeGreaterThan(0);
    expect(cusd?.references.some((reference) => reference.url.includes("registercheck.de"))).toBe(true);
  });

  it("merges regime assessments into one overview row and marks GENIUS watch rows", () => {
    const { rows, totalCoins } = buildComplianceOverviewModel({ peg: "all", search: "" });
    const usdt = rows.find((row) => row.id === "usdt-tether");

    expect(rows.filter((row) => row.id === "usdt-tether")).toHaveLength(1);
    expect(usdt?.mica).toBeDefined();
    expect(usdt?.genius).toBeDefined();
    expect(usdt?.genius?.inWatch).toBe(true);
    expect(totalCoins).toBe(rows.length);
  });

  it("sorts overview rows by their most notable regime status, then symbol", () => {
    const { rows } = buildComplianceOverviewModel({ peg: "all", search: "" });
    const micaOrder = ["authorized", "pending", "transitional", "non-compliant", "out-of-scope"];
    const geniusOrder = [
      "ppsi-approved",
      "state-qualified",
      "official-application-pending",
      "issuer-announced-intent",
      "no-public-authorization-found",
      "unknown",
      "not-applicable",
    ];
    const rank = (index: number) => index === -1 ? Number.POSITIVE_INFINITY : index;

    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      const previousRank = Math.min(
        rank(previous.mica ? micaOrder.indexOf(previous.mica.status) : -1),
        rank(previous.genius ? geniusOrder.indexOf(previous.genius.status) : -1),
      );
      const currentRank = Math.min(
        rank(current.mica ? micaOrder.indexOf(current.mica.status) : -1),
        rank(current.genius ? geniusOrder.indexOf(current.genius.status) : -1),
      );

      expect(previousRank).toBeLessThanOrEqual(currentRank);
      if (previousRank === currentRank) {
        expect(previous.symbol.localeCompare(current.symbol)).toBeLessThanOrEqual(0);
      }
    }
  });

  it("groups regime rows in display order with collapsed null-signal bands", () => {
    const { rows, watchRows } = buildComplianceViewModel({
      regime: "all",
      status: "all",
      tokenType: "all",
      peg: "all",
      search: "",
    });
    const micaRow = rows.find((row) => row.regime === "mica");
    const geniusRow = watchRows.find((row) => row.regime === "genius");
    if (!micaRow || !geniusRow) throw new Error("Expected MiCA and GENIUS fixture rows");

    const micaBands = groupComplianceRowsIntoBands([
      { ...micaRow, status: "out-of-scope" },
      { ...micaRow, status: "authorized" },
      { ...micaRow, status: "non-compliant" },
    ], "mica");
    expect(micaBands.map(({ status, label, collapsedByDefault }) => ({ status, label, collapsedByDefault }))).toEqual([
      { status: "authorized", label: "Authorized", collapsedByDefault: false },
      { status: "non-compliant", label: "Non-Compliant", collapsedByDefault: false },
      { status: "out-of-scope", label: "Out of Scope", collapsedByDefault: true },
    ]);

    const geniusBands = groupComplianceRowsIntoBands([
      { ...geniusRow, status: "not-applicable" },
      { ...geniusRow, status: "issuer-announced-intent" },
      { ...geniusRow, status: "unknown" },
      { ...geniusRow, status: "no-public-authorization-found" },
    ], "genius");
    expect(geniusBands.map(({ status, collapsedByDefault }) => ({ status, collapsedByDefault }))).toEqual([
      { status: "issuer-announced-intent", collapsedByDefault: false },
      { status: "no-public-authorization-found", collapsedByDefault: true },
      { status: "unknown", collapsedByDefault: true },
      { status: "not-applicable", collapsedByDefault: true },
    ]);
  });

  it("builds unfiltered status distributions consistent with the compliance summary", () => {
    const distribution = buildComplianceStatusDistribution();
    const summary = buildComplianceSummary();
    const micaCount = distribution.mica.reduce((total, item) => total + item.count, 0);
    const geniusCount = distribution.genius.reduce((total, item) => total + item.count, 0);

    expect(micaCount).toBe(summary.micaAssessed);
    expect(distribution.mica.find((item) => item.status === "authorized")?.count).toBe(summary.micaAuthorized);
    expect(geniusCount).toBe(summary.geniusTracked);
    expect(micaCount + geniusCount).toBe(summary.assessedRegimeRows);
    expect(distribution.mica.every((item) => item.count > 0)).toBe(true);
    expect(distribution.genius.every((item) => item.count > 0)).toBe(true);
  });

  it("normalizes unknown URL filter values to all", () => {
    expect(normalizeComplianceRegimeFilter("bogus")).toBe("all");
    expect(normalizeComplianceStatusFilter("bogus")).toBe("all");
    expect(normalizeComplianceStatusFilter("authorized", "genius")).toBe("all");
    expect(normalizeMicaTokenTypeFilter("bogus")).toBe("all");
  });
});
