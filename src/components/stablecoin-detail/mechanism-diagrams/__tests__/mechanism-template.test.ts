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

  it("follows the coin override's synthetic strategy and step replacements", () => {
    const perp = resolveMechanismFlowTemplate("synthetic-delta-neutral", "USDe", {});
    const lending = resolveMechanismFlowTemplate("synthetic-delta-neutral", "ftUSD", {}, {
      syntheticStrategy: "borrow-stake",
      steps: [{}, {}, { label: "ftUSD base token" }],
    });
    expect(templateCopy(perp)).toMatch(/perp/i);
    expect(templateCopy(lending)).not.toMatch(/perp/i);
    expect(lending.steps[2].label).toBe("ftUSD base token");
    expect(lending.steps[0].label).toBe(resolveMechanismFlowTemplate("synthetic-delta-neutral", "X", {}, {
      syntheticStrategy: "borrow-stake",
    }).steps[0].label);
  });

  it("drops the stress line when an override blanks it", () => {
    expect(resolveMechanismFlowTemplate("fiat-cash", "USDC", {}, { stressFootnote: "" }).stressFootnote).toBeNull();
  });

  it("names no coin in any archetype's coin-page stress line", () => {
    const variants = [{}, { navToken: true }, { navToken: false }, { liquidationEngine: false }] satisfies MechanismTemplateFacts[];
    for (const archetype of MECHANISM_ARCHETYPE_VALUES as readonly MechanismArchetype[]) {
      for (const facts of variants) {
        const template = resolveMechanismFlowTemplate(archetype, "FXD", facts);
        expect(namedCoins(template.stressFootnote, "FXD"), `${archetype} ${JSON.stringify(facts)}`).toEqual([]);
      }
    }
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
  it("draws ZSD's Djed reserve without the CDP liquidation path", () => {
    expect(templateCopy(shippedTemplate("zsd-zephyr-protocol"))).not.toMatch(LIQUIDATION_CLAIM);
  });

  it("keeps DAI's liquidation path", () => {
    expect(templateCopy(shippedTemplate("dai-makerdao"))).toMatch(LIQUIDATION_CLAIM);
  });

  it("does not give syrupUSDC a quarterly redemption gate", () => {
    expect(templateCopy(shippedTemplate("syrupusdc-maple"))).not.toMatch(/quarterly/i);
  });

  it("does not borrow USDC's banking-rail incident for USDT (QA 2026-10-06)", () => {
    expect(namedCoins(shippedTemplate("usdt-tether").stressFootnote, "USDT")).toEqual([]);
  });

  it("keeps a coin's own dated incident from its override", () => {
    expect(shippedTemplate("usdc-circle").stressFootnote).toMatch(/\bUSDC\b/);
    expect(shippedTemplate("dai-makerdao").stressFootnote).toMatch(/\bDAI\b/);
  });
});
