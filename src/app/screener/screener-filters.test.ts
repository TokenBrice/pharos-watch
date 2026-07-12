import { describe, expect, it } from "vitest";
import {
  SCREENER_FILTER_DEFAULTS,
  SCREENER_URL_SCHEMA,
  applyFilters,
  countActiveScreenerFilters,
  hasLoadingScoreFilterData,
  hasActiveFilters,
  normalizeScreenerDeepLinkAliases,
  projectBlacklistable,
  projectMintAuthority,
  sortScreenerRows,
  type ScreenerFilters,
  type ScreenerRow,
} from "./screener-filters";
import { decodeState, encodeState } from "@/lib/url-state";

function makeRow(overrides: Partial<ScreenerRow> = {}): ScreenerRow {
  return {
    id: "usdc-circle",
    name: "USD Coin",
    symbol: "USDC",
    lifecycle: "active",
    type: "centralized",
    mechanism: "fiat-cash",
    peg: "USD",
    supplyUsd: 50_000_000_000,
    pegScore: 95,
    dewsScore: 20,
    liquidityScore: 85,
    safetyGrade: "A",
    safetyScore: 90,
    safetyPegStabilityScore: 92,
    safetyLiquidityScore: 88,
    safetyResilienceScore: 84,
    safetyDecentralizationScore: 76,
    safetyDependencyRiskScore: 82,
    blacklistable: "yes",
    mintAuthority: "issuer-or-backend-mint",
    mintAuthorityScore: 70,
    mintAuthorityScoreBand: "governed",
    mintAuthorityScoreLabel: "70/100",
    mintAuthorityScoreBandLabel: "Governed",
    mintAuthorityScoreBadgeClassName: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    mintAuthorityScoreDetail: "Mint Authority Score: 70/100 (Governed).",
    ...overrides,
  };
}

