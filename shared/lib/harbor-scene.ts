/**
 * Harbor 2.0 (`/chains/`) view model: pure, deterministic, runtime-neutral (the Worker OG card reuses it).
 *
 * Every drawn quantity is linear and countable: one container = {@link HARBOR_UNIT_USD} of observed chain supply,
 * bays of {@link CONTAINERS_PER_BAY}. Chains ≥ {@link SHIP_MIN_USD} are ships, chains ≥ {@link CRAFT_MIN_USD} are
 * small craft (one fractional container), everything else is pooled into the tail barge whose count and sum come
 * from the full chain list (R7). `unattributedTotalUsd` rides a separate hatched barge. Container lengths are exact;
 * the sliver floor only affects `drawLength` and never reaches a label (R7). Nothing here reads the clock or DOM.
 */
import type { ChainSummary, ChainsResponse, HealthBand } from "../types/chains";
import { CHAIN_HEALTH_LABELS, CHAIN_HEALTH_PENNANTS } from "./classification/chain-health";
import { formatChainShare } from "./chain-share-format";
import { formatCompactUsd, formatSignedPercent } from "./format";

export const HARBOR_UNIT_USD = 1e9;
/** A bay is 2 × 5 containers (geometry decides which way the 5 run per preset). */
export const CONTAINERS_PER_BAY = 10;
export const SHIP_MIN_USD = 1e9;
export const CRAFT_MIN_USD = 1e8;
export const MAX_SHIPS = 16;
export const MAX_CRAFT = 24;
/** Bays drawn on one tier before containers stack a second tier from the stern ($160B; the longest hull that keeps a container face ≥ 6 px at 1440 px and ≥ 5 px at 390 px). */
export const MAX_BAYS_PER_TIER = 16;
/** Display-only minimum length of a fractional container (in container units). */
export const SLIVER_FLOOR = 0.06;
/** Wake scale: linear to this |%|, then a break mark. */
export const WAKE_BREAK_PCT = 10;
/** Below this |%| no wake is drawn. */
export const WAKE_MIN_PCT = 0.5;
/** From this |%| the wake takes its direction hue; below it the wake is neutral ink and the chevron shape alone says ▲/▼. */
export const WAKE_HUE_PCT = 5;
/** Conservation tolerance between drawn containers and the published totals. */
const CONSERVATION_TOLERANCE_USD = 1;

const HARBOR_CARGO_IDS = { usdt: "usdt-tether", usdc: "usdc-circle" } as const;

export type HarborCargoKind = "usdt" | "usdc" | "other" | "pool" | "unattributed";
/**
 * Cargo hues: categorical slots of `CHART_PALETTE` (`src/lib/chart-colors.ts`; parity is tested) chosen clear of the
 * health-band greens/ambers/reds and of frost blue (reserved for the beam). The unattributed barge is hatched, not
 * coloured. Not brand colours.
 */
export const HARBOR_CARGO_HEX = {
  usdt: "#6366f1",
  usdc: "#ec4899",
  other: "#94a3b8",
  pool: "#cbd5e1",
} as const satisfies Record<Exclude<HarborCargoKind, "unattributed">, string>;

export const HARBOR_CARGO_LABELS: Record<HarborCargoKind, string> = {
  usdt: "USDT",
  usdc: "USDC",
  other: "Other stablecoins",
  pool: "Pooled smaller chains",
  unattributed: "Unattributed",
};

export interface HarborCargoBand {
  kind: HarborCargoKind;
  /** Container-local span in container units, 0 ≤ from < to ≤ length. */
  from: number;
  to: number;
}

export interface HarborContainer {
  /** 0-based fill order. */
  index: number;
  /** Stack tier; tier 0 is the deck. Tiers above 0 exist only beyond {@link MAX_BAYS_PER_TIER} bays. */
  tier: number;
  /** Hull slot (0-based from the bow): even tiers fill bow → stern, odd tiers stack back from the stern. */
  position: number;
  bay: number;
  /** Exact length in container units (≤ 1). */
  length: number;
  /** Display length: `length` raised to {@link SLIVER_FLOOR}. Never a statistic. */
  drawLength: number;
  bands: HarborCargoBand[];
  stencil: "T" | "C" | null;
}

