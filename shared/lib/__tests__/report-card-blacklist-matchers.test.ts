import { describe, it, expect } from "vitest";
import {
  getBlacklistStatusLabel,
  getReserveBlacklistabilityExposurePct,
  isBlacklistable,
  enrichLiveSlicesForBlacklist,
  resolveBlacklistStatuses,
} from "../report-cards";

describe("isBlacklistable", () => {
  it("returns true for centralized governance", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      canBeBlacklisted: undefined,
    };
    expect(isBlacklistable(meta as never)).toBe(true);
  });

  it("respects explicit override", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      canBeBlacklisted: false,
    };
    expect(isBlacklistable(meta as never)).toBe(false);
  });

  it("returns possible when an explicit override marks the coin as mutable", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: "possible" as const,
    };
    expect(isBlacklistable(meta as never)).toBe("possible");
  });

  it("returns inherited for reserve exposure even when governance is centralized-dependent", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [{ name: "Wrapped BTC", pct: 60, risk: "medium", blacklistable: true }],
    };
    expect(isBlacklistable(meta as never, new Set(["usdc-circle"]))).toBe("inherited");
  });

  it("requires majority support before a curated upstream review resolves upstream", () => {
    const meta = {
      flags: { governance: "centralized" as const },
      canBeBlacklisted: undefined,
      blacklistabilityReview: {
        reviewedStatus: "inherited" as const,
        sourceFreeRationale: "fixture",
        evidence: "fixture upstream rail",
        reviewer: "fixture",
        reviewedAt: "2026-05-25",
      },
    };
    expect(isBlacklistable(meta as never)).toBe(false);
  });

  it("does not return inherited for direct reserve exposure below the majority threshold", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "USDC buffer", pct: 35, risk: "low" },
        { name: "ETH", pct: 65, risk: "very-low" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe(false);
  });

  it("requires strictly more than half of reserves to carry upstream exposure", () => {
    const exactHalf = [
      { name: "USDC buffer", pct: 50, risk: "low" as const },
      { name: "ETH", pct: 50, risk: "very-low" as const },
    ];
    const majority = [
      { name: "USDC buffer", pct: 40, risk: "low" as const },
      { name: "RWA sleeve", pct: 10.1, risk: "medium" as const, blacklistabilityExposure: "upstream" as const },
      { name: "ETH", pct: 49.9, risk: "very-low" as const },
    ];
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
    };

    expect(getReserveBlacklistabilityExposurePct(exactHalf)).toBe(50);
    expect(isBlacklistable({ ...meta, reserves: exactHalf } as never)).toBe(false);
    expect(getReserveBlacklistabilityExposurePct(majority)).toBe(50.1);
    expect(isBlacklistable({ ...meta, reserves: majority } as never)).toBe("inherited");
  });

  it("returns inherited for cex-backed reserve rails even without explicit reserve annotations", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      custodyModel: "cex" as const,
      reserves: [
        { name: "Short perp margin (Copper/Ceffu off-exchange)", pct: 20, risk: "high" },
        { name: "JLP basket", pct: 80, risk: "high" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns inherited when most reserves sit in named stablecoin baskets", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "JLP (Jupiter Perps LP: BTC, ETH, SOL, USDC basket)", pct: 80, risk: "high" },
        { name: "Short perp margin", pct: 20, risk: "high" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns inherited for stablecoin plus custodial wrapper collateral", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "FBTC (tokenized BTC via Cobo custody)", pct: 45, risk: "medium" },
        { name: "USDT (1:1 minted deposits)", pct: 40, risk: "low" },
        { name: "BTC LSTs", pct: 15, risk: "high" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns inherited for custodied BTC wrappers and issuer-seizable tokenized collateral", () => {
    const meta = {
      flags: { governance: "decentralized" as const },
      canBeBlacklisted: undefined,
      reserves: [
        { name: "BOSS (Boss Info AG)", pct: 38, risk: "very-high" },
        { name: "cbBTC (Coinbase Wrapped BTC)", pct: 18, risk: "medium" },
        { name: "WBTC (Wrapped BTC)", pct: 15, risk: "medium" },
        { name: "ETH / wstETH", pct: 29, risk: "low" },
      ],
    };
    expect(isBlacklistable(meta as never)).toBe("inherited");
  });

  it("returns false for centralized-dependent governance without explicit, reserve, or custody risk", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [{ name: "ETH", pct: 100, risk: "very-low" }],
    };
    expect(isBlacklistable(meta as never)).toBe(false);
  });
});