describe("applyFilters", () => {
  const rows: ScreenerRow[] = [
    makeRow(),
    makeRow({
      id: "dai-makerdao",
      name: "Dai",
      symbol: "DAI",
      mechanism: "cdp",
      pegScore: 88,
      dewsScore: 35,
      liquidityScore: 70,
      safetyScore: 80,
      safetyGrade: "B+",
      supplyUsd: 5_000_000_000,
    }),
    makeRow({
      id: "eurs-stasis",
      name: "STASIS Euro",
      symbol: "EURS",
      mechanism: "fiat-cash",
      peg: "EUR",
      pegScore: 70,
      dewsScore: 50,
      liquidityScore: 40,
      supplyUsd: 100_000_000,
      safetyGrade: "C+",
      safetyScore: 65,
    }),
    makeRow({
      id: "newcoin",
      name: "Brand New",
      symbol: "NEW",
      mechanism: null,
      pegScore: null,
      dewsScore: null,
      liquidityScore: null,
      supplyUsd: 1_000_000,
      lifecycle: "pre-launch",
      safetyGrade: null,
      safetyScore: null,
      mintAuthorityScore: null,
      mintAuthorityScoreBand: "nr",
      mintAuthorityScoreLabel: "NR",
      mintAuthorityScoreBandLabel: "NR",
      mintAuthorityScoreBadgeClassName: "border-border/60 bg-muted/30 text-muted-foreground",
      mintAuthorityScoreDetail: "Mint Authority Score is not rated.",
    }),
  ];

  it("returns all rows when no filter is active", () => {
    expect(applyFilters(rows, SCREENER_FILTER_DEFAULTS)).toHaveLength(rows.length);
  });

  it("filters by DEWS max, excluding unrated rows", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, dewsMax: 40 };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id).sort()).toEqual(["dai-makerdao", "usdc-circle"]);
  });

  it("keeps zero scores when only a max DEWS threshold is active", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, dewsMax: 40 };
    const result = applyFilters(
      [
        makeRow({ id: "zero", dewsScore: 0 }),
        makeRow({ id: "inside", dewsScore: 20 }),
        makeRow({ id: "above-max", dewsScore: 41 }),
      ],
      filters,
    );

    expect(result.map((r) => r.id)).toEqual(["zero", "inside"]);
  });

  it("filters by safety grade", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, safetyGrades: ["A"] };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["usdc-circle"]);
  });

  it("filters by safety sub-dimension minimum", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, safetyDependencyRiskMin: 90 };
    const result = applyFilters(
      [
        makeRow({ id: "low-dependency", safetyDependencyRiskScore: 70 }),
        makeRow({ id: "high-dependency", safetyDependencyRiskScore: 95 }),
        makeRow({ id: "unrated-dependency", safetyDependencyRiskScore: null }),
      ],
      filters,
    );
    expect(result.map((r) => r.id)).toEqual(["high-dependency"]);
  });

  it("filters by supply min only when min > 0", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, supplyMin: 1_000_000_000 };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id).sort()).toEqual(["dai-makerdao", "usdc-circle"]);
  });

  it("filters by supply max only when max > 0", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, supplyMax: 1_000_000_000 };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id).sort()).toEqual(["eurs-stasis", "newcoin"]);
  });

  it("excludes rows exactly on active DEWS lower thresholds", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, dewsMin: 40, dewsMax: 100 };
    const result = applyFilters(
      [
        makeRow({ id: "below-min", dewsScore: 39 }),
        makeRow({ id: "at-min", dewsScore: 40 }),
        makeRow({ id: "inside", dewsScore: 75 }),
        makeRow({ id: "at-default-max", dewsScore: 100 }),
        makeRow({ id: "unrated", dewsScore: null }),
      ],
      filters,
    );

    expect(result.map((r) => r.id)).toEqual(["inside", "at-default-max"]);
  });

  it("excludes rows exactly on active supply lower thresholds", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, supplyMin: 100, supplyMax: 200 };
    const result = applyFilters(
      [
        makeRow({ id: "below-min", supplyUsd: 99 }),
        makeRow({ id: "at-min", supplyUsd: 100 }),
        makeRow({ id: "inside", supplyUsd: 150 }),
        makeRow({ id: "at-max", supplyUsd: 200 }),
        makeRow({ id: "above-max", supplyUsd: 201 }),
      ],
      filters,
    );

    expect(result.map((r) => r.id)).toEqual(["inside", "at-max"]);
  });

  it("filters by mechanism (multi-select)", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, mechanisms: ["cdp"] };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["dai-makerdao"]);
  });

  it("filters by type (multi-select)", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, types: ["decentralized"] };
    const result = applyFilters(
      [
        makeRow({ id: "cefi", type: "centralized" }),
        makeRow({ id: "cefi-dep", type: "centralized-dependent" }),
        makeRow({ id: "defi", type: "decentralized" }),
      ],
      filters,
    );
    expect(result.map((r) => r.id)).toEqual(["defi"]);
  });

  it("excludes rows with null mechanism when mechanism filter is active", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      mechanisms: ["cdp", "fiat-cash"],
    };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id).sort()).toEqual(["dai-makerdao", "eurs-stasis", "usdc-circle"]);
    expect(result.find((r) => r.id === "newcoin")).toBeUndefined();
  });

  it("filters by peg currency (multi-select)", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, pegs: ["EUR"] };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["eurs-stasis"]);
  });

  it("filters by lifecycle status", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, lifecycle: ["pre-launch"] };
    const result = applyFilters(rows, filters);
    expect(result.map((r) => r.id)).toEqual(["newcoin"]);
  });

  it("filters by Mint Authority Score minimum", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, mintAuthorityScoreMin: 80 };
    const result = applyFilters(
      [
        makeRow({ id: "low-mint-score", mintAuthorityScore: 40, mintAuthorityScoreBand: "concentrated" }),
        makeRow({ id: "high-mint-score", mintAuthorityScore: 85, mintAuthorityScoreBand: "hardened" }),
        makeRow({ id: "unrated-mint-score", mintAuthorityScore: null, mintAuthorityScoreBand: "nr" }),
      ],
      filters,
    );
    expect(result.map((r) => r.id)).toEqual(["high-mint-score"]);
  });

  it("filters by Mint Authority Score band", () => {
    const filters: ScreenerFilters = { ...SCREENER_FILTER_DEFAULTS, mintAuthorityScores: ["exposed", "nr"] };
    const result = applyFilters(
      [
        makeRow({ id: "governed", mintAuthorityScoreBand: "governed" }),
        makeRow({ id: "exposed", mintAuthorityScore: 10, mintAuthorityScoreBand: "exposed" }),
        makeRow({ id: "nr", mintAuthorityScore: null, mintAuthorityScoreBand: "nr" }),
      ],
      filters,
    );
    expect(result.map((r) => r.id).sort()).toEqual(["exposed", "nr"]);
  });

  it("retains unrated rows when score range is at defaults", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      pegs: ["USD"],
    };
    const result = applyFilters(rows, filters);
    // newcoin has no peg/dews/liquidity score but is still USD and active default
    // so it should pass the peg filter.
    expect(result.find((r) => r.id === "newcoin")).toBeDefined();
  });
});

