import type { DetailModel, DockNode, GraveNode, LighthouseNode, ShipClusterNode, ShipNode } from "./world-types";

const usd = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, style: "currency", currency: "USD" });

export function detailForLighthouse(node: LighthouseNode): DetailModel {
  return {
    id: node.detailId,
    kind: node.kind,
    title: node.label,
    summary: node.unavailable ? "PSI is unavailable, so the beacon is unlit." : `PSI band ${node.psiBand}.`,
    facts: [
      { label: "Score", value: node.score == null ? "Unavailable" : String(node.score) },
      { label: "Band", value: node.psiBand ?? "Unavailable" },
    ],
    links: [{ label: "PSI", href: "/stability-index/" }],
  };
}

export function detailForDock(node: DockNode): DetailModel {
  return {
    id: node.detailId,
    kind: node.kind,
    title: node.label,
    summary: "Dock footprint is based on chain stablecoin supply.",
    facts: [
      { label: "Stablecoin supply", value: usd.format(node.totalUsd) },
      { label: "Stablecoin count", value: String(node.stablecoinCount) },
      { label: "Health", value: node.healthBand ?? "Unavailable" },
    ],
    links: [{ label: "Chain", href: `/chains/${node.chainId}/` }],
  };
}

export function detailForShip(node: ShipNode): DetailModel {
  return {
    id: node.detailId,
    kind: node.kind,
    title: node.label,
    summary: node.placementEvidence.reason,
    facts: [
      { label: "Market cap", value: usd.format(node.marketCapUsd) },
      { label: "Risk placement", value: node.riskPlacement },
      { label: "Evidence", value: node.placementEvidence.sourceFields.join(", ") },
    ],
    links: [{ label: "Stablecoin", href: `/stablecoin/${node.id}/` }],
  };
}

export function detailForCluster(node: ShipClusterNode): DetailModel {
  return {
    id: node.detailId,
    kind: node.kind,
    title: node.label,
    summary: "Clustered long-tail ships share the same risk placement.",
    facts: [
      { label: "Ships", value: String(node.count) },
      { label: "Total market cap", value: usd.format(node.totalUsd) },
      { label: "Risk placement", value: node.riskPlacement },
    ],
    links: [{ label: "Stablecoins", href: "/stablecoins/" }],
    members: node.ships.map((ship) => ({
      id: ship.id,
      label: `${ship.label} (${ship.symbol})`,
      href: `/stablecoin/${ship.id}/`,
      value: usd.format(ship.marketCapUsd),
    })),
  };
}

export function detailForGrave(node: GraveNode): DetailModel {
  return {
    id: node.detailId,
    kind: node.kind,
    title: node.entry.name,
    summary: node.entry.epitaph ?? node.entry.obituary,
    facts: [
      { label: "Symbol", value: node.entry.symbol },
      { label: "Cause", value: node.entry.causeOfDeath },
      { label: "Date", value: node.entry.deathDate },
    ],
    links: [{ label: "Cemetery", href: "/cemetery/" }],
  };
}
