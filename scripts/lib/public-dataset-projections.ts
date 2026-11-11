import type { PublicDatasetTopic } from "@shared/lib/api-endpoints/datasets";
import { isRecord } from "@shared/lib/type-guards";
import type { DepegEvent, SupplyObservationProvenance } from "@shared/types/market";
import { getMechanismArchetypeLabel } from "@shared/lib/classification";
import { formatUtcDateOnly } from "@shared/lib/format";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { LIQUIDITY_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { admitSupplyBuckets, getCirculatingRawOrNull } from "@shared/lib/supply";
import { projectEnvelopeSupplyProvenance } from "@shared/lib/supply-provenance";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import type {
  PublicSnapshotEnvelope,
  PublicSnapshotEnvelopeV2,
} from "@shared/types/public-snapshot";
import {
  HistoricalResolvedReportCardsV9ResponseSchema,
  REPORT_CARDS_V9_REPORT8_SCHEMA_VERSION,
  V9PublicationHealthSchema,
} from "@shared/types/report-cards-v9";
import { ReportCardsV9CurrentResponseSchema } from "@shared/types/report-cards-v9-current";
import { SafetyScoreV9PublicationIdentitySchema } from "@shared/types/safety-score-publication";
import {
  SafetyScoreV9CompletenessSchema,
} from "@shared/types/safety-score-v9-public";
import {
  V9_OPEN_EVIDENCE_SEMANTICS,
  V9OpenEvidenceTotalsSchema,
} from "@shared/types/safety-score-v9-open-evidence";
import { z } from "zod";
import { buildPublicDatasetArtifacts, type DatasetColumn } from "./public-dataset-artifacts";
import type { DepegLedgerCapture } from "./depeg-ledger-capture";

export const RETENTION_DAYS = 90;

export type SnapshotEnvelope = Pick<PublicSnapshotEnvelopeV2, "snapshotDate" | "generatedAt" | "stablecoins"> & {
  version?: number;
  safetyScoreIdentity?: unknown;
  methodologyVersions?: Record<string, string>;
  reportCards:
    | {
        model?: string;
        scores?: Record<string, ReportCardScore>;
        cards?: Array<{
          id: string;
          score: number | null;
          grade: string;
        }>;
      }
    | Record<string, unknown>
    | null;
  dews: Array<{ stablecoinId: string; computedAt?: number; score: number; band: string }>;
  liquidity: Array<{
    stablecoinId: string;
    liquidityScore: number | null;
    coverageClass: string | null;
    updatedAt?: number;
    unavailableReason?: "invalid-coverage-evidence" | null;
    methodologyVersion?: string | null;
  }>;
};

/**
 * Normalized view of a safety-score entry. The aliases remain only so dated
 * pre-V9 public snapshots can still be projected.
 */
interface ReportCardScore {
  pegScore?: number;
  safetyScore?: number;
  score?: number;
  safetyGrade?: string;
  overall?: number;
  grade?: string;
}

export function isHistoricalSnapshotDate(snapshotDate: string): boolean {
  return snapshotDate !== formatUtcDateOnly(new Date());
}

export function isProjectionEnvelope(envelope: PublicSnapshotEnvelope): envelope is PublicSnapshotEnvelope & SnapshotEnvelope {
  return (
    typeof envelope.snapshotDate === "string"
    && typeof envelope.generatedAt === "number"
    && Array.isArray(envelope.stablecoins)
    && envelope.stablecoins.every((coin) => (
      typeof coin.name === "string"
      && typeof coin.symbol === "string"
      && typeof coin.pegType === "string"
      && typeof coin.pegMechanism === "string"
      && (typeof coin.price === "number" || coin.price === null)
      && typeof coin.circulating === "object"
      && coin.circulating !== null
      && Array.isArray(coin.chains)
    ))
    && (envelope.reportCards === null || (typeof envelope.reportCards === "object" && envelope.reportCards !== null))
    && Array.isArray(envelope.dews)
    && envelope.dews.every((row) => typeof row.score === "number" && typeof row.band === "string")
    && Array.isArray(envelope.liquidity)
    && envelope.liquidity.every((row) => (
      (typeof row.liquidityScore === "number" || row.liquidityScore === null)
      && (typeof row.coverageClass === "string" || row.coverageClass === null)
    ))
  );
}

interface TopStablecoinRow {
  id: string;
  name: string;
  symbol: string;
  pegType: string;
  pegMechanism: string;
  price: number | null;
  circulatingUsd: number | null;
  supplyUnavailableReason: string | null;
  /** Recorded chain-coverage provenance from the immutable envelope; null = unrecorded (unknown). */
  supplyProvenance: SupplyObservationProvenance | null;
  chainCount: number;
  chains: string;
}

const TOP_STABLECOINS_COLUMNS: DatasetColumn<TopStablecoinRow>[] = [
  { header: "id", accessor: (r) => r.id },
  { header: "symbol", accessor: (r) => r.symbol },
  { header: "name", accessor: (r) => r.name },
  { header: "pegType", accessor: (r) => r.pegType },
  { header: "pegMechanism", accessor: (r) => r.pegMechanism },
  { header: "price", accessor: (r) => r.price ?? null },
  { header: "circulatingUsd", accessor: (r) => r.circulatingUsd },
  { header: "chainCount", accessor: (r) => r.chainCount },
  { header: "chains", accessor: (r) => r.chains },
  { header: "supplyUnavailableReason", accessor: (r) => r.supplyUnavailableReason },
  { header: "supplyProvenance", accessor: (r) => r.supplyProvenance },
];

function projectTopStablecoins(envelope: SnapshotEnvelope | null): TopStablecoinRow[] {
  if (!envelope) return [];
  const pricingPipelineVersion = envelope.methodologyVersions?.pricingPipeline;
  return envelope.stablecoins
    .map((coin) => {
      const admission = admitSupplyBuckets(coin.circulating);
      return {
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol,
      pegType: coin.pegType,
      pegMechanism: coin.pegMechanism,
      price: coin.price,
      circulatingUsd: getCirculatingRawOrNull(coin),
      supplyUnavailableReason: admission.status === "observed" ? null
        : admission.status === "invalid" ? admission.reason : "absent",
      supplyProvenance: admission.status === "observed"
        ? projectEnvelopeSupplyProvenance({
          supplySource: coin.supplySource,
          supplyObservedAt: coin.supplyObservedAt,
          supplyChainGuard: coin.supplyChainGuard,
        }, pricingPipelineVersion)
        : null,
      chainCount: coin.chains.length,
      chains: coin.chains.join(";"),
      };
    })
    .sort((a, b) => a.circulatingUsd === null ? (b.circulatingUsd === null ? 0 : 1)
      : b.circulatingUsd === null ? -1 : b.circulatingUsd - a.circulatingUsd);
}

interface DepegHistoryRow {
  id: number;
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  peakDeviationBps: number;
  startedAtISO: string;
  endedAtISO: string | null;
  durationSec: number | null;
  startPrice: number;
  peakPrice: number | null;
  recoveryPrice: number | null;
  pegReference: number;
  source: "live" | "backfill";
  /** Reviewed ledger verdict; null when the ledger recorded none. */
  auditVerdict: string | null;
  /** True when the coin is absent from the tracked catalog; the event stays as history. */
  retired: boolean;
}

const DEPEG_HISTORY_COLUMNS: DatasetColumn<DepegHistoryRow>[] = [
  { header: "id", accessor: (r) => String(r.id) },
  { header: "stablecoinId", accessor: (r) => r.stablecoinId },
  { header: "symbol", accessor: (r) => r.symbol },
  { header: "direction", accessor: (r) => r.direction },
  { header: "peakDeviationBps", accessor: (r) => r.peakDeviationBps },
  { header: "startedAtISO", accessor: (r) => r.startedAtISO },
  { header: "endedAtISO", accessor: (r) => r.endedAtISO },
  { header: "durationSec", accessor: (r) => r.durationSec },
  { header: "startPrice", accessor: (r) => r.startPrice },
  { header: "peakPrice", accessor: (r) => r.peakPrice },
  { header: "recoveryPrice", accessor: (r) => r.recoveryPrice },
  { header: "pegReference", accessor: (r) => r.pegReference },
  { header: "source", accessor: (r) => r.source },
  // A reviewed dispute must travel with the row: without it the export shows
  // an extreme depeg that the ledger has already quarantined (A7A5 2026-08-06).
  { header: "auditVerdict", accessor: (r) => r.auditVerdict },
  // Rows for coins no longer in the tracked catalog stay exported, marked.
  { header: "retired", accessor: (r) => r.retired },
];

export function projectDepegHistory(events: DepegEvent[], snapshotDate: string): DepegHistoryRow[] {
  const cutoffSec = cutoffSecForSnapshotDate(snapshotDate);
  const snapshotEndSec = snapshotEndSecForDate(snapshotDate);
  return events
    .filter((event) => event.startedAt >= cutoffSec && event.startedAt <= snapshotEndSec)
    .map((event) => ({
      id: event.id,
      stablecoinId: event.stablecoinId,
      symbol: event.symbol,
      direction: event.direction,
      peakDeviationBps: event.peakDeviationBps,
      startedAtISO: new Date(event.startedAt * 1000).toISOString(),
      endedAtISO: event.endedAt ? new Date(event.endedAt * 1000).toISOString() : null,
      durationSec: event.endedAt ? event.endedAt - event.startedAt : null,
      startPrice: event.startPrice,
      peakPrice: event.peakPrice,
      recoveryPrice: event.recoveryPrice,
      pegReference: event.pegReference,
      source: event.source,
      auditVerdict: event.provenance?.auditVerdict ?? null,
      retired: event.retired === true,
    }))
    .sort((a, b) => b.startedAtISO.localeCompare(a.startedAtISO) || a.id - b.id);
}

interface ScoreLatestRow {
  stablecoinId: string;
  symbol: string;
  pegScore: number | null;
  safetyScore: number | null;
  safetyGrade: string | null;
  dewsScore: number | null;
  dewsBand: string | null;
  liquidityScore: number | null;
  coverageClass: string | null;
  ratingStatus: "rated" | "not-rated" | "pipeline-gap" | null;
  safetyDisplay: Readonly<Record<string, unknown>> | null;
  dewsComputedAt: number | null;
  liquidityUpdatedAt: number | null;
  liquidityUnavailableReason: string | null;
  liquidityMethodologyVersion: string | null;
}

const SCORES_LATEST_COLUMNS: DatasetColumn<ScoreLatestRow>[] = [
  { header: "stablecoinId", accessor: (r) => r.stablecoinId },
  { header: "symbol", accessor: (r) => r.symbol },
  { header: "pegScore", accessor: (r) => r.pegScore },
  { header: "safetyScore", accessor: (r) => r.safetyScore },
  { header: "safetyGrade", accessor: (r) => r.safetyGrade },
  { header: "dewsScore", accessor: (r) => r.dewsScore },
  { header: "dewsBand", accessor: (r) => r.dewsBand },
  { header: "liquidityScore", accessor: (r) => r.liquidityScore },
  { header: "coverageClass", accessor: (r) => r.coverageClass },
  { header: "ratingStatus", accessor: (r) => r.ratingStatus },
  { header: "safetyDisplay", accessor: (r) => r.safetyDisplay },
  { header: "dewsComputedAt", accessor: (r) => r.dewsComputedAt },
  { header: "liquidityUpdatedAt", accessor: (r) => r.liquidityUpdatedAt },
  { header: "liquidityUnavailableReason", accessor: (r) => r.liquidityUnavailableReason },
  { header: "liquidityMethodologyVersion", accessor: (r) => r.liquidityMethodologyVersion },
];

type CurrentSafetyPublication = z.infer<typeof ReportCardsV9CurrentResponseSchema>;
/** Archive-only report8 shape a dated capture was sealed under before report9. */
type ArchivedSafetyPublication = z.infer<typeof HistoricalResolvedReportCardsV9ResponseSchema>;
/** Live report9, or the report8 archive read only for historical dates. */
type AcceptedSafetyPublication = CurrentSafetyPublication | ArchivedSafetyPublication;
type AcceptedSafetyCard = AcceptedSafetyPublication["cards"][number];

type ScoresLatestOpenEvidenceUnavailableReason =
  | "safety-publication-unavailable"
  | "open-evidence-unavailable";

const SCORES_LATEST_OPEN_EVIDENCE_UNAVAILABLE_REASONS = [
  "safety-publication-unavailable",
  "open-evidence-unavailable",
] as const satisfies readonly ScoresLatestOpenEvidenceUnavailableReason[];

/**
 * The three server-computed question counts, copied from the publication's
 * `openEvidence` block. `semantics` travels with the counts so a definition
 * change never reads as a moved series, and the dataset never recomputes them.
 */
const ScoresLatestOpenEvidenceProjectionSchema = z
  .object({
    semantics: z.literal(V9_OPEN_EVIDENCE_SEMANTICS),
    totals: V9OpenEvidenceTotalsSchema,
  })
  .strict();

const ScoresLatestDisplayProjectionSchema = z
  .object({
    version: z.literal(2),
    snapshotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    capturedAtSec: z.number().int().nonnegative(),
    sourceSnapshotPath: z.string().min(1),
    safety: z
      .object({
        identity: SafetyScoreV9PublicationIdentitySchema,
        asOfSec: z.number().int().nonnegative(),
        publishedAtSec: z.number().int().nonnegative(),
        sourceGenerations: z.record(z.string().min(1), z.string().min(1)),
        publicationHealth: V9PublicationHealthSchema,
        completeness: SafetyScoreV9CompletenessSchema,
      })
      .strict()
      .nullable(),
    safetyUnavailableReason: z.literal("legacy-source-metadata-unavailable").nullable(),
    openEvidence: ScoresLatestOpenEvidenceProjectionSchema.nullable(),
    /** Names why the counts are absent; a missing block never reads as zero questions. */
    openEvidenceUnavailableReason: z
      .enum(SCORES_LATEST_OPEN_EVIDENCE_UNAVAILABLE_REASONS)
      .nullable(),
  })
  .strict()
  .superRefine((projection, ctx) => {
    // Presence and reason move together, and an absent Safety publication cannot
    // carry counts: the pair is the artifact's own statement that it has none.
    const expectedReason: ScoresLatestOpenEvidenceUnavailableReason | null = projection.openEvidence
      ? null
      : projection.safety === null
        ? "safety-publication-unavailable"
        : "open-evidence-unavailable";
    if (projection.openEvidenceUnavailableReason === expectedReason) return;
    ctx.addIssue({
      code: "custom",
      path: ["openEvidenceUnavailableReason"],
      message: "scores-latest open-evidence counts and their unavailable reason disagree",
    });
  });

type ScoresLatestDisplayProjection = z.infer<typeof ScoresLatestDisplayProjectionSchema>;

interface ScoresLatestProjection {
  rows: ScoreLatestRow[];
  displayProjection: ScoresLatestDisplayProjection | null;
}

function sameSafetyIdentity(left: unknown, right: unknown): boolean {
  const parsedLeft = SafetyScoreV9PublicationIdentitySchema.safeParse(left);
  const parsedRight = SafetyScoreV9PublicationIdentitySchema.safeParse(right);
  return parsedLeft.success
    && parsedRight.success
    && JSON.stringify(parsedLeft.data) === JSON.stringify(parsedRight.data);
}

/**
 * A current v2 envelope carries the accepted V9 publication. Live builds accept
 * only report9; a dated regeneration also reads the report8 archive shape the
 * capture was sealed under, so archived Safety facts are projected instead of
 * silently dropped. A V9 declaration that fails its own contract is an
 * integrity failure for a live build and stays explicitly unavailable (never
 * zero) for a historical one.
 */
function readSafetyPublication(
  envelope: SnapshotEnvelope,
  historical: boolean,
): AcceptedSafetyPublication | null {
  const raw = envelope.reportCards;
  const declaresV9 = isRecord(raw) && raw.model === "v9";
  if (!declaresV9) {
    if (envelope.version === 2 && !historical) {
      throw new Error(
        `Public snapshot ${envelope.snapshotDate} is a v2 envelope without an accepted V9 Safety publication`,
      );
    }
    return null;
  }
  // A dated regeneration also reads the report8 archive shape the capture was
  // sealed under; a live build accepts only report9, so an old Worker's bytes
  // are never republished as a current dataset.
  const archived = historical && isRecord(raw) &&
    "schemaVersion" in raw && raw.schemaVersion === REPORT_CARDS_V9_REPORT8_SCHEMA_VERSION;
  const parsed = archived
    ? HistoricalResolvedReportCardsV9ResponseSchema.safeParse(raw)
    : ReportCardsV9CurrentResponseSchema.safeParse(raw);
  if (!parsed.success) {
    if (historical) {
      if (archived) {
        console.warn(
          `[generate-public-datasets] archived report8 Safety publication for ${envelope.snapshotDate} is unreadable: `
            + (parsed.error.issues[0]?.message ?? "unknown schema issue"),
        );
      }
      return null;
    }
    throw new Error(
      `Public snapshot ${envelope.snapshotDate} carries an invalid V9 Safety publication: `
        + (parsed.error.issues[0]?.message ?? "unknown schema issue"),
    );
  }
  const publication = parsed.data;
  if (!sameSafetyIdentity(publication.safetyScoreIdentity, envelope.safetyScoreIdentity)) {
    if (historical) return null;
    throw new Error(
      `Public snapshot ${envelope.snapshotDate} Safety publication identity does not match the envelope identity`,
    );
  }
  if (envelope.generatedAt <= 0
    || publication.asOfSec > envelope.generatedAt
    || publication.updatedAt > envelope.generatedAt) {
    if (historical) return null;
    throw new Error(
      `Public snapshot ${envelope.snapshotDate} Safety publication clocks do not precede the snapshot collection clock`,
    );
  }
  return publication;
}

function projectSafetyDisplay(card: AcceptedSafetyCard): Readonly<Record<string, unknown>> {
  return {
    nrReasons: card.nrReasons,
    reasonCodes: card.reasonCodes,
    partialEvidence: card.partialEvidence,
    ...(card.gradeHold
      ? {
          gradeHold: {
            rawGrade: card.gradeHold.rawGrade,
            heldFromGenerationId: card.gradeHold.heldFromGenerationId,
          },
        }
      : {}),
    ...(card.provisional === true ? { provisional: true } : {}),
  };
}

function liquidityUnavailableReason(
  row: SnapshotEnvelope["liquidity"][number] | null,
): string | null {
  if (!row) return "source-row-missing";
  if (row.unavailableReason) return row.unavailableReason;
  // Snapshots written before the rejection reason was recorded still expose a
  // quarantined row as null coverage and null score; never claim it was valid.
  return row.coverageClass === null && row.liquidityScore === null ? "invalid-coverage-evidence" : null;
}

function projectLegacyScoresLatest(envelope: SnapshotEnvelope): ScoreLatestRow[] {
  const reportCardScores: Record<string, ReportCardScore> =
    (envelope.reportCards as { scores?: Record<string, ReportCardScore> })?.scores ??
    Object.fromEntries(
      ((envelope.reportCards as { cards?: Array<{ id: string; score: number | null; grade: string }> })?.cards ?? [])
        .map((card) => [
          card.id,
          {
            safetyScore: card.score ?? undefined,
            score: card.score ?? undefined,
            safetyGrade: card.grade,
            grade: card.grade,
          },
        ]),
    );
  const dewsByCoin = new Map(envelope.dews.map((row) => [row.stablecoinId, row]));
  const liquidityByCoin = new Map(envelope.liquidity.map((row) => [row.stablecoinId, row]));

  return envelope.stablecoins
    .map((coin) => {
      const reportCard = reportCardScores[coin.id] ?? null;
      const dews = dewsByCoin.get(coin.id) ?? null;
      const liquidity = liquidityByCoin.get(coin.id) ?? null;
      return {
        stablecoinId: coin.id,
        symbol: coin.symbol,
        pegScore: reportCard?.pegScore ?? null,
        safetyScore: reportCard?.safetyScore ?? reportCard?.score ?? reportCard?.overall ?? null,
        safetyGrade: reportCard?.safetyGrade ?? reportCard?.grade ?? null,
        dewsScore: dews?.score ?? null,
        dewsBand: dews?.band ?? null,
        liquidityScore: liquidity?.liquidityScore ?? null,
        coverageClass: liquidity?.coverageClass ?? null,
        // Legacy inputs retain their existing columns; the new Safety contract
        // is explicitly unavailable rather than reconstructed.
        ratingStatus: null,
        safetyDisplay: null,
        dewsComputedAt: null,
        liquidityUpdatedAt: null,
        liquidityUnavailableReason: null,
        liquidityMethodologyVersion: null,
      };
    })
    .sort((a, b) => (b.safetyScore ?? -1) - (a.safetyScore ?? -1));
}

function projectEnrichedScoresLatest(
  envelope: SnapshotEnvelope,
  publication: AcceptedSafetyPublication,
): ScoreLatestRow[] {
  const dewsByCoin = new Map(envelope.dews.map((row) => [row.stablecoinId, row]));
  const liquidityByCoin = new Map(envelope.liquidity.map((row) => [row.stablecoinId, row]));
  const cardsById = new Map(publication.cards.map((card) => [card.id, card]));
  const marketById = new Map(envelope.stablecoins.map((coin) => [coin.id, coin]));

  // A published rated asset can be absent from the market feed; keep it in the
  // census through its tracked registry identity. Unknown card IDs are an
  // integrity mismatch rather than a silently dropped rating.
  const roster = envelope.stablecoins.map((coin) => coin.id);
  for (const card of publication.cards) {
    if (marketById.has(card.id)) continue;
    if (!TRACKED_META_BY_ID.has(card.id)) {
      throw new Error(
        `Accepted Safety card ${card.id} has neither a market row nor a tracked registry identity`,
      );
    }
    roster.push(card.id);
  }
  const cardRowCounts = new Map<string, number>();
  for (const id of roster) {
    if (!cardsById.has(id)) continue;
    cardRowCounts.set(id, (cardRowCounts.get(id) ?? 0) + 1);
  }
  for (const card of publication.cards) {
    if (cardRowCounts.get(card.id) !== 1) {
      throw new Error(
        `Accepted Safety card ${card.id} must map to exactly one scores-latest row`,
      );
    }
  }

  return roster
    .map((id) => {
      const coin = marketById.get(id);
      const card = cardsById.get(id);
      const dews = dewsByCoin.get(id) ?? null;
      const liquidity = liquidityByCoin.get(id) ?? null;
      const symbol = coin?.symbol ?? TRACKED_META_BY_ID.get(id)?.symbol;
      if (!symbol) {
        throw new Error(`Scores-latest row ${id} has no canonical symbol`);
      }
      return {
        stablecoinId: id,
        symbol,
        pegScore: null,
        safetyScore: card?.score ?? null,
        safetyGrade: card?.grade ?? null,
        dewsScore: dews?.score ?? null,
        dewsBand: dews?.band ?? null,
        liquidityScore: liquidity?.liquidityScore ?? null,
        coverageClass: liquidity?.coverageClass ?? null,
        ratingStatus: card?.ratingStatus ?? null,
        safetyDisplay: card ? projectSafetyDisplay(card) : null,
        dewsComputedAt: dews?.computedAt ?? null,
        liquidityUpdatedAt: liquidity?.updatedAt ?? null,
        liquidityUnavailableReason: liquidityUnavailableReason(liquidity),
        liquidityMethodologyVersion: liquidity?.methodologyVersion ?? null,
      };
    })
    .sort((a, b) => (b.safetyScore ?? -1) - (a.safetyScore ?? -1));
}

function buildScoresDisplayProjection(
  envelope: SnapshotEnvelope,
  publication: AcceptedSafetyPublication | null,
): ScoresLatestDisplayProjection {
  // A report8 archive predates the counts: the key is absent, so its absence is
  // the reason (the live report9 contract always carries the key).
  const openEvidence = publication && "openEvidence" in publication
    ? publication.openEvidence ?? null
    : null;
  return {
    version: 2,
    snapshotDate: envelope.snapshotDate,
    capturedAtSec: envelope.generatedAt,
    sourceSnapshotPath: `/api/snapshots/${envelope.snapshotDate}.json`,
    safety: publication
      ? {
          identity: publication.safetyScoreIdentity,
          asOfSec: publication.asOfSec,
          publishedAtSec: publication.updatedAt,
          sourceGenerations: publication.source.sourceGenerations,
          publicationHealth: publication.publicationHealth,
          completeness: publication.completeness,
        }
      : null,
    safetyUnavailableReason: publication ? null : "legacy-source-metadata-unavailable",
    openEvidence: openEvidence
      ? { semantics: openEvidence.semantics, totals: openEvidence.totals }
      : null,
    openEvidenceUnavailableReason: openEvidence
      ? null
      : publication
        ? "open-evidence-unavailable"
        : "safety-publication-unavailable",
  };
}

export function projectScoresLatest(
  envelope: SnapshotEnvelope | null,
  options: { historical?: boolean } = {},
): ScoresLatestProjection {
  if (!envelope) return { rows: [], displayProjection: null };
  const publication = readSafetyPublication(envelope, options.historical ?? false);
  const displayProjection = ScoresLatestDisplayProjectionSchema.parse(
    buildScoresDisplayProjection(envelope, publication),
  );
  return {
    rows: publication
      ? projectEnrichedScoresLatest(envelope, publication)
      : projectLegacyScoresLatest(envelope),
    displayProjection,
  };
}

interface PegMechanismDistributionRow {
  mechanismArchetype: string;
  mechanismLabel: string;
  pegReferenceId: string;
  jurisdiction: string;
  coinCount: number;
}

const PEG_MECHANISM_COLUMNS: DatasetColumn<PegMechanismDistributionRow>[] = [
  { header: "mechanismArchetype", accessor: (r) => r.mechanismArchetype },
  { header: "mechanismLabel", accessor: (r) => r.mechanismLabel },
  { header: "pegReferenceId", accessor: (r) => r.pegReferenceId },
  { header: "jurisdiction", accessor: (r) => r.jurisdiction },
  { header: "coinCount", accessor: (r) => r.coinCount },
];

interface PegCatalogFields {
  mechanismArchetype?: string | null;
  pegReferenceId?: string | null;
  jurisdiction?: { country?: string | null } | null;
}

interface PegMechanismProjection {
  rows: PegMechanismDistributionRow[];
  metadataStatus?: "approximated";
  metadataNote?: string;
}

function projectPegMechanismRows(coins: readonly PegCatalogFields[]): PegMechanismDistributionRow[] {
  const counts = new Map<string, PegMechanismDistributionRow>();
  for (const coin of coins) {
    const archetype = coin.mechanismArchetype ?? "unknown";
    const pegReferenceId = coin.pegReferenceId ?? "unknown";
    const jurisdiction = coin.jurisdiction?.country ?? "unknown";
    const key = `${archetype}|${pegReferenceId}|${jurisdiction}`;
    const existing = counts.get(key);
    if (existing) {
      existing.coinCount += 1;
    } else {
      const knownArchetype = MECHANISM_ARCHETYPE_VALUES.includes(
        archetype as (typeof MECHANISM_ARCHETYPE_VALUES)[number],
      );
      counts.set(key, {
        mechanismArchetype: archetype,
        mechanismLabel: knownArchetype
          ? getMechanismArchetypeLabel(archetype as (typeof MECHANISM_ARCHETYPE_VALUES)[number])
          : "Unknown",
        pegReferenceId,
        jurisdiction,
        coinCount: 1,
      });
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.coinCount - a.coinCount);
}

function hasSnapshotCatalogFields(coin: SnapshotEnvelope["stablecoins"][number]): boolean {
  return (
    Object.prototype.hasOwnProperty.call(coin, "mechanismArchetype")
    && Object.prototype.hasOwnProperty.call(coin, "pegReferenceId")
    && Object.prototype.hasOwnProperty.call(coin, "jurisdiction")
  );
}

function projectPegMechanismDistribution(
  envelope: SnapshotEnvelope | null,
  historical = false,
): PegMechanismProjection {
  if (!envelope) {
    return { rows: projectPegMechanismRows(TRACKED_STABLECOINS) };
  }

  if (envelope.stablecoins.length > 0 && envelope.stablecoins.every(hasSnapshotCatalogFields)) {
    return { rows: projectPegMechanismRows(envelope.stablecoins) };
  }

  const metadataNote =
    `legacy snapshot ${envelope.snapshotDate} omitted mechanismArchetype, pegReferenceId, or jurisdiction; `
    + "using current catalog metadata as an approximation";
  console.warn(`[generate-public-datasets] ${metadataNote}.`);

  // Pre-catalog snapshots cannot provide an exact historical classification. Keep
  // the legacy latest output intact, and restrict historical approximation to
  // stablecoin IDs present in the snapshot envelope.
  if (!historical) {
    return {
      rows: projectPegMechanismRows(TRACKED_STABLECOINS),
      metadataStatus: "approximated",
      metadataNote,
    };
  }

  const currentById = new Map(TRACKED_STABLECOINS.map((coin) => [coin.id, coin]));
  const projectedCoins = envelope.stablecoins.map((coin) => {
    const current = currentById.get(coin.id);
    return {
      mechanismArchetype: coin.mechanismArchetype ?? current?.mechanismArchetype,
      pegReferenceId: coin.pegReferenceId ?? current?.pegReferenceId,
      jurisdiction: coin.jurisdiction ?? current?.jurisdiction,
    };
  });

  return {
    rows: projectPegMechanismRows(projectedCoins),
    metadataStatus: "approximated",
    metadataNote,
  };
}

export interface TopicSpec<T> {
  topic: PublicDatasetTopic;
  rows: T[];
  columns: DatasetColumn<T>[];
  /** Methodology label for the preamble. */
  methodologyLabel: string;
  metadataStatus?: "approximated";
  metadataNote?: string;
  depegCapture?: DepegLedgerCapture;
  displayProjection?: Readonly<Record<string, unknown>>;
}

export function buildTopicArtifacts<T>(spec: TopicSpec<T>, asOfISO: string) {
  if (spec.topic === "depeg-history" && spec.rows.length > 0 && !spec.depegCapture) {
    throw new Error("Depeg-history exports require captured event-ledger provenance");
  }
  return buildPublicDatasetArtifacts({
    rows: spec.rows,
    columns: spec.columns,
    metadata: {
      endpoint: spec.topic,
      asOfISO: spec.depegCapture?.observedAtISO ?? asOfISO,
      sourceUrl: (variant) => `${SITE_ORIGIN}/datasets/${spec.topic}/latest.${variant}`,
      methodologyLabel: spec.methodologyLabel,
      metadataStatus: spec.metadataStatus,
      metadataNote: spec.metadataNote,
      displayProjection: spec.displayProjection,
      ...(spec.depegCapture ? {
        freshnessContract: "retrospective windowed event history; event state observed during the ledger capture, not at the market snapshot clock",
        sourceGeneration: spec.depegCapture.captureId,
        sourceObservationStartedAtISO: spec.depegCapture.observationStartedAtISO,
        windowSnapshotAsOfISO: asOfISO,
      } : {}),
    },
  });
}

/**
 * The current scores-latest artifact must carry the versioned display
 * projection. Older dated files remain readable under their old contract, but
 * the alias target is what the app imports, so a missing or corrupt object is
 * an integrity failure rather than a silent preview withdrawal.
 */
export function validateScoresLatestDisplayProjection(
  projection: unknown,
  snapshotDate: string,
): { ok: true } | { ok: false; reason: string } {
  const parsed = ScoresLatestDisplayProjectionSchema.safeParse(projection);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `scores-latest _meta.displayProjection is missing or invalid (${parsed.error.issues[0]?.message ?? "unknown schema issue"})`,
    };
  }
  if (parsed.data.snapshotDate !== snapshotDate) {
    return {
      ok: false,
      reason: `scores-latest _meta.displayProjection dates ${parsed.data.snapshotDate}, expected ${snapshotDate}`,
    };
  }
  if (parsed.data.safety
    && (parsed.data.safety.asOfSec > parsed.data.safety.publishedAtSec
      || parsed.data.safety.publishedAtSec > parsed.data.capturedAtSec)) {
    return { ok: false, reason: "scores-latest _meta.displayProjection Safety clocks are out of order" };
  }
  return { ok: true };
}

