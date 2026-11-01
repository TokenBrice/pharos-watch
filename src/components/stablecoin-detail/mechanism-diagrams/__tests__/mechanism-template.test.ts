import { describe, expect, it } from "vitest";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { MechanismArchetype } from "@shared/types";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { buildMechanismBackingView, type MechanismBackingView } from "@/lib/mechanism-backing";
import { buildStablecoinDetailClientCoin } from "@/lib/stablecoin-detail-client-coin";
import { getCoinOverride } from "../coin-overrides";
import {
  deriveLiquidationEngine,
  resolveMechanismFlowTemplate,
  type MechanismFlowTemplate,
} from "../mechanism-template";
import { resolveThreeStepConfig } from "../three-step-archetype-diagram";
import type { MechanismTemplateFacts } from "../types";

/** Every line a template can put on the page or in its accessible name. */
function templateCopy(template: MechanismFlowTemplate): string {
  return [
    template.ariaLabel,
    template.description,
    template.stressFootnote ?? "",
    template.loop?.label ?? "",
    ...template.steps.flatMap((step) => [step.label, step.subtitle ?? ""]),
  ].join("\n");
}

/** A positive liquidation claim ("liquidates", "or liquidated", the collateral cascade), not a statement that none exists. */
const LIQUIDATION_CLAIM = /\bliquidat(?:e|es|ed)\b|collateral cascade/i;

const RULED_OUT: Pick<MechanismBackingView, "notes"> = {
  notes: [
    {
      key: "component:liquidationMechanics",
      label: "Liquidation mechanics",
      state: "not-applicable",
      rationale: "Reserve design with no borrower positions.",
      sourceUrl: null,
    },
  ],
};

/** The card's own resolution path (coin override included), run against the shipped coin data. */
function shippedTemplate(id: string): MechanismFlowTemplate {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin) throw new Error(`untracked fixture coin ${id}`);
  const archetype = resolveMechanismArchetype(coin, TRACKED_META_BY_ID);
  if (!archetype) throw new Error(`fixture coin ${id} has no archetype`);
  return resolveMechanismFlowTemplate(
    archetype,
    coin.symbol,
    {
      navToken: coin.flags.navToken === true,
      liquidationEngine: deriveLiquidationEngine(
        buildMechanismBackingView(id),
        buildStablecoinDetailClientCoin(coin).oracleRiskSummary?.role,
      ),
      backing: coin.flags.backing,
    },
    getCoinOverride(id),
  );
}

const TRACKED_SYMBOLS = new Set(Array.from(TRACKED_META_BY_ID.values(), (coin) => coin.symbol));

/** Tracked coin symbols a stress line names, other than `ownSymbol`. */
function namedCoins(stressFootnote: string | null, ownSymbol: string): string[] {
  return (stressFootnote ?? "")
    .split(/[^A-Za-z0-9.]+/)
    .filter((word) => word !== ownSymbol && TRACKED_SYMBOLS.has(word));
}

describe("resolveMechanismFlowTemplate", () => {
  it("draws no liquidation path for a cdp coin whose review rules one out", () => {
    const template = resolveMechanismFlowTemplate("cdp", "ZSD", { liquidationEngine: false });
    expect(templateCopy(template)).not.toMatch(LIQUIDATION_CLAIM);
    expect(template.loop?.danger ?? false).toBe(false);
  });

  it("keeps the archetype's liquidation path while the fact is unknown", () => {
    for (const facts of [{}, { liquidationEngine: null }] satisfies MechanismTemplateFacts[]) {
      const template = resolveMechanismFlowTemplate("cdp", "DAI", facts);
      expect(templateCopy(template)).toMatch(LIQUIDATION_CLAIM);
      expect(template.loop?.danger).toBe(true);
    }
  });

  it("never gives a shared-reserve coin liquidation copy", () => {
    for (const facts of [{}, { liquidationEngine: null }, { liquidationEngine: false }] satisfies MechanismTemplateFacts[]) {
      expect(templateCopy(resolveMechanismFlowTemplate("shared-reserve", "AUDm", facts))).not.toMatch(LIQUIDATION_CLAIM);
    }
  });

  it("asserts no fixed redemption cadence for any archetype on a coin page", () => {
    for (const archetype of MECHANISM_ARCHETYPE_VALUES as readonly MechanismArchetype[]) {
      expect(templateCopy(resolveMechanismFlowTemplate(archetype, "STBL", {}))).not.toMatch(/\b(?:weekly|monthly|quarterly)\b/i);
    }
  });

  it("splits tbill on the coin's NAV flag: only par tokens draw a redemption loop", () => {
    expect(resolveMechanismFlowTemplate("tbill", "OUSG", { navToken: true }).loop).toBeNull();
    expect(resolveMechanismFlowTemplate("tbill", "GUSD", { navToken: false }).loop).not.toBeNull();
  });

  it("draws neutral synthetic copy unless the coin override names a strategy", () => {
    const neutral = resolveMechanismFlowTemplate("synthetic-delta-neutral", "USDe", {});
    const perp = resolveMechanismFlowTemplate("synthetic-delta-neutral", "USDe", {}, {
      syntheticStrategy: "perp-short",
    });
    const lending = resolveMechanismFlowTemplate("synthetic-delta-neutral", "ftUSD", {}, {
      syntheticStrategy: "borrow-stake",
      steps: [{}, {}, { label: "ftUSD base token" }],
    });
    expect(templateCopy(neutral)).not.toMatch(/perp|funding|yield|payout/i);
    expect(neutral.loop).toBeNull();
    expect(templateCopy(perp)).toMatch(/perp/i);
    expect(templateCopy(perp)).not.toMatch(/yield on|holders/i);
    expect(templateCopy(lending)).not.toMatch(/perp/i);
    expect(lending.steps[2].label).toBe("ftUSD base token");
    expect(lending.steps[0].label).toBe(resolveMechanismFlowTemplate("synthetic-delta-neutral", "X", {}, {
      syntheticStrategy: "borrow-stake",
    }).steps[0].label);
  });

  it("gives algorithmic coins a coin-level config without the UST claims", () => {
    const template = resolveMechanismFlowTemplate("algorithmic", "LVUSD", {});
    expect(templateCopy(template)).not.toMatch(/governance token|no 1:1|reflexive collapse/i);
    expect(template.loop).toEqual(expect.objectContaining({ label: "arbitrage", danger: false }));
    expect(template.fragile).toBe(false);
    // `/learn` keeps the family copy and its dated precedent.
    const family = resolveThreeStepConfig("algorithmic");
    expect(family.stressFootnote).toBe("stress: reflexive collapse");
    expect(family.returnArrow?.label).toBe("reflexive collapse");
  });

  it("withholds the bank rail from crypto-backed fiat-cash coins only", () => {
    const crypto = resolveMechanismFlowTemplate("fiat-cash", "yoUSD", { backing: "crypto-backed" });
    const rwa = resolveMechanismFlowTemplate("fiat-cash", "USDC", { backing: "rwa-backed" });
    expect(templateCopy(crypto)).not.toMatch(/bank transfer|KYC|custod|1:1|redeem|banking-rail/i);
    expect(crypto.loop).toBeNull();
    expect(templateCopy(rwa)).toMatch(/bank transfer/i);
    expect(rwa.loop).not.toBeNull();
  });
});

