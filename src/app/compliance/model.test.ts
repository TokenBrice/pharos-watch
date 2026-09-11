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

  const registerReference = { label: "Register", url: "https://registercheck.example/entry" };

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
        latestReportDate: "2026-04-30",
      },
    },
    {
      id: "dollar-review",
      genius: {
        authorizationStatus: "unknown",
        applicability: "unclear",
        issuerPathway: "unknown",
        foreignExceptionStatus: "unknown",
        references: [registerReference],
        applicabilityBasis: {
          summary: "Offered to US persons",
          references: [{ label: "Basis", url: "https://basis.example/" }],
        },
        negativeEvidenceReview: {
          summary: "No authorization filing found for Review Labs",
          sourcesChecked: ["OCC", "FDIC"],
          // Same reference as the profile-level list: the projection must dedupe.
          references: [registerReference],
        },
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
  groupComplianceRowsIntoBands,
  normalizeComplianceRegimeFilter,
  normalizeComplianceStatusFilter,
  normalizeMicaTokenTypeFilter,
} from "@/lib/compliance-model";
import type { ComplianceFilters, ComplianceRow, GeniusComplianceRow, MicaComplianceRow } from "@/lib/compliance-model";

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
});

describe("Compliance model", () => {
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

  it("applies each MiCA filter axis independently", () => {
    expect(ids(viewModel({ regime: "mica", status: "authorized" }).rows)).toEqual(["euro-emt"]);
    expect(ids(viewModel({ regime: "mica", tokenType: "ART" }).rows)).toEqual(["art-basket"]);
    expect(ids(viewModel({ peg: "EUR" }).rows)).toEqual(["euro-emt", "art-basket"]);
    // The only EUR assets are MiCA-only, so the GENIUS watch list empties out.
    expect(viewModel({ peg: "EUR" }).watchRows).toHaveLength(0);
    // Search covers MiCA authority fields, not just names.
    expect(ids(viewModel({ search: "bafin" }).rows)).toEqual(["euro-emt"]);
    // Conflicting axes intersect rather than fall back to either one.
    expect(viewModel({ regime: "mica", status: "authorized", tokenType: "ART" }).rows).toHaveLength(0);
  });

  it("filters the GENIUS watch list by status, peg, and issuer/regulator search", () => {
    expect(ids(viewModel({ regime: "genius", status: "issuer-announced-intent" }).watchRows)).toEqual([
      "dollar-intent",
    ]);
    expect(viewModel({ regime: "genius", status: "issuer-announced-intent" }).rows).toHaveLength(0);
    expect(ids(viewModel({ regime: "genius", peg: "USD" }).watchRows)).toEqual([
      "future-coin",
      "dollar-intent",
      "dollar-review",
    ]);
    // "Nebraska" only appears in a state-regulator field.
    expect(ids(viewModel({ regime: "genius", search: "nebraska" }).watchRows)).toEqual(["dollar-intent"]);
    expect(ids(viewModel({ regime: "genius", search: "intent labs" }).watchRows)).toEqual(["dollar-intent"]);
  });

  it("projects GENIUS disclosure, regulator, review, and deduplicated nested references", () => {
    const { watchRows } = viewModel({ regime: "genius" });
    const intent = watchRows.find((row) => row.id === "dollar-intent");
    const review = watchRows.find((row) => row.id === "dollar-review");
    if (intent?.regime !== "genius" || review?.regime !== "genius") {
      throw new Error("Expected both GENIUS fixture rows");
    }

    expect(intent.primaryFederalRegulator).toBe("OCC");
    expect(intent.latestReportDate).toBe("2026-04-30");
    expect(intent.monthlyAttestationPresent).toBe(true);
    expect(intent.hasAnyDisclosure).toBe(true);
    expect(intent.negativeEvidenceSourcesChecked).toEqual([]);

    // No disclosure evidence at all must not read as "has disclosure".
    expect(review.hasAnyDisclosure).toBe(false);
    expect(review.monthlyAttestationPresent).toBe(false);
    expect(review.foreignExceptionStatus).toBe("unknown");
    expect(review.negativeEvidenceSummary).toContain("Review Labs");
    expect(review.negativeEvidenceSourcesChecked).toEqual(["OCC", "FDIC"]);
    expect(review.applicabilitySummary).toBe("Offered to US persons");
    // Profile-level and nested review references collapse to one entry.
    expect(review.references).toEqual([
      { label: "Register", url: "https://registercheck.example/entry" },
      { label: "Basis", url: "https://basis.example/" },
    ]);
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

  it("sorts overview rows by their most notable regime status, then symbol", () => {
    const { rows } = buildComplianceOverviewModel({ peg: "all", search: "" });

    // EEMT authorized (best MiCA), FUT official-application-pending, then the
    // rank tie between BSKT (non-compliant) and DINT (issuer intent) broken by
    // symbol, then DREV (unknown).
    expect(rows.map((row) => row.symbol)).toEqual(["EEMT", "FUT", "BSKT", "DINT", "DREV"]);
  });

  it("groups regime rows in display order with collapsed null-signal bands", () => {
    const { rows, watchRows } = viewModel();
    const micaRow = rows.find((row): row is MicaComplianceRow => row.regime === "mica")!;
    const geniusRow = watchRows.find((row): row is GeniusComplianceRow => row.regime === "genius")!;

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
    // A band only exists where rows exist, and it keeps its own rows.
    expect(groupComplianceRowsIntoBands([{ ...micaRow, status: "pending" }], "genius")).toEqual([]);
    expect(micaBands[0]!.rows).toHaveLength(1);
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

  it("normalizes URL filter values against the selected regime", () => {
    expect(normalizeComplianceRegimeFilter("bogus")).toBe("all");
    expect(normalizeComplianceRegimeFilter("genius")).toBe("genius");
    expect(normalizeComplianceStatusFilter("bogus")).toBe("all");
    expect(normalizeComplianceStatusFilter("authorized", "genius")).toBe("all");
    expect(normalizeComplianceStatusFilter("ppsi-approved", "genius")).toBe("ppsi-approved");
    expect(normalizeComplianceStatusFilter("ppsi-approved", "mica")).toBe("all");
    expect(normalizeComplianceStatusFilter("authorized", "all")).toBe("authorized");
    expect(normalizeMicaTokenTypeFilter("bogus")).toBe("all");
    expect(normalizeMicaTokenTypeFilter("ART")).toBe("ART");
  });
});
