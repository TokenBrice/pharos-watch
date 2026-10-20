import type { DdrCoinStructural } from "@shared/lib/depeg-resolver";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { bytesToHex } from "../../lib/hash";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
  DDR_V2_EFFECTIVE_AT,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { curatedMintPostureBand, resolveV9MintPostureBand } from "@shared/lib/safety-score-v9/mint-posture";
import {
  WORKER_FROZEN_IDS as FROZEN_IDS,
  WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID,
  type WorkerRuntimeStablecoinMeta,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import type { DdrCanonicalIncident, DdrCanonicalIncidentInput, DdrDirection } from "../depeg-resolver-v2-contracts";
import type { DdrEventDbRow, DdrStructuralContext } from "./types";

type DdrRegistryMeta = Pick<WorkerRuntimeStablecoinMeta,
  "id" | "symbol" | "name" | "flags" | "status" | "mechanismArchetype" |
  "mintAuthority" | "windDownAnnouncedAt" | "collateralQuality" | "custodyModel" |
  "reserves" | "blacklistabilityReview" | "dependencies">;


export interface DdrV9DependencyCard {
  id: string;
  dependencies: {
    serial: readonly { upstreamAssetId: string }[];
  };
  /**
   * Published Economic Control breakdown. DDR K1 reads the mint component's
   * posture band from it (safety 9.1): the standalone Mint Authority band DDR
   * used to derive was retired, and the published posture is the same judgment
   * from the engine that now owns mint risk. Nullable on older publications.
   */
  breakdowns?: {
    control?: { components: readonly { kind: string; posture: string }[] } | null;
  } | null;
}


function hasFrozenOrDeadUpstream(card: DdrV9DependencyCard): boolean {
  return card.dependencies.serial.some((dependency) => {
    const upstream = TRACKED_META_BY_ID.get(dependency.upstreamAssetId);
    return upstream != null && isTerminalStablecoinStatus(upstream.status);
  });
}

function publishedMintPosture(card: DdrV9DependencyCard): string | null {
  const mint = card.breakdowns?.control?.components.find((component) => component.kind === "mint");
  return mint?.posture ?? null;
}

/** Project an admitted V9 publication without retaining run state in the isolate. */
export function buildDdrStructuralContext(cards: readonly DdrV9DependencyCard[]): DdrStructuralContext {
  return new Map(cards.map((card) => [card.id, {
    dependencyImpaired: hasFrozenOrDeadUpstream(card),
    mintPosture: publishedMintPosture(card),
  }]));
}

export function toStructural(meta: DdrRegistryMeta, context: DdrStructuralContext | null): DdrCoinStructural {
  const projection = context?.get(meta.id);
  const v9DependencyImpaired = projection?.dependencyImpaired;
  const derivedPosture = projection?.mintPosture;
  // V9 proves absence on this token, not automatically on its upstream supply.
  const authorityPosture = derivedPosture === "none-resolved" && meta.mintAuthority?.authorityPosture !== "none-resolved"
    ? "none-resolved-mint"
    : derivedPosture ?? meta.mintAuthority?.authorityPosture ?? null;
  return {
    id: meta.id,
    symbol: meta.symbol,
    name: meta.name,
    pegCurrency: meta.flags.pegCurrency,
    governance: meta.flags.governance,
    status: meta.status ?? null,
    mechanismArchetype: meta.mechanismArchetype ?? null,
    mintPath: meta.mintAuthority?.mintPath ?? null,
    authorityPosture,
    // 9.1: the published V9 mint posture band replaces the retired standalone
    // Mint Authority band. The retired engine derived the band from curated
    // metadata, so it was always evaluable; a publication-sourced band is not.
    // Losing the band leg because the V9 pipeline is degraded would make K1
    // *less* likely to flag supply weaponization exactly when the pipeline is
    // unhealthy, so a run with no installed projection falls back to the
    // curated posture rather than to `null` — the same shape as the curated
    // `dependencies` fallback below. A run *with* a projection keeps the
    // published answer verbatim, including a published "no band".
    mintAuthorityScoreBand: resolveV9MintPostureBand(derivedPosture)
      ?? (context != null
        ? null
        : curatedMintPostureBand(meta.mintAuthority?.authorityPosture)),
    mintIncidents: meta.mintAuthority?.mintIncidents?.map((incident) => ({
      date: incident.date,
      status: incident.status,
      resolvedAt: incident.resolvedAt ?? null,
    })) ?? null,
    windDownAnnouncedAt: meta.windDownAnnouncedAt ?? null,
    collateralQuality: meta.collateralQuality ?? null,
    custodyModel: meta.custodyModel ?? null,
    reserves: meta.reserves?.map((r) => ({ risk: r.risk, pct: r.pct })),
    canBeBlacklisted: meta.blacklistabilityReview?.reviewedStatus ?? null,
    dependencyImpaired:
      v9DependencyImpaired ??
      (meta.dependencies?.some((d) => FROZEN_IDS.has(d.id) && d.weight >= 0.3) ?? false),
  };
}

export function fallbackStructural(id: string, symbol: string, pegType: string): DdrCoinStructural {
  return {
    id,
    symbol,
    name: symbol,
    pegCurrency: getPegTaxonomyByType(pegType)?.currency ?? "USD",
    governance: "centralized",
  };
}

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(data);
  } else {
    for (let index = 0; index < data.length; index += 1) {
      data[index] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(data);
}

export function allocateDdrRunId(slot: string, runAt: number): string {
  return `ddr:${slot}:${runAt}:${randomHex(6)}`;
}



function toDirection(value: string): DdrDirection {
  return value === "above" ? "above" : "below";
}

function eligibleAt(startedAt: number): number {
  return startedAt + DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC;
}

function eventPolicyIncluded(row: DdrEventDbRow): boolean {
  return (
    row.started_at >= DDR_V2_EFFECTIVE_AT ||
    (row.started_at < DDR_V2_EFFECTIVE_AT && (row.ended_at == null || row.ended_at >= DDR_V2_EFFECTIVE_AT))
  );
}

function buildRegistrySnapshot(meta: DdrRegistryMeta | undefined): Record<string, unknown> {
  if (!meta) return { publicTracked: false };
  return {
    publicTracked: true,
    id: meta.id,
    symbol: meta.symbol,
    status: meta.status ?? null,
    pegCurrency: meta.flags.pegCurrency,
    governance: meta.flags.governance,
    navToken: meta.flags.navToken === true,
  };
}

export function toCanonicalIncidentInput(row: DdrEventDbRow): DdrCanonicalIncidentInput {
  const meta = TRACKED_META_BY_ID.get(row.stablecoin_id);
  return {
    eventId: row.id,
    stablecoinId: row.stablecoin_id,
    pegCurrency: getPegTaxonomyByType(row.peg_type)?.currency ?? "USD",
    direction: toDirection(row.direction),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    peakDeviationBps: row.peak_deviation_bps,
    source: row.source,
    sourceFingerprint: null,
    publicTrackedAtFirstSeen: meta != null,
    psiOffCatalogAtFirstSeen: meta == null,
    registrySnapshot: buildRegistrySnapshot(meta),
  };
}

export function fallbackIncidentForEvent(row: DdrEventDbRow): DdrCanonicalIncident {
  return {
    incidentKey: `unresolved:${row.id}`,
    eventId: row.id,
    currentEventId: row.id,
    stablecoinId: row.stablecoin_id,
    pegCurrency: getPegTaxonomyByType(row.peg_type)?.currency ?? "USD",
    direction: toDirection(row.direction),
    startedAt: row.started_at,
    eligibleAt: eligibleAt(row.started_at),
    policyUniverseIncluded: eventPolicyIncluded(row),
    rolloutActiveAtEnablement: row.started_at < DDR_V2_EFFECTIVE_AT,
    confirmedAt: null,
    lockState: null,
  };
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

export function formatDdrrFailure(error: unknown): string {
  return toErrorMessage(error);
}

export function publicationSnapshotToken(runId: string, publishedAt: number): string {
  return `ddrpub:${publishedAt}:${runId.replace(/[^A-Za-z0-9_.:-]/g, "_")}`;
}