export type HarborFlag =
  | { kind: "band"; band: HealthBand; label: string; pennants: number; score: number | null }
  | { kind: "unrated"; reason: string };

export type HarborWake =
  | { kind: "none"; reason: "below-threshold" | "unavailable" }
  | { kind: "new" }
  | { kind: "wake"; direction: "up" | "down"; pct: number; magnitude: number; broken: boolean };

interface HarborVesselBase {
  /** Berth id; equal to the chain id for ships and craft. */
  id: string;
  rank: number;
  totalUsd: number;
  containers: HarborContainer[];
  /** Hull positions occupied on tier 0 (= hull length in container units, fractional last). */
  hullUnits: number;
  bays: number;
  accessibleName: string;
}

export interface HarborChainVessel extends HarborVesselBase {
  kind: "ship" | "craft";
  chain: Pick<ChainSummary, "id" | "name" | "logoPath" | "dominanceShare" | "stablecoinCount" | "topStablecoins" | "change7d" | "change7dPct" | "healthScore">;
  flag: HarborFlag;
  wake: HarborWake;
  partialRows: number;
}

export interface HarborBargeVessel extends HarborVesselBase {
  kind: "tail" | "unattributed";
  label: string;
  /** Chain ids pooled on the tail barge, in rank order; empty for the unattributed barge. */
  memberIds: string[];
  /** Chains on the barge with unobserved supply rows (coverage note). */
  partialMemberIds: string[];
}

export type HarborVessel = HarborChainVessel | HarborBargeVessel;

export function isHarborChainVessel(vessel: HarborVessel): vessel is HarborChainVessel {
  return vessel.kind === "ship" || vessel.kind === "craft";
}

export interface HarborScene {
  /** Rank order: ships, craft, tail barge, unattributed barge (also the keyboard order). */
  vessels: HarborVessel[];
  ships: HarborChainVessel[];
  craft: HarborChainVessel[];
  tail: HarborBargeVessel | null;
  unattributed: HarborBargeVessel | null;
  /** Berth id for every chain id in the response (tail-pooled chains map to the tail barge). */
  berthOf: Record<string, string>;
  globalTotalUsd: number | null;
  chainAttributedTotalUsd: number | null;
  unattributedTotalUsd: number | null;
  /** Over-attribution share of global supply, when chain rows exceed global supply. */
  overAttributionRatio: number | null;
  /** True when any container stacks above the deck tier. */
  tiered: boolean;
  retained: boolean;
  updatedAt: number;
  conservation: { ok: boolean | null; drawnUsd: number; expectedUsd: number | null };
}

export type HarborSceneInput = Pick<
  ChainsResponse,
  "globalTotalUsd" | "chainAttributedTotalUsd" | "unattributedTotalUsd" | "attributionDiscrepancyUsd" | "updatedAt"
> & {
  chains: readonly HarborChainInput[];
  /** The API freshness envelope; the frontend fetch layer delivers it as the query's `meta`, not inside the body. */
  _meta?: {
    status?: string;
    ageSeconds?: number | null;
    freshBudgetSec?: number | null;
    dependencies?: { reportCards?: { status: string; reason?: string | null } } | null;
  };
};

export type HarborChainInput = Pick<
  ChainSummary,
  | "id"
  | "name"
  | "logoPath"
  | "totalUsd"
  | "change7d"
  | "change7dPct"
  | "stablecoinCount"
  | "topStablecoins"
  | "dominanceShare"
  | "healthScore"
  | "healthBand"
  | "unavailableSupplyObservationCount"
>;

const TIER_CAPACITY = MAX_BAYS_PER_TIER * CONTAINERS_PER_BAY;
const finitePositive = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