describe("deriveLiquidationEngine", () => {
  it("rules liquidation out only when the mechanism and oracle reviews agree", () => {
    expect(deriveLiquidationEngine(RULED_OUT, "coin-price-feed")).toBe(false);
    // A "no dedicated pool" ruling with a collateral-pricing oracle (GHO-style)
    // still has external liquidators clearing positions.
    expect(deriveLiquidationEngine(RULED_OUT, "collateral-pricing")).toBeNull();
    expect(deriveLiquidationEngine(RULED_OUT, null)).toBeNull();
    expect(deriveLiquidationEngine({ notes: [] }, "coin-price-feed")).toBeNull();
    expect(deriveLiquidationEngine(null, "coin-price-feed")).toBeNull();
  });

  it("treats an evidence gap as unknown, not as no engine", () => {
    const gap = { notes: [{ ...RULED_OUT.notes[0], state: "unavailable" as const }] };
    expect(deriveLiquidationEngine(gap, "coin-price-feed")).toBeNull();
  });
});

describe("shipped coins (dossier audit 2026-10-06, defect 6)", () => {
  it("does not borrow USDC's banking-rail incident for USDT (QA 2026-10-06)", () => {
    expect(namedCoins(shippedTemplate("usdt-tether").stressFootnote, "USDT")).toEqual([]);
  });

  it("keeps a coin's own dated incident from its override", () => {
    expect(shippedTemplate("usdc-circle").stressFootnote).toMatch(/\bUSDC\b/);
    expect(shippedTemplate("dai-makerdao").stressFootnote).toMatch(/\bDAI\b/);
  });

  it("routes USDe's carry to sUSDe stakers in the override", () => {
    const usde = shippedTemplate("usde-ethena");
    expect(usde.steps[2].subtitle).toBe("yield to sUSDe stakers");
    expect(usde.ariaLabel).toContain("sUSDe stakers");
    expect(usde.description).toContain("sUSDe stakers");
  });

  it("keeps the bank rail on rwa-backed fiat-cash coins only", () => {
    expect(templateCopy(shippedTemplate("usdc-circle"))).toMatch(/bank transfer/i);
    expect(templateCopy(shippedTemplate("xdai-gnosis"))).not.toMatch(
      /bank transfer|KYC|custod|1:1|redeem|banking-rail/i,
    );
  });
});

describe("wrapper-inherited overrides (visual review 2026-10-27)", () => {
  // Measured at 1440px, a 4-column wrapper step has ~138px for copy: 18 label or 24 subtitle characters fit one line.
  const LABEL_MAX = 18;
  const SUBTITLE_MAX = 24;
  const parents = new Set([...TRACKED_META_BY_ID.values()].map((meta) => meta.variantOf).filter(Boolean));

  it.each([...parents].filter((id) => getCoinOverride(id!)).map((id) => [id!]))(
    "keeps %s overrides inside one line of the narrow wrapper step",
    (parentId) => {
      for (const step of getCoinOverride(parentId)!.steps ?? []) {
        if (step.label) expect(step.label.length, step.label).toBeLessThanOrEqual(LABEL_MAX);
        if (step.subtitle) expect(step.subtitle.length, step.subtitle).toBeLessThanOrEqual(SUBTITLE_MAX);
      }
    },
  );
});
