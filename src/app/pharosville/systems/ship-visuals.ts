import type { ReportCard, StablecoinData, StablecoinMeta } from "@shared/types";
import { getCirculatingRaw } from "@shared/lib/supply";
import type { ShipVisual } from "./world-types";

const PEG_PENNANTS: Record<string, string> = {
  USD: "emerald",
  EUR: "blue",
  GBP: "cyan",
  GOLD: "gold",
  SILVER: "silver",
};

export function resolveShipVisual(asset: StablecoinData, meta: StablecoinMeta, reportCard: ReportCard | null): ShipVisual {
  const backing = meta.flags.backing;
  const governance = meta.flags.governance;
  const marketCap = getCirculatingRaw(asset);
  return {
    hull: backing === "algorithmic" ? "algo-junk" : backing === "crypto-backed" ? "crypto-caravel" : "treasury-galleon",
    rigging: governance === "decentralized" ? "dao-rig" : governance === "centralized-dependent" ? "dependent-rig" : "issuer-rig",
    pennant: PEG_PENNANTS[meta.flags.pegCurrency] ?? "slate",
    overlay: meta.flags.navToken ? "nav" : meta.flags.yieldBearing ? "yield" : reportCard?.overallGrade === "D" || reportCard?.overallGrade === "F" ? "watch" : "none",
    scale: marketCap >= 10_000_000_000 ? 1.25 : marketCap >= 1_000_000_000 ? 1 : 0.75,
  };
}