function rankChains(chains: readonly HarborChainInput[]): HarborChainInput[] {
  return chains
    .slice()
    .sort((a, b) => finitePositive(b.totalUsd) - finitePositive(a.totalUsd) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Cumulative cargo runs bow→stern in container units: USDT, USDC, then everything else. */
function chainCargoRuns(chain: HarborChainInput, units: number): HarborCargoBand[] {
  const supplyOf = (id: string) => finitePositive(chain.topStablecoins.find((row) => row.id === id)?.supplyUsd ?? 0) / HARBOR_UNIT_USD;
  const usdt = Math.min(units, supplyOf(HARBOR_CARGO_IDS.usdt));
  const usdc = Math.min(units - usdt, supplyOf(HARBOR_CARGO_IDS.usdc));
  const runs: HarborCargoBand[] = [];
  let cursor = 0;
  for (const [kind, size] of [["usdt", usdt], ["usdc", usdc], ["other", units - usdt - usdc]] as const) {
    if (size <= 0) continue;
    runs.push({ kind, from: cursor, to: cursor + size });
    cursor += size;
  }
  return runs;
}

/** Splits `units` into $1B containers (fractional last) and cuts each into exact cargo bands. */
function buildContainers(units: number, runs: readonly HarborCargoBand[]): HarborContainer[] {
  const count = Math.ceil(units - 1e-12);
  const containers: HarborContainer[] = [];
  for (let index = 0; index < count; index++) {
    const start = index;
    const length = Math.min(1, units - start);
    const bands: HarborCargoBand[] = [];
    for (const run of runs) {
      const from = Math.max(run.from, start);
      const to = Math.min(run.to, start + length);
      if (to > from) bands.push({ kind: run.kind, from: from - start, to: to - start });
    }
    const tier = Math.floor(index / TIER_CAPACITY);
    const slot = index % TIER_CAPACITY;
    const position = tier % 2 === 0 ? slot : TIER_CAPACITY - 1 - slot;
    containers.push({
      index,
      tier,
      position,
      bay: Math.floor(position / CONTAINERS_PER_BAY),
      length,
      drawLength: Math.max(length, SLIVER_FLOOR),
      bands,
      stencil: null,
    });
  }
  // Stencil the first whole container of each USDT/USDC run that spans ≥ 3 whole containers.
  for (const run of runs) {
    if (run.kind !== "usdt" && run.kind !== "usdc") continue;
    const whole = containers.filter((c) => c.length === 1 && c.index >= run.from && c.index + 1 <= run.to);
    if (whole.length >= 3) whole[0].stencil = run.kind === "usdt" ? "T" : "C";
  }
  return containers;
}

function hullUnitsOf(containers: readonly HarborContainer[]): number {
  let hull = 0;
  for (const c of containers) if (c.tier === 0) hull = Math.max(hull, c.position + c.length);
  return hull;
}

/**
 * The scene draws supply, so it is retained only when the supply generation is: a non-fresh envelope whose only cause
 * is a lagging report-card dependency (supply age within its fresh budget) stays fresh here, and Chain Health names
 * its own generation through the NR flag reason (R3). Without age/budget, a non-fresh status counts as retained
 * unless the report-card dependency explains it.
 */
export function isSupplyRetained(meta: HarborSceneInput["_meta"]): boolean {
  if (meta?.status == null || meta.status === "fresh") return false;
  if (meta.ageSeconds != null && meta.freshBudgetSec != null) return meta.ageSeconds > meta.freshBudgetSec;
  const reportCards = meta.dependencies?.reportCards;
  return reportCards == null || reportCards.status === "fresh";
}

/** Chain Health flag or NR reason; the leaderboard reuses it so the table and the scene share one NR vocabulary. */
export function harborFlag(chain: Pick<HarborChainInput, "healthBand" | "healthScore">, input: Pick<HarborSceneInput, "_meta">): HarborFlag {
  if (chain.healthBand) {
    return {
      kind: "band",
      band: chain.healthBand,
      label: CHAIN_HEALTH_LABELS[chain.healthBand],
      pennants: CHAIN_HEALTH_PENNANTS[chain.healthBand],
      score: chain.healthScore,
    };
  }
  const reportCards = input._meta?.dependencies?.reportCards;
  if (reportCards && reportCards.status !== "fresh") {
    return { kind: "unrated", reason: `Inputs unavailable${reportCards.reason ? `: ${reportCards.reason}` : ""}` };
  }
  return { kind: "unrated", reason: "Not rated: insufficient Chain Health coverage" };
}

function harborWake(chain: Pick<HarborChainInput, "change7d" | "change7dPct">): HarborWake {
  if (chain.change7dPct == null || !Number.isFinite(chain.change7dPct)) {
    return chain.change7dPct == null && chain.change7d != null && chain.change7d > 0
      ? { kind: "new" }
      : { kind: "none", reason: "unavailable" };
  }
  const pct = chain.change7dPct * 100;
  if (Math.abs(pct) < WAKE_MIN_PCT) return { kind: "none", reason: "below-threshold" };
  return {
    kind: "wake",
    direction: pct > 0 ? "up" : "down",
    pct,
    magnitude: Math.min(Math.abs(pct), WAKE_BREAK_PCT) / WAKE_BREAK_PCT,
    broken: Math.abs(pct) > WAKE_BREAK_PCT,
  };
}

function chainAccessibleName(chain: HarborChainInput, flag: HarborFlag, wake: HarborWake): string {
  const shareLabel = chain.dominanceShare == null
    ? "global share unavailable"
    : `${formatChainShare(chain.dominanceShare)} of tracked supply`;
  const parts = [chain.name, formatCompactUsd(chain.totalUsd), shareLabel];
  parts.push(flag.kind === "band" ? `Chain Health ${flag.band}${flag.score == null ? "" : ` ${flag.score}`}` : "Chain Health not rated");
  if (wake.kind === "wake") parts.push(`7d ${formatSignedPercent(wake.pct, 2)}`);
  else if (wake.kind === "new") parts.push("7d new supply");
  else if (wake.reason === "below-threshold" && chain.change7dPct != null) parts.push(`7d ${formatSignedPercent(chain.change7dPct * 100, 2)}`);
  if ((chain.unavailableSupplyObservationCount ?? 0) > 0) parts.push(`partial: ${chain.unavailableSupplyObservationCount} rows unobserved`);
  return parts.join(", ");
}

function chainVessel(kind: "ship" | "craft", chain: HarborChainInput, rank: number, input: HarborSceneInput): HarborChainVessel {
  const units = finitePositive(chain.totalUsd) / HARBOR_UNIT_USD;
  const containers = buildContainers(units, chainCargoRuns(chain, units));
  const flag = harborFlag(chain, input);
  const wake = harborWake(chain);
  return {
    kind,
    id: chain.id,
    rank,
    totalUsd: chain.totalUsd,
    containers,
    hullUnits: hullUnitsOf(containers),
    bays: Math.ceil(Math.min(units, TIER_CAPACITY) / CONTAINERS_PER_BAY),
    accessibleName: chainAccessibleName(chain, flag, wake),
    chain: {
      id: chain.id,
      name: chain.name,
      logoPath: chain.logoPath,
      dominanceShare: chain.dominanceShare,
      stablecoinCount: chain.stablecoinCount,
      topStablecoins: chain.topStablecoins,
      change7d: chain.change7d,
      change7dPct: chain.change7dPct,
      healthScore: chain.healthScore,
    },
    flag,
    wake,
    partialRows: chain.unavailableSupplyObservationCount ?? 0,
  };
}

function bargeVessel(
  kind: "tail" | "unattributed",
  totalUsd: number,
  rank: number,
  members: readonly HarborChainInput[],
): HarborBargeVessel {
  const units = finitePositive(totalUsd) / HARBOR_UNIT_USD;
  const cargo: HarborCargoKind = kind === "tail" ? "pool" : "unattributed";
  const containers = buildContainers(units, units > 0 ? [{ kind: cargo, from: 0, to: units }] : []);
  const label = kind === "tail"
    ? `+${members.length} more ${members.length === 1 ? "chain" : "chains"} · ${formatCompactUsd(totalUsd)}`
    : `Unattributed · ${formatCompactUsd(totalUsd)}`;
  return {
    kind,
    id: kind === "tail" ? "harbor-tail" : "harbor-unattributed",
    rank,
    totalUsd,
    containers,
    hullUnits: hullUnitsOf(containers),
    bays: Math.ceil(Math.min(units, TIER_CAPACITY) / CONTAINERS_PER_BAY),
    label,
    accessibleName: kind === "tail"
      ? `${members.length} smaller ${members.length === 1 ? "chain" : "chains"} pooled, ${formatCompactUsd(totalUsd)} combined`
      : `Unattributed supply not attributed to a chain row this run, ${formatCompactUsd(totalUsd)}`,
    memberIds: members.map((chain) => chain.id),
    partialMemberIds: members.filter((chain) => (chain.unavailableSupplyObservationCount ?? 0) > 0).map((chain) => chain.id),
  };
}

export function buildHarborScene(input: HarborSceneInput): HarborScene {
  const ranked = rankChains(input.chains);
  const ships: HarborChainVessel[] = [];
  const craft: HarborChainVessel[] = [];
  const pooled: HarborChainInput[] = [];
  let rank = 0;
  for (const chain of ranked) {
    const usd = finitePositive(chain.totalUsd);
    if (usd >= SHIP_MIN_USD && ships.length < MAX_SHIPS) ships.push(chainVessel("ship", chain, rank++, input));
    else if (usd >= CRAFT_MIN_USD && usd < SHIP_MIN_USD && craft.length < MAX_CRAFT) craft.push(chainVessel("craft", chain, rank++, input));
    else pooled.push(chain);
  }
  const pooledUsd = pooled.reduce((sum, chain) => sum + finitePositive(chain.totalUsd), 0);
  const tail = pooled.length > 0 ? bargeVessel("tail", pooledUsd, rank++, pooled) : null;
  const unattributedUsd = input.unattributedTotalUsd == null ? null : finitePositive(input.unattributedTotalUsd);
  const unattributed = unattributedUsd != null && unattributedUsd > 0 ? bargeVessel("unattributed", unattributedUsd, rank++, []) : null;

  const vessels: HarborVessel[] = [...ships, ...craft, ...(tail ? [tail] : []), ...(unattributed ? [unattributed] : [])];
  const berthOf: Record<string, string> = {};
  for (const vessel of [...ships, ...craft]) berthOf[vessel.id] = vessel.id;
  if (tail) for (const id of tail.memberIds) berthOf[id] = tail.id;

  const drawnUsd = vessels.reduce(
    (sum, vessel) => sum + vessel.containers.reduce((acc, c) => acc + c.length, 0) * HARBOR_UNIT_USD,
    0,
  );
  const expectedUsd = input.chainAttributedTotalUsd != null && unattributedUsd != null
    ? input.chainAttributedTotalUsd + unattributedUsd : null;
  const discrepancy = input.attributionDiscrepancyUsd === undefined
    ? input.chainAttributedTotalUsd != null && input.globalTotalUsd != null
      ? input.chainAttributedTotalUsd - input.globalTotalUsd : null
    : input.attributionDiscrepancyUsd;

  return {
    vessels,
    ships,
    craft,
    tail,
    unattributed,
    berthOf,
    globalTotalUsd: input.globalTotalUsd,
    chainAttributedTotalUsd: input.chainAttributedTotalUsd,
    unattributedTotalUsd: unattributedUsd,
    overAttributionRatio: discrepancy != null && discrepancy > 0 && input.globalTotalUsd != null && input.globalTotalUsd > 0
      ? discrepancy / input.globalTotalUsd : null,
    tiered: vessels.some((vessel) => vessel.containers.some((c) => c.tier > 0)),
    retained: isSupplyRetained(input._meta),
    updatedAt: input.updatedAt,
    conservation: {
      ok: expectedUsd != null && Number.isFinite(expectedUsd)
        ? Math.abs(drawnUsd - expectedUsd) <= CONSERVATION_TOLERANCE_USD : null,
      drawnUsd,
      expectedUsd,
    },
  };
}

/** `#chain-<id>` → chain id when known; anything else is ignored. */
export function parseHarborHash(hash: string, knownIds: ReadonlySet<string>): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("chain-")) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw.slice("chain-".length));
  } catch {
    return null;
  }
  return knownIds.has(id) ? id : null;
}

export function harborHash(chainId: string): string {
  return `#chain-${encodeURIComponent(chainId)}`;
}

/** Roving-focus step through berths in rank order. */
export function stepHarborBerth(
  vessels: readonly Pick<HarborVessel, "id">[],
  currentId: string | null,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
): string | null {
  if (vessels.length === 0) return null;
  if (key === "Home") return vessels[0].id;
  if (key === "End") return vessels[vessels.length - 1].id;
  const at = vessels.findIndex((vessel) => vessel.id === currentId);
  if (at === -1) return vessels[0].id;
  const next = key === "ArrowDown" ? Math.min(vessels.length - 1, at + 1) : Math.max(0, at - 1);
  return vessels[next].id;
}
