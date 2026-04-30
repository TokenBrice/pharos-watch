import type { ChainSummary } from "@shared/types/chains";
import type { CemeteryEntry } from "@shared/lib/cemetery-merged";
import type { ReportCard, StablecoinData, StablecoinMeta } from "@shared/types";

export type TileKind = "deep-water" | "water" | "shore" | "land" | "road";

export type TerrainKind =
  | TileKind
  | "alert-water"
  | "calm-water"
  | "harbor-water"
  | "watch-water"
  | "warning-water"
  | "storm-water"
  | "ledger-water"
  | "beach"
  | "grass"
  | "rock"
  | "cliff"
  | "hill";

export interface PharosVilleTile {
  x: number;
  y: number;
  kind: TileKind;
  terrain?: TerrainKind;
}

export interface PharosVilleMap {
  width: number;
  height: number;
  tiles: PharosVilleTile[];
  waterRatio: number;
}

export type RouteMode = "world" | "desktop-only" | "loading" | "error";

export type ShipRiskPlacement =
  | "safe-harbor"
  | "breakwater-edge"
  | "harbor-mouth-watch"
  | "outer-rough-water"
  | "storm-shelf"
  | "ledger-mooring";

export interface PlacementEvidence {
  reason: string;
  sourceFields: string[];
  stale: boolean;
}

export type ShipHull =
  | "treasury-galleon"
  | "chartered-brigantine"
  | "dao-schooner"
  | "crypto-caravel"
  | "algo-junk";

export type ShipClass =
  | "cefi"
  | "cefi-dependent"
  | "defi"
  | "legacy-algo"
  | "unclassified";

export type ShipSizeTier =
  | "flagship"
  | "major"
  | "regional"
  | "local"
  | "skiff"
  | "micro"
  | "unknown";

export interface ShipVisual {
  hull: ShipHull;
  shipClass: ShipClass;
  classLabel: string;
  rigging: "issuer-rig" | "dependent-rig" | "dao-rig";
  pennant: string;
  overlay: "none" | "yield" | "nav" | "watch";
  sizeTier: ShipSizeTier;
  sizeLabel: string;
  scale: number;
}

export interface ShipChainPresence {
  chainId: string;
  currentUsd: number;
  share: number;
  hasRenderedDock: boolean;
}

export interface ShipDockVisit {
  chainId: string;
  dockId: string;
  weight: number;
  mooringTile: { x: number; y: number };
}

export type ShipWaterZone = "calm" | "watch" | "alert" | "warning" | "danger" | "ledger";

export interface LighthouseNode {
  id: "lighthouse";
  kind: "lighthouse";
  label: string;
  tile: { x: number; y: number };
  psiBand: string | null;
  score: number | null;
  color: string;
  unavailable: boolean;
  detailId: string;
}

export interface DockNode {
  id: string;
  kind: "dock";
  label: string;
  chainId: string;
  logoSrc: string | null;
  assetId: string;
  tile: { x: number; y: number };
  totalUsd: number;
  size: number;
  healthBand: ChainSummary["healthBand"];
  stablecoinCount: number;
  concentration: number | null;
  harboredStablecoins: DockStablecoin[];
  detailId: string;
}

export interface DockStablecoin {
  id: string;
  symbol: string;
  share: number;
  supplyUsd: number;
}

export interface ShipNode {
  id: string;
  kind: "ship";
  label: string;
  symbol: string;
  asset: StablecoinData;
  meta: StablecoinMeta;
  reportCard: ReportCard | null;
  logoSrc: string | null;
  tile: { x: number; y: number };
  riskTile: { x: number; y: number };
  chainPresence: ShipChainPresence[];
  dockVisits: ShipDockVisit[];
  dominantChainId: string | null;
  homeDockChainId: string | null;
  dockChainId: string | null;
  marketCapUsd: number;
  riskPlacement: ShipRiskPlacement;
  riskZone: ShipWaterZone;
  riskWaterLabel: string;
  placementEvidence: PlacementEvidence;
  visual: ShipVisual;
  change24hUsd: number | null;
  change24hPct: number | null;
  detailId: string;
}