describe("hasActiveFilters", () => {
  it("reports false for defaults", () => {
    expect(hasActiveFilters(SCREENER_FILTER_DEFAULTS)).toBe(false);
    expect(countActiveScreenerFilters(SCREENER_FILTER_DEFAULTS)).toBe(0);
  });

  it("reports true when any range or multi-select is narrowed", () => {
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, dewsMin: 50 })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, safetyGrades: ["A", "B+"] })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, types: ["decentralized"] })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, mechanisms: ["cdp"] })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, supplyMin: 1 })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, mintAuthority: ["multisig-mint"] })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, mintAuthorityScoreMin: 80 })).toBe(true);
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, mintAuthorityScores: ["hardened"] })).toBe(true);
  });

  it("counts active range groups once and selected pills individually", () => {
    expect(
      countActiveScreenerFilters({
        ...SCREENER_FILTER_DEFAULTS,
        dewsMin: 80,
        dewsMax: 95,
        supplyMax: 1_000_000_000,
        safetyGrades: ["A", "B+"],
        types: ["centralized", "decentralized"],
        pegs: ["USD"],
        mintAuthority: ["multisig-mint"],
      }),
    ).toBe(8);
  });
});

describe("sortScreenerRows", () => {
  const rows = [
    makeRow({ id: "low", symbol: "LOW", safetyScore: 60, pegScore: null }),
    makeRow({ id: "high", symbol: "HIGH", safetyScore: 95, pegScore: 95 }),
    makeRow({ id: "mid", symbol: "MID", safetyScore: 80, pegScore: 70 }),
  ];

  it("sorts the same row order used by table rendering and exports", () => {
    expect(sortScreenerRows(rows, "safetyScore", "desc").map((row) => row.id)).toEqual(["high", "mid", "low"]);
  });

  it("sorts by Mint Authority Score with unrated rows last", () => {
    const mintRows = [
      makeRow({ id: "nr", symbol: "NR", mintAuthorityScore: null, mintAuthorityScoreBand: "nr" }),
      makeRow({ id: "hardened", symbol: "HARD", mintAuthorityScore: 85, mintAuthorityScoreBand: "hardened" }),
      makeRow({ id: "managed", symbol: "MAN", mintAuthorityScore: 55, mintAuthorityScoreBand: "managed" }),
    ];
    expect(sortScreenerRows(mintRows, "mintAuthorityScore", "desc").map((row) => row.id)).toEqual([
      "hardened",
      "managed",
      "nr",
    ]);
  });

  it("keeps unrated score values at the bottom in either direction", () => {
    expect(sortScreenerRows(rows, "pegScore", "asc").map((row) => row.id)).toEqual(["mid", "high", "low"]);
    expect(sortScreenerRows(rows, "pegScore", "desc").map((row) => row.id)).toEqual(["high", "mid", "low"]);
  });
});

