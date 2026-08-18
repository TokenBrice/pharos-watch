import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "../../../types";
import { findCollateralProseReserveDriftFindings } from "../collateral-prose-reserve-drift";

interface CoinOverrides extends Partial<StablecoinMeta> {
  id: string;
  symbol: string;
}

function makeCoin(overrides: CoinOverrides): StablecoinMeta {
  return {
    name: overrides.id,
    flags: {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...overrides,
  } as StablecoinMeta;
}

const REVIEW = {
  reviewedAt: "2026-08-12",
  reviewer: "test",
  confidence: "verified",
  sources: [{ label: "test", url: "https://example.com" }],
  scope: "full-composition",
  compositionAsOf: "2026-08-12",
} as unknown as NonNullable<StablecoinMeta["reserveReview"]>;

function slice(name: string, coinId?: string): NonNullable<StablecoinMeta["reserves"]>[number] {
  return {
    name,
    pct: 100,
    risk: "low",
    ...(coinId ? { coinId } : {}),
  } as NonNullable<StablecoinMeta["reserves"]>[number];
}

const CATALOG = [
  makeCoin({ id: "usdc-circle", symbol: "USDC" }),
  makeCoin({ id: "ustb-superstate", symbol: "USTB" }),
  makeCoin({ id: "jtrsy-centrifuge", symbol: "JTRSY" }),
  makeCoin({ id: "ausd-agora", symbol: "AUSD" }),
  makeCoin({ id: "money-defi-money", symbol: "MONEY" }),
  makeCoin({ id: "cdp-enosys", symbol: "CDP" }),
];

describe("findCollateralProseReserveDriftFindings", () => {
  it("flags approval-derived prose as tier 1 and keeps 'U.S.' from chopping the clause", () => {
    const subject = makeCoin({
      id: "frxusd-frax",
      symbol: "FRXUSD",
      collateral:
        "Tokenized cash-equivalent reserves held by governance-approved enshrined custodians: " +
        "Superstate USTB (T-bills), Centrifuge JTRSY (T-bills), Agora AUSD, and Circle USDC; " +
        "each custodian mints and redeems 1:1 against reserves they hold on-chain",
      reserves: [slice("USTB (Superstate tokenized T-bills)", "ustb-superstate")],
      reserveReview: REVIEW,
    });

    const findings = findCollateralProseReserveDriftFindings([...CATALOG, subject]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      coinId: "frxusd-frax",
      tier: 1,
      severity: "warning",
      absentReferences: ["AUSD", "JTRSY", "USDC"],
    });
    // The whole custodian list must survive inside one clause; splitting on the
    // period in "U.S." is exactly how this defect stayed invisible.
    expect(findings[0]?.modalClause).toContain("Circle USDC");
  });

  it("keeps the 'U.S.' guard honest when the abbreviation precedes the ticker list", () => {
    const subject = makeCoin({
      id: "usn-noon",
      symbol: "USN",
      collateral: "Backed by approved reserves in short-term U.S. Treasury bills and USDC held at custodians.",
      reserves: [slice("Private credit")],
      reserveReview: REVIEW,
    });

    const findings = findCollateralProseReserveDriftFindings([...CATALOG, subject]);
    expect(findings[0]).toMatchObject({ tier: 1, absentReferences: ["USDC"] });
  });

  it("clears the warning once the prose discloses that the approved asset is not held", () => {
    // The corrected form of the frxUSD defect must not keep warning, otherwise
    // the report is unactionable: a curator can never make it go quiet.
    const corrected = makeCoin({
      id: "frxusd-frax",
      symbol: "FRXUSD",
      collateral:
        "Reserves observed in the balance sheet are Superstate USTB and WisdomTree WTGXX; " +
        "governance has additionally approved AUSD and JTRSY as custodian assets, " +
        "but no balances have been observed for them.",
      reserves: [slice("USTB (Superstate tokenized T-bills)", "ustb-superstate")],
      reserveReview: REVIEW,
    });

    expect(findCollateralProseReserveDriftFindings([...CATALOG, corrected])[0]).toMatchObject({ tier: 2 });
  });

  it("treats a negation and an explicit inactive-eligibility note as non-defects", () => {
    const negated = makeCoin({
      id: "hbusdt-hyperbeat",
      symbol: "HBUSDT",
      collateral: "Deposits enter a dynamic strategy allocation. Direct USDC is not an accepted deposit asset.",
      reserves: [slice("Dynamic strategy portfolio")],
      reserveReview: REVIEW,
    });
    const inactive = makeCoin({
      id: "msusd-metronome",
      symbol: "MSUSD",
      collateral: "ETH and WBTC vault collateral; USDC accepted but currently inactive.",
      reserves: [slice("Eligible CDP collateral basket")],
      reserveReview: REVIEW,
    });

    for (const coin of [negated, inactive]) {
      expect(findCollateralProseReserveDriftFindings([...CATALOG, coin])[0]).toMatchObject({ tier: 2 });
    }
  });

  it("downgrades an absent ticker with no eligibility modality to tier 2", () => {
    const subject = makeCoin({
      id: "wrapper-coin",
      symbol: "WRAP",
      collateral: "A single wrapper slice whose look-through constituent is USDC.",
      reserves: [slice("USDtb (Ethena)")],
      reserveReview: REVIEW,
    });

    const findings = findCollateralProseReserveDriftFindings([...CATALOG, subject]);
    expect(findings[0]).toMatchObject({ tier: 2, severity: "info", modalClause: null });
  });

  it("does not flag a ticker that a reviewed slice name, obligor, or coinId already carries", () => {
    const subject = makeCoin({
      id: "clean-coin",
      symbol: "CLEAN",
      collateral: "Approved reserves in USDC and USTB.",
      reserves: [slice("USDC cash-equivalent", "usdc-circle"), slice("Superstate USTB")],
      reserveReview: REVIEW,
    });

    expect(findCollateralProseReserveDriftFindings([...CATALOG, subject])).toHaveLength(0);
  });

  it("skips coins with no reviewed composition, so an unreviewed coin cannot produce noise", () => {
    const subject = makeCoin({
      id: "unreviewed-coin",
      symbol: "UNRV",
      collateral: "Approved reserves in USDC.",
    });

    expect(findCollateralProseReserveDriftFindings([...CATALOG, subject])).toHaveLength(0);
  });

  it("ignores lower-case English words that collide with tracked symbols", () => {
    const subject = makeCoin({
      id: "prose-coin",
      symbol: "PROSE",
      collateral: "Approved collateral is real money held in a vault, not a token.",
      reserves: [slice("Bank deposits")],
      reserveReview: REVIEW,
    });

    expect(findCollateralProseReserveDriftFindings([...CATALOG, subject])).toHaveLength(0);
  });

  it("suppresses CDP, a tracked symbol that is also the generic noun in CDP prose", () => {
    const subject = makeCoin({
      id: "cdp-prose-coin",
      symbol: "CDPP",
      collateral: "MakerDAO-style CDP vaults using approved crypto collateral.",
      reserves: [slice("ETH vault collateral")],
      reserveReview: REVIEW,
    });

    expect(findCollateralProseReserveDriftFindings([...CATALOG, subject])).toHaveLength(0);
  });

  it("never reports the coin's own symbol", () => {
    const subject = makeCoin({
      id: "usdc-circle",
      symbol: "USDC",
      collateral: "Approved USDC reserves held in cash and T-bills.",
      reserves: [slice("Cash and T-bills")],
      reserveReview: REVIEW,
    });

    expect(findCollateralProseReserveDriftFindings([subject])).toHaveLength(0);
  });
});