export interface ShipClusterNode {
  id: string;
  kind: "ship-cluster";
  label: string;
  tile: { x: number; y: number };
  riskPlacement: ShipRiskPlacement;
  riskZone: ShipWaterZone;
  riskWaterLabel: string;
  shipIds: string[];
  ships: Array<{
    id: string;
    label: string;
    symbol: string;
    marketCapUsd: number;
  }>;
  count: number;
  totalUsd: number;
  detailId: string;
}

export interface GraveNode {
  id: string;
  kind: "grave";
  label: string;
  entry: CemeteryEntry;
  logoSrc: string | null;
  tile: { x: number; y: number };
  visual: {
    marker: "headstone" | "cross" | "tablet" | "ledger" | "reliquary";
    scale: number;
  };
  detailId: string;
}

export type WorldEffectCueId =
  | "cue.lighthouse.psi"
  | "cue.ship.distance"
  | "cue.ship.motion"
  | "cue.water.semantic-terrain";

export type WorldEffectPurpose = "ambient" | "analytical";

export interface WorldEffect {
  cueId?: WorldEffectCueId;
  id: string;
  kind: "recent-change" | "fog" | "storm";
  entityId: string;
  intensity: number;
  nonData?: boolean;
  purpose: WorldEffectPurpose;
  reducedMotionEquivalent: string;
}

export interface LegendItem {
  id: string;
  label: string;
  description: string;
}

export type DewsAreaBand = "DANGER" | "WARNING" | "ALERT" | "WATCH" | "CALM";

export interface AreaNode {
  id: string;
  kind: "area";
  label: string;
  tile: { x: number; y: number };
  band?: DewsAreaBand;
  count?: number | null;
  detailId: string;
  facts?: Array<{ label: string; value: string }>;
  links?: Array<{ label: string; href: string }>;
  riskPlacement?: ShipRiskPlacement;
  riskZone?: ShipWaterZone;
  sourceFields?: string[];
  summary?: string;
}

export interface DetailModel {
  id: string;
  title: string;
  kind: string;
  summary: string;
  facts: Array<{ label: string; value: string }>;
  links: Array<{ label: string; href: string }>;
  membersHeading?: string;
  members?: Array<{ id: string; label: string; href: string; value?: string }>;
}

export type VisualCueTarget =
  | { kind: "area" }
  | { kind: "dock" }
  | { kind: "grave" }
  | { kind: "lighthouse" }
  | { kind: "ship" }
  | { kind: "ship-cluster" };

export type VisualCueChannel =
  | "color"
  | "glow"
  | "motion"
  | "opacity"
  | "position"
  | "shape"
  | "size";

export interface VisualCue {
  id: string;
  target: VisualCueTarget;
  primaryChannels: VisualCueChannel[];
  visual: string;
  sourceField: string;
  questionAnswered: string;
  failureState: string;
  domEquivalent: string;
  reducedMotionEquivalent: string;
}

export interface PharosVilleFreshness {
  stablecoinsStale?: boolean;
  chainsStale?: boolean;
  stabilityStale?: boolean;
  pegSummaryStale?: boolean;
  stressStale?: boolean;
  reportCardsStale?: boolean;
}

export interface PharosVilleWorld {
  generatedAt: number;
  routeMode: RouteMode;
  freshness: PharosVilleFreshness;
  map: PharosVilleMap;
  lighthouse: LighthouseNode;
  docks: DockNode[];
  areas: AreaNode[];
  ships: ShipNode[];
  shipClusters: ShipClusterNode[];
  graves: GraveNode[];
  effects: WorldEffect[];
  detailIndex: Record<string, DetailModel>;
  legends: LegendItem[];
  visualCues: VisualCue[];
}