describe("hasLoadingScoreFilterData", () => {
  const loaded = {
    dewsLoading: false,
    dewsHasData: true,
    reportLoading: false,
    reportHasData: true,
  };

  it("keeps deep-linked score filters in loading state until their source data resolves", () => {
    expect(
      hasLoadingScoreFilterData(
        { ...SCREENER_FILTER_DEFAULTS, dewsMin: 80 },
        { ...loaded, dewsLoading: true, dewsHasData: false },
      ),
    ).toBe(true);
  });

  it("does not block unrelated score filter sources", () => {
    expect(
      hasLoadingScoreFilterData(
        { ...SCREENER_FILTER_DEFAULTS, safetyResilienceMin: 75 },
        { ...loaded, dewsLoading: true, dewsHasData: false },
      ),
    ).toBe(false);
  });

  it("keeps safety score filters in loading state until report cards resolve", () => {
    expect(
      hasLoadingScoreFilterData(
        { ...SCREENER_FILTER_DEFAULTS, safetyResilienceMin: 75 },
        { ...loaded, reportLoading: true, reportHasData: false },
      ),
    ).toBe(true);
  });
});

describe("SCREENER_URL_SCHEMA codec", () => {
  it("round-trips a non-default filter set", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      dewsMin: 20,
      dewsMax: 40,
      safetyGrades: ["A", "B+"],
      types: ["centralized", "decentralized"],
      mechanisms: ["cdp", "fiat-cash"],
      pegs: ["USD", "EUR"],
      mintAuthorityScoreMin: 65,
      mintAuthorityScores: ["hardened", "governed"],
    };
    const encoded = encodeState(filters, SCREENER_URL_SCHEMA);
    expect(encoded).toContain("dewsMin=20");
    expect(encoded).toContain("dewsMax=40");
    expect(encoded).toContain("safetyGrades=A%2CB%2B");
    expect(encoded).toContain("types=centralized%2Cdecentralized");
    expect(encoded).toContain("mechanisms=cdp%2Cfiat-cash");
    expect(encoded).toContain("mintAuthorityScoreMin=65");
    expect(encoded).toContain("mintAuthorityScores=hardened%2Cgoverned");
    const decoded = decodeState(encoded, SCREENER_URL_SCHEMA);
    expect(decoded.dewsMin).toBe(20);
    expect(decoded.dewsMax).toBe(40);
    expect(decoded.safetyGrades).toEqual(["A", "B+"]);
    expect(decoded.types).toEqual(["centralized", "decentralized"]);
    expect(decoded.mechanisms).toEqual(["cdp", "fiat-cash"]);
    expect(decoded.pegs).toEqual(["USD", "EUR"]);
    expect(decoded.mintAuthorityScoreMin).toBe(65);
    expect(decoded.mintAuthorityScores).toEqual(["hardened", "governed"]);
  });

  it("omits defaults from the encoded URL", () => {
    expect(encodeState(SCREENER_FILTER_DEFAULTS, SCREENER_URL_SCHEMA)).toBe("");
  });

  it("decodes an empty query string to defaults", () => {
    expect(decodeState("", SCREENER_URL_SCHEMA)).toEqual(SCREENER_FILTER_DEFAULTS);
  });

  it("clamps out-of-range numbers to defaults", () => {
    const decoded = decodeState("dewsMax=999&dewsMin=-5&supplyMin=-1", SCREENER_URL_SCHEMA);
    expect(decoded.dewsMax).toBe(SCREENER_FILTER_DEFAULTS.dewsMax);
    expect(decoded.dewsMin).toBe(SCREENER_FILTER_DEFAULTS.dewsMin);
    expect(decoded.supplyMin).toBe(SCREENER_FILTER_DEFAULTS.supplyMin);
  });

  it("drops unknown enum values from multi-selects", () => {
    const decoded = decodeState("mechanisms=cdp,unknown-archetype,fiat-cash", SCREENER_URL_SCHEMA);
    expect(decoded.mechanisms).toEqual(["cdp", "fiat-cash"]);
  });
});

describe("projectBlacklistable", () => {
  it("maps boolean true to 'yes'", () => {
    expect(projectBlacklistable(true)).toBe("yes");
  });
  it("maps boolean false to 'no'", () => {
    expect(projectBlacklistable(false)).toBe("no");
  });
  it("passes 'possible' through", () => {
    expect(projectBlacklistable("possible")).toBe("possible");
  });
  it("returns null for undefined (unspecified blacklistability)", () => {
    expect(projectBlacklistable(undefined)).toBeNull();
  });
});