function cutoffSecForSnapshotDate(snapshotDate: string): number {
  return Math.floor(new Date(`${snapshotDate}T00:00:00Z`).getTime() / 1000) - RETENTION_DAYS * 86_400;
}

function snapshotEndSecForDate(snapshotDate: string): number {
  return Math.floor(new Date(`${snapshotDate}T00:00:00Z`).getTime() / 1000) + 86_400 - 1;
}

export function validateDepegHistoryCoverage(events: readonly DepegEvent[], snapshotDate: string): void {
  const cutoffSec = cutoffSecForSnapshotDate(snapshotDate);
  const oldestStartedAt = events.reduce((oldest, event) => Math.min(oldest, event.startedAt), Number.POSITIVE_INFINITY);
  if (oldestStartedAt > cutoffSec) {
    throw new Error(
      `Depeg event source does not cover the ${RETENTION_DAYS}-day export window for ${snapshotDate}; ` +
        "refusing a potentially truncated public dataset.",
    );
  }
}

export function buildTopicSpecs(
  envelope: SnapshotEnvelope | null,
  depegEvents: DepegEvent[],
  snapshotDate: string,
  options: { historical?: boolean; depegCapture?: DepegLedgerCapture } = {},
): TopicSpec<unknown>[] {
  const historical = options.historical ?? isHistoricalSnapshotDate(snapshotDate);
  const envelopeSnapshotDate = envelope?.snapshotDate || snapshotDate;
  const pegMechanismProjection = projectPegMechanismDistribution(envelope, historical);
  const scoresProjection = projectScoresLatest(envelope, { historical });
  const methodologyVersion = (
    keys: readonly string[],
    fallback: string,
  ): string => {
    const version = keys
      .map((key) => envelope?.methodologyVersions?.[key])
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (version) return version.startsWith("v") ? version : `v${version}`;
    return historical ? "unavailable (legacy snapshot methodology not recorded)" : fallback;
  };

  return [
    {
      topic: "top-stablecoins",
      rows: projectTopStablecoins(envelope),
      columns: TOP_STABLECOINS_COLUMNS,
      methodologyLabel:
        `safety-score ${methodologyVersion(["reportCard", "pegScore"], SAFETY_SCORE_METHODOLOGY_VERSION_LABEL)}`,
    } as TopicSpec<TopStablecoinRow> as TopicSpec<unknown>,
    {
      topic: "depeg-history",
      rows: projectDepegHistory(depegEvents, envelopeSnapshotDate),
      columns: DEPEG_HISTORY_COLUMNS,
      methodologyLabel: `depeg-dews ${options.depegCapture?.methodologyVersionLabel ?? DEPEG_DEWS_METHODOLOGY_VERSION_LABEL}`,
      depegCapture: options.depegCapture,
    } as TopicSpec<DepegHistoryRow> as TopicSpec<unknown>,
    {
      topic: "scores-latest",
      rows: scoresProjection.rows,
      columns: SCORES_LATEST_COLUMNS,
      displayProjection: scoresProjection.displayProjection ?? undefined,
      methodologyLabel:
        `safety-score ${methodologyVersion(["reportCard", "pegScore"], SAFETY_SCORE_METHODOLOGY_VERSION_LABEL)} `
        + `| dews ${methodologyVersion(["dews"], DEPEG_DEWS_METHODOLOGY_VERSION_LABEL)} `
        + `| liquidity ${methodologyVersion(["liquidityScore"], LIQUIDITY_METHODOLOGY_VERSION_LABEL)}`,
    } as TopicSpec<ScoreLatestRow> as TopicSpec<unknown>,
    {
      topic: "peg-mechanism-distribution",
      rows: pegMechanismProjection.rows,
      columns: PEG_MECHANISM_COLUMNS,
      methodologyLabel:
        `safety-score ${methodologyVersion(["reportCard", "pegScore"], SAFETY_SCORE_METHODOLOGY_VERSION_LABEL)}`,
      ...(pegMechanismProjection.metadataStatus
        ? {
            metadataStatus: pegMechanismProjection.metadataStatus,
            metadataNote: pegMechanismProjection.metadataNote,
          }
        : {}),
    } as TopicSpec<PegMechanismDistributionRow> as TopicSpec<unknown>,
  ];
}
