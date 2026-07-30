import type { DdrCoinStructural } from "@shared/lib/depeg-resolver";
import { bytesToHex } from "../../lib/hash";
import { toErrorMessage } from "../../lib/error-utils";
import { throwIfAborted } from "../../lib/abort";
import {
  DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
  DDR_PREDICTION_POLICY_VERSION,
  DDR_V2_EFFECTIVE_AT,
} from "@shared/lib/depeg-resolver-version";
import {
  computeMintAuthorityScore,
  stablecoinToMintAuthorityScoringInput,
  type MintAuthorityParentResolver,
} from "@shared/lib/mint-authority-scoring";
import { FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { isTerminalStablecoinStatus } from "@shared/lib/stablecoin-lifecycle";
import type { StablecoinMeta } from "@shared/types/core";
import type { DdrCanonicalIncident, DdrCanonicalIncidentInput, DdrDirection } from "../depeg-resolver-v2-contracts";
import type { DdrEventDbRow } from "./types";

export function abortIf(signal: AbortSignal | undefined, _label: string): void {
  throwIfAborted(signal);
}

function pegCurrencyFromPegType(pegType: string): string {
  return pegType.startsWith("pegged") ? pegType.slice("pegged".length) : "USD";
}

const mintAuthorityParentResolver: MintAuthorityParentResolver = (id) =>
  stablecoinToMintAuthorityScoringInput(TRACKED_META_BY_ID.get(id));

export interface DdrV9DependencyCard {
  id: string;
  dependencies: {
    serial: readonly { upstreamAssetId: string }[];
  };
}

let v9DependencyImpairmentByCoin = new Map<string, boolean>();

function hasFrozenOrDeadUpstream(card: DdrV9DependencyCard): boolean {
  return card.dependencies.serial.some((dependency) => {
    const upstream = TRACKED_META_BY_ID.get(dependency.upstreamAssetId);
    return upstream != null && isTerminalStablecoinStatus(upstream.status);
  });
}

/** Install the current V9 serial dependency projection for this resolver run. */
export function hydrateV9DependencyImpairment(cards: readonly DdrV9DependencyCard[]): void {
  v9DependencyImpairmentByCoin = new Map(cards.map((card) => [card.id, hasFrozenOrDeadUpstream(card)]));
}

/** Clear V9 dependency state before a run whose V9 publication is unavailable. */
export function clearV9DependencyImpairment(): void {
  v9DependencyImpairmentByCoin = new Map();
}

export function toStructural(meta: StablecoinMeta, dependencyImpaired?: boolean | null): DdrCoinStructural {
  const v9DependencyImpaired = dependencyImpaired ?? v9DependencyImpairmentByCoin.get(meta.id);
  return {
    id: meta.id,
    symbol: meta.symbol,
    name: meta.name,
    pegCurrency: meta.flags.pegCurrency,
    governance: meta.flags.governance,
    status: meta.status ?? null,
    mechanismArchetype: meta.mechanismArchetype ?? null,
    mintPath: meta.mintAuthority?.mintPath ?? null,
    authorityPosture: meta.mintAuthority?.authorityPosture ?? null,
    mintAuthorityScoreBand: computeMintAuthorityScore(
      stablecoinToMintAuthorityScoringInput(meta),
      mintAuthorityParentResolver,
    ).band,
    mintIncidents: meta.mintAuthority?.mintIncidents?.map((incident) => ({
      date: incident.date,
      status: incident.status,
      resolvedAt: incident.resolvedAt ?? null,
    })) ?? null,
    windDownAnnouncedAt: meta.windDownAnnouncedAt ?? null,
    collateralQuality: meta.collateralQuality ?? null,
    custodyModel: meta.custodyModel ?? null,
    reserves: meta.reserves?.map((r) => ({ risk: r.risk, pct: r.pct })),
    canBeBlacklisted: meta.canBeBlacklisted ?? null,
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
    pegCurrency: pegCurrencyFromPegType(pegType),
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

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function nullableStringValue(value: unknown, fallback: string | null): string | null {
  return value == null || typeof value === "string" ? (value ?? fallback) : fallback;
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function nullableNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toDirection(value: string): DdrDirection {
  return value === "above" ? "above" : "below";
}

export function eligibleAt(startedAt: number): number {
  return startedAt + DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC;
}

function eventPolicyIncluded(row: DdrEventDbRow): boolean {
  return (
    row.started_at >= DDR_V2_EFFECTIVE_AT ||
    (row.started_at < DDR_V2_EFFECTIVE_AT && (row.ended_at == null || row.ended_at >= DDR_V2_EFFECTIVE_AT))
  );
}

function buildRegistrySnapshot(meta: StablecoinMeta | undefined): Record<string, unknown> {
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
    symbol: row.symbol,
    pegCurrency: pegCurrencyFromPegType(row.peg_type),
    direction: toDirection(row.direction),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    recoveryPrice: row.recovery_price,
    peakDeviationBps: row.peak_deviation_bps,
    source: row.source,
    sourceFingerprint: null,
    rolloutActiveAtEnablement:
      row.started_at < DDR_V2_EFFECTIVE_AT && (row.ended_at == null || row.ended_at >= DDR_V2_EFFECTIVE_AT),
    publicTrackedAtFirstSeen: meta != null,
    psiShadowAtFirstSeen: meta == null,
    predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
    policyDelaySec: DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC,
    policyEffectiveAt: DDR_V2_EFFECTIVE_AT,
    registrySnapshot: buildRegistrySnapshot(meta),
  };
}

export function fallbackIncidentForEvent(row: DdrEventDbRow): DdrCanonicalIncident {
  return {
    incidentKey: `unresolved:${row.id}`,
    eventId: row.id,
    currentEventId: row.id,
    stablecoinId: row.stablecoin_id,
    pegCurrency: pegCurrencyFromPegType(row.peg_type),
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