describe("applyFilters — blacklistable", () => {
  const yesRow = makeRow({ id: "yes", blacklistable: "yes" });
  const noRow = makeRow({ id: "no", blacklistable: "no" });
  const possibleRow = makeRow({ id: "possible", blacklistable: "possible" });
  const unknownRow = makeRow({ id: "unknown", blacklistable: null });
  const allRows = [yesRow, noRow, possibleRow, unknownRow] as const;

  it("returns every row when the blacklistable filter is empty", () => {
    const filtered = applyFilters(allRows, SCREENER_FILTER_DEFAULTS);
    expect(filtered.map((r) => r.id)).toEqual(["yes", "no", "possible", "unknown"]);
  });

  it("keeps only rows whose blacklistable status matches the active filter", () => {
    const filtered = applyFilters(allRows, {
      ...SCREENER_FILTER_DEFAULTS,
      blacklistable: ["yes", "possible"],
    });
    expect(filtered.map((r) => r.id).sort()).toEqual(["possible", "yes"]);
  });

  it("excludes rows with unknown blacklistable status when the filter is active", () => {
    const filtered = applyFilters(allRows, {
      ...SCREENER_FILTER_DEFAULTS,
      blacklistable: ["yes"],
    });
    expect(filtered.some((r) => r.id === "unknown")).toBe(false);
  });

  it("hasActiveFilters returns true when the blacklistable filter is non-empty", () => {
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, blacklistable: ["yes"] })).toBe(true);
  });
});

describe("applyFilters — mint authority", () => {
  const issuerRow = makeRow({ id: "issuer", mintAuthority: "issuer-or-backend-mint" });
  const multisigRow = makeRow({ id: "multisig", mintAuthority: "multisig-mint" });
  const noPrivRow = makeRow({ id: "no-priv", mintAuthority: "no-privileged-mint" });
  const unknownRow = makeRow({ id: "unknown", mintAuthority: "unknown" });
  const allRows = [issuerRow, multisigRow, noPrivRow, unknownRow] as const;

  it("returns every row when the mint-authority filter is empty", () => {
    const filtered = applyFilters(allRows, SCREENER_FILTER_DEFAULTS);
    expect(filtered.map((r) => r.id)).toEqual(["issuer", "multisig", "no-priv", "unknown"]);
  });

  it("keeps only rows whose mint-authority bucket matches the active filter", () => {
    const filtered = applyFilters(allRows, {
      ...SCREENER_FILTER_DEFAULTS,
      mintAuthority: ["issuer-or-backend-mint", "multisig-mint"],
    });
    expect(filtered.map((r) => r.id).sort()).toEqual(["issuer", "multisig"]);
  });

  it("can filter for unknown mint-authority review gaps", () => {
    const filtered = applyFilters(allRows, {
      ...SCREENER_FILTER_DEFAULTS,
      mintAuthority: ["unknown"],
    });
    expect(filtered.map((r) => r.id)).toEqual(["unknown"]);
  });
});

describe("SCREENER_URL_SCHEMA — blacklistable round-trip", () => {
  it("encodes and decodes the blacklistable multi-select", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      blacklistable: ["yes", "possible"],
    };
    const encoded = encodeState(filters, SCREENER_URL_SCHEMA);
    expect(encoded).toContain("blacklistable=yes%2Cpossible");
    const decoded = decodeState(encoded, SCREENER_URL_SCHEMA);
    expect(decoded.blacklistable).toEqual(["yes", "possible"]);
  });

  it("drops unknown values from a blacklistable URL param", () => {
    const decoded = decodeState("blacklistable=yes,bogus,dilutable", SCREENER_URL_SCHEMA);
    expect(decoded.blacklistable).toEqual(["yes"]);
  });
});

