import { beforeEach, describe, expect, it, vi } from "vitest";

// The model reads the live registry, the generated compliance projection and the
// GENIUS regime clock. Editorial curation and the regime phase both move on their
// own schedule, so the corpus below stands in for them: every expectation here is
// an independent oracle over fixture rows, not a restatement of today's data.
const fixtures = vi.hoisted(() => {
  const metas = [
    { id: "euro-emt", name: "Euro EMT", symbol: "EEMT", status: "active", flags: { pegCurrency: "EUR" } },
    { id: "art-basket", name: "Basket Reference", symbol: "BSKT", status: "active", flags: { pegCurrency: "EUR" } },
    { id: "dollar-intent", name: "Dollar Intent", symbol: "DINT", status: "active", flags: { pegCurrency: "USD" } },
    { id: "dollar-review", name: "Dollar Review", symbol: "DREV", status: "active", flags: { pegCurrency: "USD" } },
    { id: "future-coin", name: "Future Coin", symbol: "FUT", status: "pre-launch", flags: { pegCurrency: "USD" } },
    { id: "frozen-coin", name: "Frozen Coin", symbol: "FRZ", status: "frozen", flags: { pegCurrency: "USD" } },
  ];

  const compliance = [
    {
      id: "euro-emt",
      mica: {
        status: "authorized",
        tokenType: "EMT",
        authorizationType: "emi",
        competentAuthority: "BaFin",
        authorizedEntity: "Euro Issuer SA",
        references: [
          { label: "Authorization notice", url: "https://bafin.example/notice" },
          { label: "Register entry", url: "https://bafin.example/register" },
        ],
      },
    },
    {
      id: "art-basket",
      mica: {
        status: "non-compliant",
        tokenType: "ART",
        competentAuthority: "AMF",
      },
    },
    {
      id: "dollar-intent",
      mica: { status: "out-of-scope" },
      proofOfReserves: { latestReport: { periodEnd: "2026-06-30", publishedAt: "2026-07-29" } },
      genius: {
        authorizationStatus: "issuer-announced-intent",
        applicability: "in-scope",
        issuerPathway: "state-qualified",
        issuerEntity: "Intent Labs Inc",
        issuerDomicile: "US",
        primaryFederalRegulator: "OCC",
        stateRegulator: "Nebraska Department of Banking",
        monthlyAttestationPresent: true,
        reserveDisclosurePresent: true,
      },
    },
    {
      id: "dollar-review",
      genius: {
        authorizationStatus: "unknown",
        applicability: "unclear",
        issuerPathway: "unknown",
        foreignExceptionStatus: "unknown",
      },
    },
    {
      id: "future-coin",
      genius: {
        authorizationStatus: "official-application-pending",
        applicability: "in-scope",
        issuerPathway: "federal-occ",
      },
    },
    {
      id: "frozen-coin",
      mica: { status: "authorized", tokenType: "EMT" },
      genius: { authorizationStatus: "ppsi-approved", applicability: "in-scope", issuerPathway: "federal-occ" },
    },
  ];

  return { metas, compliance, isGeniusRegimeEffective: vi.fn(() => false) };
});

vi.mock("@shared/data/stablecoins/coins.compliance.generated.json", () => ({
  default: fixtures.compliance,
}));

vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_TRACKED_STABLECOINS: fixtures.metas,
}));

vi.mock("@shared/lib/compliance-regime-state", () => ({
  GENIUS_REGIME_STATE: { rulemakingPhase: "proposed-rules" },
  isGeniusRegimeEffective: fixtures.isGeniusRegimeEffective,
}));

import {
  buildComplianceOverviewModel,
  buildComplianceStatusDistribution,
  buildComplianceSummary,
  buildComplianceViewModel,
} from "@/lib/compliance-model";
import type { ComplianceFilters, ComplianceRow } from "@/lib/compliance-model";

const NO_FILTERS: ComplianceFilters = {
  regime: "all",
  status: "all",
  tokenType: "all",
  peg: "all",
  search: "",
};

function viewModel(overrides: Partial<ComplianceFilters> = {}) {
  return buildComplianceViewModel({ ...NO_FILTERS, ...overrides });
}

function ids(rows: readonly ComplianceRow[]): string[] {
  return rows.map((row) => row.id);
}

beforeEach(() => {
  fixtures.isGeniusRegimeEffective.mockReturnValue(false);
  fixtures.metas.find(({ id }) => id === "future-coin")!.status = "pre-launch";
});

