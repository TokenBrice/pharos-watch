import { describe, it, expect } from "vitest";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeCentralizedCustodyFraction } from "./classification-invariants.test-support";
import { INFRASTRUCTURE_VALUES, LAUNCH_PHASE_VALUES, LAUNCH_MILESTONE_TYPE_VALUES } from "@shared/types/core";
import { ReserveRiskSchema } from "@shared/types/reserves";
import { TAPE_EVENT_SEVERITY_VALUES, SEVERITY_RANK } from "@shared/types/tape-event-constants";
import { INFRASTRUCTURE_LABELS } from "@shared/lib/classification/domain";
import { getInfrastructureLabel } from "@shared/lib/infrastructure";
import { LAUNCH_PHASE_LABELS, MILESTONE_TYPE_LABELS, PRE_LAUNCH_PHASE_CLASSES, PRE_LAUNCH_MILESTONE_BADGE_CLASSES } from "@shared/lib/classification/pre-launch";
import { RESERVE_RISK_PRESENTATION } from "@shared/lib/classification/reserve-risk";
import { SEVERITY_LABEL, SEVERITY_LABEL_INCLUSIVE, SEVERITY_TEXT_CLASS, SEVERITY_DOT_CLASS, TAPE_SEVERITY_PRESENTATION } from "@shared/lib/classification/tape";

const MAJORITY_THRESHOLD = 0.50;

// C11 retires the runtime warning, not the catalog's custody invariant.
describe("classification invariants", () => {
  it("does not allow decentralized coins with >50% centralized-custody exposure", () => {
    const warnings: string[] = [];

    const defiCoins = TRACKED_STABLECOINS.filter(
      (c) => c.flags.governance === "decentralized",
    );

    for (const coin of defiCoins) {
      const fraction = computeCentralizedCustodyFraction(
        coin.id, TRACKED_STABLECOINS,
      );
      if (fraction > MAJORITY_THRESHOLD) {
        warnings.push(
          `${coin.id}: classified "decentralized" but ${(fraction * 100).toFixed(1)}% ` +
          `centralized-custody exposure (threshold: ${MAJORITY_THRESHOLD * 100}%)`,
        );
      }
    }

    expect(warnings).toEqual([]);
  });
});

describe("classification display completeness", () => {
  it("labels every launch phase and milestone alongside its presentation", () => {
    expect(Object.keys(LAUNCH_PHASE_LABELS).sort()).toEqual([...LAUNCH_PHASE_VALUES].sort());
    for (const phase of LAUNCH_PHASE_VALUES) {
      expect(LAUNCH_PHASE_LABELS[phase]).toBeTruthy();
      expect(PRE_LAUNCH_PHASE_CLASSES[phase]).toBeDefined();
    }
    expect(Object.keys(MILESTONE_TYPE_LABELS).sort()).toEqual([...LAUNCH_MILESTONE_TYPE_VALUES].sort());
    for (const milestone of LAUNCH_MILESTONE_TYPE_VALUES) {
      expect(MILESTONE_TYPE_LABELS[milestone]).toBeTruthy();
      expect(PRE_LAUNCH_MILESTONE_BADGE_CLASSES[milestone]).toBeTruthy();
    }
  });

  it("resolves every infrastructure through the classification authority", () => {
    expect(Object.keys(INFRASTRUCTURE_LABELS).sort()).toEqual([...INFRASTRUCTURE_VALUES].sort());
    for (const infrastructure of INFRASTRUCTURE_VALUES) {
      expect(getInfrastructureLabel(infrastructure)).toBe(INFRASTRUCTURE_LABELS[infrastructure]);
      expect(getInfrastructureLabel(infrastructure)).toBeTruthy();
    }
  });

  it("keeps standalone tape labels distinct from inclusive severity floors", () => {
    const highestRank = Math.max(...Object.values(SEVERITY_RANK));
    expect(Object.keys(TAPE_SEVERITY_PRESENTATION).sort()).toEqual([...TAPE_EVENT_SEVERITY_VALUES].sort());
    for (const severity of TAPE_EVENT_SEVERITY_VALUES) {
      const tier = TAPE_SEVERITY_PRESENTATION[severity];
      expect(SEVERITY_LABEL[severity]).toBe(tier.label);
      expect(SEVERITY_LABEL_INCLUSIVE[severity]).toBe(
        SEVERITY_RANK[severity] === highestRank ? tier.label : `${tier.label}+`,
      );
      expect(SEVERITY_TEXT_CLASS[severity]).toBe(tier.textClass);
      expect(SEVERITY_DOT_CLASS[severity]).toBe(tier.dotClass);
    }
  });

  it("pairs each reserve tier's labels with the same hue for tile fills and accents", () => {
    expect(Object.keys(RESERVE_RISK_PRESENTATION).sort()).toEqual([...ReserveRiskSchema.options].sort());
    for (const risk of ReserveRiskSchema.options) {
      const tier = RESERVE_RISK_PRESENTATION[risk];
      expect(tier.shortLabel).toBeTruthy();
      expect(tier.longLabel.toLowerCase()).toBe(`${tier.shortLabel} risk`.toLowerCase());
      expect(tier.fillColor).toBe(`${tier.accentColor}3d`);
    }
  });
});
