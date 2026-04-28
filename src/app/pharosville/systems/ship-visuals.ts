import type { ReportCard, StablecoinData, StablecoinMeta } from "@shared/types";
import { getCirculatingRaw } from "@shared/lib/supply";
import { GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
import type { ShipClass, ShipHull, ShipSizeTier, ShipVisual } from "./world-types";

const PEG_PENNANTS: Record<string, string> = {
  USD: "emerald",
  EUR: "blue",
  GBP: "cyan",
  GOLD: "gold",
  SILVER: "silver",
};

interface ShipClassDefinition {
  hull: ShipHull;
  label: string;
  shipClass: ShipClass;
  rigging: ShipVisual["rigging"];
}

interface ShipSizeDefinition {
  label: string;
  scale: number;
  tier: ShipSizeTier;
}

const UNKNOWN_CLASS: ShipClassDefinition = {
  hull: "crypto-caravel",
  label: "Unclassified",
  shipClass: "unclassified",
  rigging: "issuer-rig",
};

export function resolveShipClass(meta: StablecoinMeta): ShipClassDefinition {
  const backing = meta.flags?.backing;
  const governance = meta.flags?.governance;
  if (backing === "algorithmic") {
    return {
      hull: "algo-junk",
      label: "Legacy algorithmic",
      shipClass: "legacy-algo",
      rigging: "dependent-rig",
    };
  }

  if (governance === "centralized") {
    return {
      hull: "treasury-galleon",
      label: GOVERNANCE_LABELS_SHORT.centralized,
      shipClass: "cefi",
      rigging: "issuer-rig",
    };
  }

  if (governance === "centralized-dependent") {
    return {
      hull: "chartered-brigantine",
      label: GOVERNANCE_LABELS_SHORT["centralized-dependent"],
      shipClass: "cefi-dependent",
      rigging: "dependent-rig",
    };
  }

  if (governance === "decentralized") {
    return {
      hull: "dao-schooner",
      label: GOVERNANCE_LABELS_SHORT.decentralized,
      shipClass: "defi",
      rigging: "dao-rig",
    };
  }

  return UNKNOWN_CLASS;
}

export function resolveShipSizeTier(marketCapUsd: number): ShipSizeDefinition {
  if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) {
    return { label: "Unknown", scale: 0.7, tier: "unknown" };
  }
  if (marketCapUsd >= 10_000_000_000) return { label: "Flagship", scale: 3, tier: "flagship" };
  if (marketCapUsd >= 1_000_000_000) return { label: "Major", scale: 1.8, tier: "major" };
  if (marketCapUsd >= 100_000_000) return { label: "Regional", scale: 1.25, tier: "regional" };
  if (marketCapUsd >= 10_000_000) return { label: "Local", scale: 0.95, tier: "local" };
  if (marketCapUsd >= 1_000_000) return { label: "Skiff", scale: 0.78, tier: "skiff" };
  return { label: "Micro", scale: 0.7, tier: "micro" };
}

export function resolveShipVisual(asset: StablecoinData, meta: StablecoinMeta, reportCard: ReportCard | null): ShipVisual {
  const marketCap = getCirculatingRaw(asset);
  const shipClass = resolveShipClass(meta);
  const size = resolveShipSizeTier(marketCap);
  return {
    hull: shipClass.hull,
    shipClass: shipClass.shipClass,
    classLabel: shipClass.label,
    rigging: shipClass.rigging,
    pennant: PEG_PENNANTS[meta.flags.pegCurrency] ?? "slate",
    overlay: meta.flags.navToken ? "nav" : meta.flags.yieldBearing ? "yield" : reportCard?.overallGrade === "D" || reportCard?.overallGrade === "F" ? "watch" : "none",
    sizeTier: size.tier,
    sizeLabel: size.label,
    scale: size.scale,
  };
}