describe("Compliance model", () => {
  it.each([
    ["pre-launch", false, false, true],
    ["pre-launch", true, false, true],
    ["active", false, false, true],
    ["active", true, true, false],
    ["frozen", false, false, false],
    ["frozen", true, false, false],
    ["quarantined", false, false, false],
    ["quarantined", true, false, false],
    ["delisted", false, false, false],
    ["delisted", true, false, false],
  ] as const)("routes the same %s asset with effective=%s without changing its authorization", (status, effective, main, watch) => {
    fixtures.metas.find(({ id }) => id === "future-coin")!.status = status;
    fixtures.isGeniusRegimeEffective.mockReturnValue(effective);
    const model = viewModel({ regime: "genius" });
    expect(ids(model.rows).includes("future-coin")).toBe(main);
    expect(ids(model.watchRows).includes("future-coin")).toBe(watch);
    const row = [...model.rows, ...model.watchRows].find(({ id }) => id === "future-coin");
    if (main || watch) expect(row?.status).toBe("official-application-pending");
  });

  it("admits only active assets to the main table and keeps pre-launch GENIUS rows in watch", () => {
    const { rows, watchRows, totalTracked } = viewModel();

    // Frozen assets carry both profiles and must appear in neither list; the
    // pre-launch asset is watch-only.
    expect(ids(rows)).toEqual(["euro-emt", "art-basket", "dollar-intent"]);
    expect(ids(watchRows)).toEqual(["future-coin", "dollar-intent", "dollar-review"]);
    expect(rows.every((row) => row.regime === "mica")).toBe(true);
    expect(watchRows.every((row) => row.regime === "genius")).toBe(true);
    expect(totalTracked).toBe(6);
  });

  it("promotes active GENIUS rows into the main table once the regime is effective", () => {
    fixtures.isGeniusRegimeEffective.mockReturnValue(true);

    const { rows, watchRows, isGeniusEffective } = viewModel();

    expect(isGeniusEffective).toBe(true);
    // MiCA rows sort ahead of GENIUS rows; within a regime, display order then symbol.
    expect(rows.map((row) => `${row.regime}:${row.id}`)).toEqual([
      "mica:euro-emt",
      "mica:art-basket",
      "mica:dollar-intent",
      "genius:dollar-intent",
      "genius:dollar-review",
    ]);
    expect(ids(watchRows)).toEqual(["future-coin"]);
  });

  it("projects GENIUS disclosure and regulators without loading fold evidence", () => {
    const { watchRows } = viewModel({ regime: "genius" });
    const intent = watchRows.find((row) => row.id === "dollar-intent");
    const review = watchRows.find((row) => row.id === "dollar-review");
    if (intent?.regime !== "genius" || review?.regime !== "genius") {
      throw new Error("Expected both GENIUS fixture rows");
    }

    expect(intent.primaryFederalRegulator).toBe("OCC");
    expect(intent.reserveReportNote).toContain("period end 2026-06-30");
    expect(intent.reserveReportNote).toContain("published 2026-07-29");
    expect(intent.monthlyAttestationPresent).toBe(true);
    expect(intent.hasAnyDisclosure).toBe(true);
    expect(intent).not.toHaveProperty("references");

    // No disclosure evidence at all must not read as "has disclosure".
    expect(review.hasAnyDisclosure).toBe(false);
    expect(review.reserveReportNote).toBeUndefined();
    expect(review.monthlyAttestationPresent).toBe(false);
    expect(review.foreignExceptionStatus).toBe("unknown");
    for (const field of ["notes", "negativeEvidenceSummary", "negativeEvidenceSourcesChecked", "applicabilitySummary", "references"]) {
      expect(review).not.toHaveProperty(field);
    }
  });

  it("merges regimes into one overview row per asset and keeps the total independent of filters", () => {
    const unfiltered = buildComplianceOverviewModel({ peg: "all", search: "" });
    const intent = unfiltered.rows.find((row) => row.id === "dollar-intent");

    expect(unfiltered.rows).toHaveLength(5);
    expect(unfiltered.totalCoins).toBe(5);
    expect(intent?.mica).toEqual({ status: "out-of-scope" });
    expect(intent?.genius).toEqual({ status: "issuer-announced-intent", inWatch: true });
    expect(unfiltered.rows.find((row) => row.id === "euro-emt")?.genius).toBeUndefined();
    expect(unfiltered.rows.some((row) => row.id === "frozen-coin")).toBe(false);

    const euroOnly = buildComplianceOverviewModel({ peg: "EUR", search: "" });
    expect(euroOnly.rows.map((row) => row.symbol)).toEqual(["EEMT", "BSKT"]);
    expect(euroOnly.totalCoins).toBe(5);

    const searched = buildComplianceOverviewModel({ peg: "all", search: "nebraska" });
    expect(searched.rows.map((row) => row.symbol)).toEqual(["DINT"]);
  });

  it("counts distribution bands and the summary from the same assessed rows", () => {
    expect(buildComplianceStatusDistribution()).toEqual({
      mica: [
        { status: "authorized", count: 1 },
        { status: "non-compliant", count: 1 },
        { status: "out-of-scope", count: 1 },
      ],
      genius: [
        { status: "official-application-pending", count: 1 },
        { status: "issuer-announced-intent", count: 1 },
        { status: "unknown", count: 1 },
      ],
    });

    expect(buildComplianceSummary()).toEqual({
      micaAuthorized: 1,
      micaAssessed: 3,
      geniusTracked: 3,
      assessedRegimeRows: 6,
      micaAuthorizedPct: 33,
    });
  });

});
