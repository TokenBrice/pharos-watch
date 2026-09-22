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
} from "@/lib/screener-filters";
import { decodeState, encodeState } from "@/lib/url-state";
import { parsePaletteInput } from "@/lib/command-palette-verbs";

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
    safetyBackingScore: 92,
    safetyExitScore: 88,
    safetyControlScore: 84,
    safetyEvidence: "strong",
    safetyWeakestPillar: "control",
    safetyWeakestScore: 84,
    safetyBindingCapReason: null,
    custodyModel: "institutional-top",
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

const CORE_ROWS: ScreenerRow[] = [
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

const BLACKLISTABLE_ROWS: ScreenerRow[] = [
  makeRow({ id: "yes", blacklistable: "yes" }),
  makeRow({ id: "no", blacklistable: "no" }),
  makeRow({ id: "possible", blacklistable: "possible" }),
  makeRow({ id: "unknown", blacklistable: null }),
];

const MINT_AUTHORITY_ROWS: ScreenerRow[] = [
  makeRow({ id: "issuer", mintAuthority: "issuer-or-backend-mint" }),
  makeRow({ id: "multisig", mintAuthority: "multisig-mint" }),
  makeRow({ id: "no-priv", mintAuthority: "no-privileged-mint" }),
  makeRow({ id: "unknown", mintAuthority: "unknown" }),
];

describe("applyFilters", () => {
  it.each<{
    name: string;
    rows?: ScreenerRow[];
    filters: Partial<ScreenerFilters>;
    expected: string[];
  }>([
    {
      name: "returns all rows when no filter is active",
      filters: {},
      expected: ["usdc-circle", "dai-makerdao", "eurs-stasis", "newcoin"],
    },
    {
      name: "filters by DEWS max, excluding unrated rows",
      filters: { dewsMax: 40 },
      expected: ["usdc-circle", "dai-makerdao"],
    },
    {
      name: "keeps zero scores when only a max DEWS threshold is active",
      rows: [
        makeRow({ id: "zero", dewsScore: 0 }),
        makeRow({ id: "inside", dewsScore: 20 }),
        makeRow({ id: "above-max", dewsScore: 41 }),
      ],
      filters: { dewsMax: 40 },
      expected: ["zero", "inside"],
    },
    {
      name: "includes rows exactly on active DEWS lower thresholds",
      rows: [
        makeRow({ id: "below-min", dewsScore: 39 }),
        makeRow({ id: "at-min", dewsScore: 40 }),
        makeRow({ id: "inside", dewsScore: 75 }),
        makeRow({ id: "at-default-max", dewsScore: 100 }),
        makeRow({ id: "unrated", dewsScore: null }),
      ],
      filters: { dewsMin: 40, dewsMax: 100 },
      expected: ["at-min", "inside", "at-default-max"],
    },
    {
      name: "filters by safety grade",
      filters: { safetyGrades: ["A"] },
      expected: ["usdc-circle"],
    },
    {
      name: "filters by V9 safety pillar minimum",
      rows: [
        makeRow({ id: "low-control", safetyControlScore: 70 }),
        makeRow({ id: "high-control", safetyControlScore: 95 }),
        makeRow({ id: "unrated-control", safetyControlScore: null }),
      ],
      filters: { safetyControlMin: 90 },
      expected: ["high-control"],
    },
    {
      name: "filters by supply min only when min > 0",
      filters: { supplyMin: 1_000_000_000 },
      expected: ["usdc-circle", "dai-makerdao"],
    },
    {
      name: "filters by supply max only when max > 0",
      filters: { supplyMax: 1_000_000_000 },
      expected: ["eurs-stasis", "newcoin"],
    },
    {
      name: "includes rows exactly on active supply lower thresholds",
      rows: [
        makeRow({ id: "below-min", supplyUsd: 99 }),
        makeRow({ id: "at-min", supplyUsd: 100 }),
        makeRow({ id: "inside", supplyUsd: 150 }),
        makeRow({ id: "at-max", supplyUsd: 200 }),
        makeRow({ id: "above-max", supplyUsd: 201 }),
      ],
      filters: { supplyMin: 100, supplyMax: 200 },
      expected: ["at-min", "inside", "at-max"],
    },
    {
      name: "applies the Picker-compatible score, custody, and evidence filters inclusively",
      rows: [
        makeRow({ id: "usdc-circle", pegScore: 80, liquidityScore: 65, custodyModel: "institutional-top", safetyEvidence: "strong" }),
        makeRow({ id: "dai-makerdao", pegScore: 79, liquidityScore: 65, custodyModel: "onchain", safetyEvidence: "adequate" }),
      ],
      filters: {
        pegScoreMin: 80,
        liquidityScoreMin: 65,
        custodyModels: ["institutional-top"],
        safetyEvidence: ["strong"],
      },
      expected: ["usdc-circle"],
    },
    {
      name: "treats coins as exact Picker inspection mode even when broad filters diverge",
      rows: [
        makeRow({ id: "usdc-circle", pegScore: 10 }),
        makeRow({ id: "dai-makerdao", pegScore: 95 }),
      ],
      filters: { coins: ["usdc-circle"], pegScoreMin: 80 },
      expected: ["usdc-circle"],
    },
    {
      name: "filters by mechanism (multi-select)",
      filters: { mechanisms: ["cdp"] },
      expected: ["dai-makerdao"],
    },
    {
      name: "excludes rows with null mechanism when mechanism filter is active",
      filters: { mechanisms: ["cdp", "fiat-cash"] },
      expected: ["usdc-circle", "dai-makerdao", "eurs-stasis"],
    },
    {
      name: "filters by type (multi-select)",
      rows: [
        makeRow({ id: "cefi", type: "centralized" }),
        makeRow({ id: "cefi-dep", type: "centralized-dependent" }),
        makeRow({ id: "defi", type: "decentralized" }),
      ],
      filters: { types: ["decentralized"] },
      expected: ["defi"],
    },
    {
      name: "filters by peg currency (multi-select)",
      filters: { pegs: ["EUR"] },
      expected: ["eurs-stasis"],
    },
    {
      name: "retains unrated rows when only a non-score filter is active",
      filters: { pegs: ["USD"] },
      expected: ["usdc-circle", "dai-makerdao", "newcoin"],
    },
    {
      name: "filters by lifecycle status",
      filters: { lifecycle: ["pre-launch"] },
      expected: ["newcoin"],
    },
    {
      name: "filters by Mint Authority Score minimum",
      rows: [
        makeRow({ id: "low-mint-score", mintAuthorityScore: 40, mintAuthorityScoreBand: "concentrated" }),
        makeRow({ id: "high-mint-score", mintAuthorityScore: 85, mintAuthorityScoreBand: "hardened" }),
        makeRow({ id: "unrated-mint-score", mintAuthorityScore: null, mintAuthorityScoreBand: "nr" }),
      ],
      filters: { mintAuthorityScoreMin: 80 },
      expected: ["high-mint-score"],
    },
    {
      name: "filters by Mint Authority Score band",
      rows: [
        makeRow({ id: "governed", mintAuthorityScoreBand: "governed" }),
        makeRow({ id: "exposed", mintAuthorityScore: 10, mintAuthorityScoreBand: "exposed" }),
        makeRow({ id: "nr", mintAuthorityScore: null, mintAuthorityScoreBand: "nr" }),
      ],
      filters: { mintAuthorityScores: ["exposed", "nr"] },
      expected: ["exposed", "nr"],
    },
    {
      name: "returns every row when the blacklistable filter is empty",
      rows: BLACKLISTABLE_ROWS,
      filters: {},
      expected: ["yes", "no", "possible", "unknown"],
    },
    {
      name: "keeps only rows whose blacklistable status matches the active filter",
      rows: BLACKLISTABLE_ROWS,
      filters: { blacklistable: ["yes", "possible"] },
      expected: ["yes", "possible"],
    },
    {
      name: "excludes rows with unknown blacklistable status when the filter is active",
      rows: BLACKLISTABLE_ROWS,
      filters: { blacklistable: ["yes"] },
      expected: ["yes"],
    },
    {
      name: "keeps only rows whose mint-authority bucket matches the active filter",
      rows: MINT_AUTHORITY_ROWS,
      filters: { mintAuthority: ["issuer-or-backend-mint", "multisig-mint"] },
      expected: ["issuer", "multisig"],
    },
    {
      name: "can filter for unknown mint-authority review gaps",
      rows: MINT_AUTHORITY_ROWS,
      filters: { mintAuthority: ["unknown"] },
      expected: ["unknown"],
    },
  ])("$name", ({ rows = CORE_ROWS, filters, expected }) => {
    const result = applyFilters(rows, { ...SCREENER_FILTER_DEFAULTS, ...filters });
    expect(result.map((row) => row.id)).toEqual(expected);
  });

  it("applies the threshold the command palette's `screen safety>=N` deep link carries", () => {
    const parsed = parsePaletteInput("screen safety>=80");
    if (parsed.kind !== "screen") throw new Error("expected a screen verb");
    const filters = decodeState(parsed.href.split("?")[1] ?? "", SCREENER_URL_SCHEMA);
    const result = applyFilters(
      [
        makeRow({ id: "high", safetyScore: 90 }),
        makeRow({ id: "low", safetyScore: 42 }),
        makeRow({ id: "unrated", safetyScore: null }),
      ],
      filters,
    );
    expect(result.map((r) => r.id)).toEqual(["high"]);
  });
});

describe("hasActiveFilters", () => {
  it("reports false for defaults", () => {
    expect(hasActiveFilters(SCREENER_FILTER_DEFAULTS)).toBe(false);
    expect(countActiveScreenerFilters(SCREENER_FILTER_DEFAULTS)).toBe(0);
  });

  it.each<Partial<ScreenerFilters>>([
    { dewsMin: 50 },
    { safetyGrades: ["A", "B+"] },
    { types: ["decentralized"] },
    { mechanisms: ["cdp"] },
    { supplyMin: 1 },
    { mintAuthority: ["multisig-mint"] },
    { mintAuthorityScoreMin: 80 },
    { mintAuthorityScores: ["hardened"] },
    { coins: ["usdc-circle"] },
    { safetyEvidence: ["limited"] },
    { custodyModels: ["onchain"] },
    { blacklistable: ["yes"] },
  ])("reports true when %o narrows the default set", (patch) => {
    expect(hasActiveFilters({ ...SCREENER_FILTER_DEFAULTS, ...patch })).toBe(true);
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
  const dewsPending = { dewsLoading: true, dewsHasData: false };
  const reportPending = { reportLoading: true, reportHasData: false };

  // Since safety 9.1 the mint score and band are read from the published V9
  // mint component, so both mint filters depend on the report-cards query.
  // The curated route bucket is not re-sourced, so it must not gate on a query.
  it.each<{
    name: string;
    filters: Partial<ScreenerFilters>;
    state: Partial<typeof loaded>;
    expected: boolean;
  }>([
    { name: "deep-linked DEWS filters wait for the DEWS query", filters: { dewsMin: 80 }, state: dewsPending, expected: true },
    { name: "safety filters do not wait for the DEWS query", filters: { safetyExitMin: 75 }, state: dewsPending, expected: false },
    { name: "safety filters wait for report cards", filters: { safetyExitMin: 75 }, state: reportPending, expected: true },
    { name: "the mint score threshold waits for report cards", filters: { mintAuthorityScoreMin: 65 }, state: reportPending, expected: true },
    { name: "the mint band filter waits for report cards", filters: { mintAuthorityScores: ["hardened"] }, state: reportPending, expected: true },
    { name: "the mint band filter does not wait for the DEWS query", filters: { mintAuthorityScores: ["hardened"] }, state: dewsPending, expected: false },
    {
      name: "the mint filters release once report cards have data",
      filters: { mintAuthorityScoreMin: 65, mintAuthorityScores: ["hardened"] },
      state: { reportLoading: true, reportHasData: true },
      expected: false,
    },
    {
      name: "the curated mint route filter never waits on a query",
      filters: { mintAuthority: ["no-privileged-mint"] },
      state: reportPending,
      expected: false,
    },
  ])("$name", ({ filters, state, expected }) => {
    expect(
      hasLoadingScoreFilterData({ ...SCREENER_FILTER_DEFAULTS, ...filters }, { ...loaded, ...state }),
    ).toBe(expected);
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
      coins: ["usdc-circle"],
      safetyEvidence: ["strong", "nr"],
      custodyModels: ["onchain"],
      pegScoreMin: 80,
      liquidityScoreMin: 65,
    };
    const encoded = encodeState(filters, SCREENER_URL_SCHEMA);
    expect(encoded).toContain("dewsMin=20");
    expect(encoded).toContain("dewsMax=40");
    expect(encoded).toContain("safetyGrades=A%2CB%2B");
    expect(encoded).toContain("types=centralized%2Cdecentralized");
    expect(encoded).toContain("mechanisms=cdp%2Cfiat-cash");
    expect(encoded).toContain("mintAuthorityScoreMin=65");
    expect(encoded).toContain("mintAuthorityScores=hardened%2Cgoverned");
    expect(encoded).toContain("coins=usdc-circle");
    expect(encoded).toContain("safetyEvidence=strong%2Cnr");
    expect(encoded).toContain("custodyModels=onchain");
    expect(encoded).toContain("pegScoreMin=80");
    expect(encoded).toContain("liquidityScoreMin=65");
    const decoded = decodeState(encoded, SCREENER_URL_SCHEMA);
    expect(decoded.dewsMin).toBe(20);
    expect(decoded.dewsMax).toBe(40);
    expect(decoded.safetyGrades).toEqual(["A", "B+"]);
    expect(decoded.types).toEqual(["centralized", "decentralized"]);
    expect(decoded.mechanisms).toEqual(["cdp", "fiat-cash"]);
    expect(decoded.pegs).toEqual(["USD", "EUR"]);
    expect(decoded.mintAuthorityScoreMin).toBe(65);
    expect(decoded.mintAuthorityScores).toEqual(["hardened", "governed"]);
    expect(decoded.coins).toEqual(["usdc-circle"]);
    expect(decoded.safetyEvidence).toEqual(["strong", "nr"]);
    expect(decoded.custodyModels).toEqual(["onchain"]);
    expect(decoded.pegScoreMin).toBe(80);
    expect(decoded.liquidityScoreMin).toBe(65);
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

  it.each<{ key: "blacklistable" | "mintAuthority" | "mintAuthorityScores"; values: string[]; encoded: string }>([
    { key: "blacklistable", values: ["yes", "possible"], encoded: "blacklistable=yes%2Cpossible" },
    {
      key: "mintAuthority",
      values: ["issuer-or-backend-mint", "multisig-mint"],
      encoded: "mintAuthority=issuer-or-backend-mint%2Cmultisig-mint",
    },
    { key: "mintAuthorityScores", values: ["hardened", "nr"], encoded: "mintAuthorityScores=hardened%2Cnr" },
  ])("round-trips the $key multi-select", ({ key, values, encoded: expectedFragment }) => {
    const encoded = encodeState(
      { ...SCREENER_FILTER_DEFAULTS, [key]: values } as ScreenerFilters,
      SCREENER_URL_SCHEMA,
    );
    expect(encoded).toContain(expectedFragment);
    expect(decodeState(encoded, SCREENER_URL_SCHEMA)[key]).toEqual(values);
  });

  it.each<{ key: "mechanisms" | "blacklistable" | "mintAuthority"; query: string; expected: string[] }>([
    { key: "mechanisms", query: "mechanisms=cdp,unknown-archetype,fiat-cash", expected: ["cdp", "fiat-cash"] },
    { key: "blacklistable", query: "blacklistable=yes,bogus,dilutable", expected: ["yes"] },
    {
      key: "mintAuthority",
      query: "mintAuthority=issuer-or-backend-mint,bogus",
      expected: ["issuer-or-backend-mint"],
    },
  ])("drops unknown enum values from the $key multi-select", ({ key, query, expected }) => {
    expect(decodeState(query, SCREENER_URL_SCHEMA)[key]).toEqual(expected);
  });
});

describe("projectBlacklistable", () => {
  it.each<[boolean | "possible" | undefined, string | null]>([
    [true, "yes"],
    [false, "no"],
    ["possible", "possible"],
    [undefined, null],
  ])("maps %s to %s", (value, expected) => {
    expect(projectBlacklistable(value)).toBe(expected);
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
  it.each<{
    name: string;
    query: string;
    changed: boolean;
    mechanisms: string | null;
    lifecycle: string | null;
  }>([
    {
      name: "rewrites `?mechanism=<slug>` to `mechanisms=<slug>` and pins lifecycle=active",
      query: "mechanism=cdp",
      changed: true,
      mechanisms: "cdp",
      lifecycle: "active",
    },
    {
      name: "supports the rwa-credit-fund archetype alias",
      query: "mechanism=rwa-credit-fund",
      changed: true,
      mechanisms: "rwa-credit-fund",
      lifecycle: "active",
    },
    {
      name: "respects an explicit lifecycle override",
      query: "mechanism=cdp&lifecycle=pre-launch",
      changed: true,
      mechanisms: "cdp",
      lifecycle: "pre-launch",
    },
    {
      name: "supports lifecycle=frozen deep-links",
      query: "mechanism=algorithmic&lifecycle=frozen",
      changed: true,
      mechanisms: "algorithmic",
      lifecycle: "frozen",
    },
    {
      // No mechanism was matched, so lifecycle is still pinned because the
      // deep-link alias was present (even if unknown).
      name: "strips an unknown mechanism alias without rewriting the plural key",
      query: "mechanism=bogus",
      changed: true,
      mechanisms: null,
      lifecycle: "active",
    },
    {
      name: "leaves the canonical plural key alone when no alias is present",
      query: "mechanisms=cdp,fiat-cash",
      changed: false,
      mechanisms: "cdp,fiat-cash",
      lifecycle: null,
    },
    {
      name: "does not override an existing plural mechanisms param",
      query: "mechanism=cdp&mechanisms=tbill",
      changed: true,
      mechanisms: "tbill",
      lifecycle: "active",
    },
  ])("$name", ({ query, changed, mechanisms, lifecycle }) => {
    const params = new URLSearchParams(query);
    expect(normalizeScreenerDeepLinkAliases(params)).toBe(changed);
    expect(params.get("mechanism")).toBeNull();
    expect(params.get("mechanisms")).toBe(mechanisms);
    expect(params.get("lifecycle")).toBe(lifecycle);
  });
});
