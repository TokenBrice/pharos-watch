import { CHAIN_META } from "@shared/lib/chains";
import type { AreaNode, DetailModel, DockNode, GraveNode, LighthouseNode, ShipClusterNode, ShipNode } from "./world-types";
import { ETHEREUM_L2_DOCK_CHAIN_IDS } from "./world-layout";

const usd = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, style: "currency", currency: "USD" });
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, style: "percent" });

function marketCapLabel(value: number): string {
  return Number.isFinite(value) && value > 0 ? usd.format(value) : "Unavailable";
}

function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function chainLabel(chainId: string): string {
  return CHAIN_META[chainId]?.name ?? chainId;
}

const ETHEREUM_L2_DOCK_CHAIN_ID_SET = new Set<string>(ETHEREUM_L2_DOCK_CHAIN_IDS);

function dockHarborGroupLabel(node: DockNode): string {
  if (node.chainId === "ethereum") return "Ethereum anchor harbor";
  if (ETHEREUM_L2_DOCK_CHAIN_ID_SET.has(node.chainId)) return "Ethereum L2 extension";
  return "Outer chain harbor";
}

function chainsPresentLabel(node: ShipNode): string {
  if (node.chainPresence.length === 0) return "0 positive chain deployments";
  const topChains = node.chainPresence
    .slice(0, 3)
    .map((presence) => `${chainLabel(presence.chainId)} ${percent.format(presence.share)}`)
    .join(", ");
  const remainingCount = node.chainPresence.length - 3;
  const suffix = remainingCount > 0 ? `, +${remainingCount} more` : "";
  return `${pluralize(node.chainPresence.length, "positive chain deployment")}: ${topChains}${suffix}`;
}

function dockingCadenceLabel(node: ShipNode): string {
  const chainCount = node.chainPresence.length;
  const renderedDockCount = node.dockVisits.length;
  let cadence = "No rendered dock cadence";
  if (renderedDockCount === 0) {
    cadence = "No rendered dock cadence";
  } else if (renderedDockCount >= 3 || chainCount >= 4) {
    cadence = "Frequent";
  } else if (renderedDockCount >= 2) {
    cadence = "Regular";
  } else if (renderedDockCount === 1) {
    cadence = "Occasional";
  }
  return `${cadence}; ${pluralize(chainCount, "positive chain deployment")}, ${pluralize(renderedDockCount, "rendered dock stop")}`;
}

function representativePositionLabel(node: ShipNode): string {
  if (node.riskPlacement === "ledger-mooring") return "Ledger Mooring idle";
  return `${node.riskWaterLabel} idle`;
}

function evidenceStatusLabel(node: ShipNode): string {
  return node.placementEvidence.stale ? `Caveat: ${node.placementEvidence.reason}` : "Fresh current placement evidence";
}

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
  const topSymbols = node.harboredStablecoins.map((coin) => coin.symbol).join(", ");
  const harborGroup = dockHarborGroupLabel(node);
  return {
    id: node.detailId,
    kind: node.kind,
    title: node.label,
    summary: topSymbols
      ? `${harborGroup} for ${topSymbols}; footprint is based on chain stablecoin supply.`
      : `${harborGroup}; footprint is based on chain stablecoin supply.`,
    facts: [
      { label: "Stablecoin supply", value: usd.format(node.totalUsd) },
      { label: "Stablecoin count", value: String(node.stablecoinCount) },
      { label: "Health", value: node.healthBand ?? "Unavailable" },
      { label: "Harbor group", value: harborGroup },
      { label: "Harbor style", value: node.assetId.replace("dock.", "").replaceAll("-", " ") },
    ],
    links: [{ label: "Chain", href: `/chains/${node.chainId}/` }],
    membersHeading: "Harbored stablecoins",
    members: node.harboredStablecoins.map((coin) => ({
      id: coin.id,
      label: `${coin.symbol} (${percent.format(coin.share)})`,
      href: `/stablecoin/${coin.id}/`,
      value: usd.format(coin.supplyUsd),
    })),
  };
}

export function detailForShip(node: ShipNode): DetailModel {
  return {
    id: node.detailId,
    kind: node.kind,
    title: node.label,
    summary: node.placementEvidence.reason,
    facts: [
      { label: "Market cap", value: marketCapLabel(node.marketCapUsd) },
      { label: "Ship class", value: node.visual.classLabel },
      { label: "Size tier", value: node.visual.sizeLabel },
      { label: "Representative position", value: representativePositionLabel(node) },
      { label: "Risk water area", value: node.riskWaterLabel },
      { label: "Risk water zone", value: node.riskZone },
      { label: "Risk placement key", value: node.riskPlacement },
      { label: "Home dock", value: node.homeDockChainId ? chainLabel(node.homeDockChainId) : "No rendered dock" },
      { label: "Chains present", value: chainsPresentLabel(node) },
      { label: "Docking cadence", value: dockingCadenceLabel(node) },
      { label: "Route source", value: "stablecoins.chainCirculating, pegSummary.coins[], stress.signals[]" },
      { label: "Evidence status", value: evidenceStatusLabel(node) },
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
      { label: "Risk water area", value: node.riskWaterLabel },
      { label: "Risk water zone", value: node.riskZone },
      { label: "Risk placement key", value: node.riskPlacement },
    ],
    links: [{ label: "Stablecoins", href: "/stablecoins/" }],
    membersHeading: "Cluster members",
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

export function detailForArea(node: AreaNode): DetailModel {
  return {
    id: node.detailId,
    kind: node.kind,
    title: node.label,
    summary: node.summary ?? (node.band
      ? `${node.label} is a DEWS ${node.band} water area used for ship risk placement.`
      : `${node.label} is a named water area.`),
    facts: [
      ...(node.band ? [{ label: "DEWS band", value: node.band }] : []),
      ...(node.count != null ? [{ label: "Stablecoins", value: String(node.count) }] : []),
      ...(node.riskZone ? [{ label: "Risk water zone", value: node.riskZone }] : []),
      ...(node.riskPlacement ? [{ label: "Risk placement", value: node.riskPlacement }] : []),
      ...(node.facts ?? []),
      ...(node.sourceFields?.length ? [{ label: "Source fields", value: node.sourceFields.join(", ") }] : []),
    ],
    links: node.links ?? [{ label: "DEWS", href: "/depeg/" }],
  };
}