describe("enrichLiveSlicesForBlacklist", () => {
  function metaStub(id: string, symbol: string) {
    return { id, symbol } as never;
  }

  const blacklistableIds = new Set(["usdc-circle", "usde-ethena", "crvusd-curve"]);
  const trackedMetaById = new Map([
    ["usdc-circle", metaStub("usdc-circle", "USDC")],
    ["usde-ethena", metaStub("usde-ethena", "USDe")],
    ["crvusd-curve", metaStub("crvusd-curve", "crvUSD")],
    ["xy-coin", metaStub("xy-coin", "XY")], // 2-char symbol, should be skipped
  ]);

  it("tags slice when name contains a blacklistable symbol", () => {
    const live = [{ name: "Stablecoin collateral (sUSDe, sUSDS, crvUSD)", pct: 96.6, risk: "low" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("tags slice when coinId points to blacklistable coin", () => {
    const live = [{ name: "stataUSDC GSM", pct: 25, risk: "low" as const, coinId: "usdc-circle" }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("tags live slice when the reserve name contains direct stablecoin basket clues", () => {
    const live = [{ name: "JLP (Jupiter Perps LP: BTC, ETH, SOL, USDC basket)", pct: 80, risk: "high" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("tags live slice when the reserve name contains a centralized-custody BTC wrapper symbol", () => {
    const live = [{ name: "cbBTC (Coinbase Wrapped BTC)", pct: 55, risk: "medium" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("tags live slice when the reserve name contains an issuer-seizable tokenized security symbol", () => {
    const live = [{ name: "BOSS (Boss Info AG)", pct: 38, risk: "very-high" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBe(true);
  });

  it("does not tag slice without blacklistable symbols", () => {
    const live = [{ name: "ETH / wstETH", pct: 34, risk: "low" as const }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0].blacklistable).toBeUndefined();
  });

  it("returns already-annotated slices unchanged", () => {
    const live = [{ name: "Some reserves", pct: 50, risk: "low" as const, blacklistable: true }];
    const result = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(result[0]).toBe(live[0]); // same reference, no copy
  });

  it("skips symbols shorter than 3 characters", () => {
    const idsWithShort = new Set([...blacklistableIds, "xy-coin"]);
    const live = [{ name: "XY token pool", pct: 80, risk: "low" as const }];
    const result = enrichLiveSlicesForBlacklist(live, idsWithShort, trackedMetaById);
    expect(result[0].blacklistable).toBeUndefined();
  });

  it("enables inherited detection when combined with isBlacklistable", () => {
    const meta = {
      flags: { governance: "centralized-dependent" as const },
      canBeBlacklisted: undefined,
      reserves: [{ name: "sUSDe", pct: 15, risk: "medium", coinId: "usde-ethena" }],
    };
    const live = [
      { name: "Stablecoin collateral (sUSDe, sUSDS, crvUSD)", pct: 96.6, risk: "low" as const },
      { name: "ETH / Liquid staking", pct: 3.4, risk: "low" as const },
    ];
    const enriched = enrichLiveSlicesForBlacklist(live, blacklistableIds, trackedMetaById);
    expect(isBlacklistable(meta as never, blacklistableIds, enriched)).toBe("inherited");
  });
});

describe("resolveBlacklistStatuses variant inheritance", () => {
  it("inherits a blacklistable parent as upstream on a tracked variant", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "centralized" as const },
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "savings-passthrough" as const,
        pegReferenceId: "parent",
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);
    expect(resolved.get("parent")).toBe(true);
    expect(resolved.get("child")).toBe("inherited");
  });

  it("propagates a possible parent status to a tracked variant", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "centralized-dependent" as const },
        canBeBlacklisted: "possible" as const,
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "savings-passthrough" as const,
        pegReferenceId: "parent",
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);
    expect(resolved.get("parent")).toBe("possible");
    expect(resolved.get("child")).toBe("inherited");
  });

  it("uses the parent's live reserves when resolving variant inheritance", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "centralized-dependent" as const },
        reserves: [{ name: "ETH", pct: 100, risk: "very-low" as const }],
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "savings-passthrough" as const,
        pegReferenceId: "parent",
        reserves: [{ name: "ETH", pct: 100, risk: "very-low" as const }],
      },
    ];
    const reserveSlicesById = new Map([
      ["parent", [{ name: "DAI reserves", pct: 100, risk: "low" as const }]],
      ["child", [{ name: "ETH", pct: 100, risk: "very-low" as const }]],
    ]);

    const resolved = resolveBlacklistStatuses(metas as never, { reserveSlicesById });

    expect(resolved.get("parent")).toBe("inherited");
    expect(resolved.get("child")).toBe("inherited");
  });

  it("does not coerce a variant to inherited when the parent is not blacklistable", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "decentralized" as const },
        canBeBlacklisted: false as const,
        reserves: [{ name: "ETH", pct: 100, risk: "very-low" as const }],
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "savings-passthrough" as const,
        pegReferenceId: "parent",
        reserves: [{ name: "Parent", pct: 100, risk: "low" as const, coinId: "parent" }],
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);
    expect(resolved.get("parent")).toBe(false);
    expect(resolved.get("child")).toBe(false);
  });

  it("keeps an explicit override on the variant even when the parent is blacklistable", () => {
    const metas = [
      {
        id: "parent",
        name: "Parent",
        symbol: "PAR",
        flags: { governance: "centralized" as const },
      },
      {
        id: "child",
        name: "Child",
        symbol: "CHD",
        flags: { governance: "centralized-dependent" as const, navToken: true },
        variantOf: "parent",
        variantKind: "risk-absorption" as const,
        pegReferenceId: "parent",
        canBeBlacklisted: true as const,
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);
    expect(resolved.get("child")).toBe(true);
  });
});

describe("resolveBlacklistStatuses", () => {
  it("resolves cyclic inherited exposure to a fixed point", () => {
    const metas = [
      {
        id: "a",
        name: "A",
        symbol: "A",
        flags: { governance: "decentralized" as const },
        reserves: [
          { name: "USDC", pct: 60, risk: "low" as const },
          { name: "B", pct: 40, risk: "low" as const, coinId: "b" },
        ],
      },
      {
        id: "b",
        name: "B",
        symbol: "B",
        flags: { governance: "decentralized" as const },
        reserves: [
          { name: "A", pct: 80, risk: "low" as const, coinId: "a" },
          { name: "ETH", pct: 20, risk: "very-low" as const },
        ],
      },
    ];

    const resolved = resolveBlacklistStatuses(metas as never);

    expect(resolved.get("a")).toBe("inherited");
    expect(resolved.get("b")).toBe("inherited");
  });
});

describe("getBlacklistStatusLabel", () => {
  it("formats inherited as Upstream", () => {
    expect(getBlacklistStatusLabel("inherited")).toBe("Upstream");
  });

  it("formats explicit false as No", () => {
    expect(getBlacklistStatusLabel(false)).toBe("No");
  });
});