describe("SCREENER_URL_SCHEMA — mint authority round-trip", () => {
  it("encodes and decodes the mint-authority multi-select", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      mintAuthority: ["issuer-or-backend-mint", "multisig-mint"],
    };
    const encoded = encodeState(filters, SCREENER_URL_SCHEMA);
    expect(encoded).toContain("mintAuthority=issuer-or-backend-mint%2Cmultisig-mint");
    const decoded = decodeState(encoded, SCREENER_URL_SCHEMA);
    expect(decoded.mintAuthority).toEqual(["issuer-or-backend-mint", "multisig-mint"]);
  });

  it("drops unknown mint-authority URL values outside the known bucket list", () => {
    const decoded = decodeState("mintAuthority=issuer-or-backend-mint,bogus", SCREENER_URL_SCHEMA);
    expect(decoded.mintAuthority).toEqual(["issuer-or-backend-mint"]);
  });

  it("encodes and decodes Mint Authority Score bands", () => {
    const filters: ScreenerFilters = {
      ...SCREENER_FILTER_DEFAULTS,
      mintAuthorityScores: ["hardened", "nr"],
    };
    const encoded = encodeState(filters, SCREENER_URL_SCHEMA);
    expect(encoded).toContain("mintAuthorityScores=hardened%2Cnr");
    const decoded = decodeState(encoded, SCREENER_URL_SCHEMA);
    expect(decoded.mintAuthorityScores).toEqual(["hardened", "nr"]);
  });
});

describe("projectMintAuthority", () => {
  it("maps missing summaries to unknown", () => {
    expect(projectMintAuthority(undefined)).toBe("unknown");
  });

  it("maps issuer direct mint summaries to the issuer/backend bucket", () => {
    expect(
      projectMintAuthority({
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        confidence: "verified",
        inheritedFrom: undefined,
        mintIncidents: [],
      }),
    ).toBe("issuer-or-backend-mint");
  });
});

describe("normalizeScreenerDeepLinkAliases", () => {
  it("rewrites `?mechanism=<slug>` to `mechanisms=<slug>` and pins lifecycle=active", () => {
    const params = new URLSearchParams("mechanism=cdp");
    const changed = normalizeScreenerDeepLinkAliases(params);
    expect(changed).toBe(true);
    expect(params.get("mechanism")).toBeNull();
    expect(params.get("mechanisms")).toBe("cdp");
    expect(params.get("lifecycle")).toBe("active");
  });

  it("supports the rwa-credit-fund archetype alias", () => {
    const params = new URLSearchParams("mechanism=rwa-credit-fund");
    normalizeScreenerDeepLinkAliases(params);
    expect(params.get("mechanisms")).toBe("rwa-credit-fund");
    expect(params.get("lifecycle")).toBe("active");
  });

  it("respects an explicit lifecycle override", () => {
    const params = new URLSearchParams("mechanism=cdp&lifecycle=pre-launch");
    normalizeScreenerDeepLinkAliases(params);
    expect(params.get("mechanisms")).toBe("cdp");
    expect(params.get("lifecycle")).toBe("pre-launch");
  });

  it("supports lifecycle=frozen deep-links", () => {
    const params = new URLSearchParams("mechanism=algorithmic&lifecycle=frozen");
    normalizeScreenerDeepLinkAliases(params);
    expect(params.get("mechanisms")).toBe("algorithmic");
    expect(params.get("lifecycle")).toBe("frozen");
  });

  it("strips an unknown mechanism alias without rewriting the plural key", () => {
    const params = new URLSearchParams("mechanism=bogus");
    const changed = normalizeScreenerDeepLinkAliases(params);
    expect(changed).toBe(true);
    expect(params.get("mechanism")).toBeNull();
    expect(params.get("mechanisms")).toBeNull();
    // No mechanism was matched, so lifecycle should still be pinned because
    // the deep-link alias was present (even if unknown).
    expect(params.get("lifecycle")).toBe("active");
  });

  it("leaves the canonical plural key alone when no alias is present", () => {
    const params = new URLSearchParams("mechanisms=cdp,fiat-cash");
    const changed = normalizeScreenerDeepLinkAliases(params);
    expect(changed).toBe(false);
    expect(params.get("mechanisms")).toBe("cdp,fiat-cash");
    expect(params.get("lifecycle")).toBeNull();
  });

  it("does not override an existing plural mechanisms param", () => {
    const params = new URLSearchParams("mechanism=cdp&mechanisms=tbill");
    normalizeScreenerDeepLinkAliases(params);
    expect(params.get("mechanisms")).toBe("tbill");
    expect(params.get("mechanism")).toBeNull();
  });
});
