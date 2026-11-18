import { admittedDepegOnset, admittedDepegRecoveryAt } from "../../src/lib/tape-projectors/depeg";
import { REFERENCE_MARKET_RETIRED_EVENTS } from "@shared/data/depegs/reference-market-retired-events";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "@shared/lib/sha256";
import { jsonResponse } from "../../src/lib/api-response";
import { D1_BATCH_SIZE } from "../../src/lib/constants";
import { buildInClause, executeAtomicBatch } from "../../src/lib/db";
import type { TapeEventRow } from "../../src/lib/tape-event-types";
import { rowPriceCoverage, type DepegRow } from "../../src/lib/depeg-helpers";
import { replayHistoricalPsiForDay } from "../../src/lib/psi-replay";
import { loadHistoricalPsiArchives, loadHistoricalPsiReferences, loadHistoricalPsiSampleSlots, loadPsiEligibleDepegEvents } from "../../src/lib/psi-replay-inputs";
import type { PsiDepegEventRow } from "../../src/lib/psi-recompute";
import { DEPEG_RECOVERY_CLOSE_REASONS } from "@shared/lib/depeg-closure";
import { DEPEG_SEVERITY_BPS } from "@shared/lib/depeg-config";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { getConditionBand } from "@shared/lib/psi-policy";
import { getReferenceMarket, getReferenceSessionState } from "@shared/lib/reference-market-hours";
import type { DepegAdmittedCoverage, DepegEventDisposition } from "@shared/types/peg";
import { REFERENCE_MARKET_RESTORATIONS } from "./repair-reference-market-artifacts-restorations";
import { DEPEG_CLAIM_RETRACTED_REASON } from "@shared/types/tape-event-constants";
import { DAY_SECONDS } from "@shared/lib/time-constants";

const REPAIR_VERSION = "l8-reference-market-v1";
const LEGACY_REPAIR_VERSION = "3.69";
const LEGACY_HISTORY_END = Date.UTC(2026, 10, 17) / 1000;
const REVIEWED_NOVEMBER_REOPEN = 1_794_783_600;
const REVIEWED_NOVEMBER_FAMILIES = [
  { coin: "audd-novatti", incident: "ddr2:69a72ad462b65c78d4b4c0bf97bb1d42", ids: [91043, 91048] },
  { coin: "paxg-paxos", incident: "ddr2:b2b60107b67ad548b719b2251fa2c47a", ids: [91045, 91049] },
  { coin: "xaut-tether", incident: "ddr2:739c34fa00ca60a5be72ceb490bfb85b", ids: [91046, 91050] },
] as const;
const REVIEWED_IDS = new Set<number>(REVIEWED_NOVEMBER_FAMILIES.flatMap(({ ids }) => [...ids]));
const EVIDENCED_BRZ_ID = 91044;
// Fill only after the integrated PSI, API/export, scoring and Timeline acceptance tests pass.
const REVIEWED_READER_REVISION: string | null = null;

type PsiComponents = NonNullable<ReturnType<typeof replayHistoricalPsiForDay>["result"]>["components"];
export interface ReviewedPsiReversal {
  inputHash: string;
  replayAt: number;
  replayMethodologyVersion: string;
  removedEvents: readonly (PsiDepegEventRow & { id: number })[];
  originalComponents: PsiComponents;
  repairedComponents: PsiComponents;
  delta: { score: number; severity: number; breadth: number };
}

const REVIEWED_PSI_REVERSALS: Readonly<Partial<Record<number, ReviewedPsiReversal>>> = {};

interface EventRow extends DepegRow {
  admitted_coverage_json: string | null;
  disposition: DepegEventDisposition | null;
  recovery_peg_reference?: number | null;
  peer_basis_json?: string | null;
}
interface DayRow {
  id: number;
  computed_at: number;
  score: number;
  band: string;
  components: string;
  input_snapshot: string;
  methodology_version: string;
}
interface CoverageChange {
  preImage: EventRow;
  disposition: DepegEventDisposition;
  admittedCoverage: DepegAdmittedCoverage | null;
  reasons: string[];
}
type Restoration = (typeof REFERENCE_MARKET_RESTORATIONS)[number];
interface ClosureGroup {
  coverage: CoverageChange[];
  restorations: Restoration[];
  blockers: string[];
  tapeTargets: Map<number, { transitions: string[]; reason: string; clearOpeningEnd?: boolean }>;
}

function planCoverage(event: EventRow): { reopen: number; change: CoverageChange } | null {
  const market = getReferenceMarket(getPegTaxonomyByType(event.peg_type)?.currency);
  if (market == null || event.ended_at == null || event.ended_at <= event.started_at) return null;
  const startSession = getReferenceSessionState(market, event.started_at);
  const endSession = getReferenceSessionState(market, event.ended_at);
  const heldOpening = !startSession.open && admittedDepegOnset(event) == null;
  const heldRecovery = !endSession.open && admittedDepegRecoveryAt(event) == null
    && (DEPEG_RECOVERY_CLOSE_REASONS.includes(event.close_reason ?? "")
      || (event.close_reason == null && event.recovery_price != null));
  const trusted = rowPriceCoverage(event);
  let hasUnclockedInterval = false;
  let reopen = (heldOpening ? startSession.nextOpenSec : null) ?? (heldRecovery ? endSession.nextOpenSec : null);
  let straddledClosure = false;
  let withheldInterval = false;
  for (const [fromSec, toSec] of trusted?.intervals ?? []) {
    if (fromSec < event.started_at || toSec > event.ended_at || fromSec >= toSec) continue;
    const session = getReferenceSessionState(market, toSec - 1);
    if (session.open && fromSec >= session.sessionOpenedAtSec) {
      hasUnclockedInterval = true;
    } else {
      reopen ??= session.open ? session.sessionOpenedAtSec : session.nextOpenSec;
      if (session.open || fromSec < session.closureStartSec) straddledClosure = true;
      else withheldInterval = true;
    }
  }
  if (reopen == null) return null;
  return {
    reopen,
    change: {
      preImage: event, disposition: "admitted-coverage", admittedCoverage: null,
      reasons: [
        ...(heldOpening ? [Math.abs(event.peak_deviation_bps) >= DEPEG_SEVERITY_BPS.severe
          ? "severe-onset-uncertain" : "opening-held"] : []),
        ...(heldRecovery ? ["recovery-clock-unverified"] : []),
        "off-peg-coverage-unavailable",
        ...(hasUnclockedInterval ? ["off-peg-reference-clock-unavailable"] : []),
        ...(straddledClosure ? ["coverage-crosses-closure-without-dated-boundary"] : []),
        ...(withheldInterval ? ["off-peg-coverage-held"] : []),
      ],
    },
  };
}

async function loadClosureGroups(db: D1Database, afterReopen: number) {
  const groups = new Map<number, ClosureGroup>();
  const groupAt = (reopen: number) => {
    const group: ClosureGroup = groups.get(reopen) ?? { coverage: [], restorations: [], blockers: [], tapeTargets: new Map() };
    groups.set(reopen, group);
    return group;
  };

  for (const restoration of REFERENCE_MARKET_RESTORATIONS) {
    if (restoration.reopen <= afterReopen) continue;
    const existing = await db.prepare("SELECT * FROM depeg_events WHERE id = ?").bind(restoration.event.id).first<EventRow>();
    if (existing == null) groupAt(restoration.reopen).restorations.push(restoration);
    else if (existing.disposition !== "restored-evidenced" || existing.stablecoin_id !== restoration.event.stablecoinId
      || existing.started_at !== restoration.event.startedAt) {
      groupAt(restoration.reopen).blockers.push(`restore-id-conflict:${restoration.event.id}`);
    }
  }

  const verifiedNovemberIds: number[] = [];
  if (REVIEWED_NOVEMBER_REOPEN > afterReopen) {
    const ids = buildInClause([...REVIEWED_IDS]);
    const rows = await db.prepare(`SELECT * FROM depeg_events WHERE id IN (${ids.sql})`).bind(...ids.binds).all<EventRow>();
    const events = new Map((rows.results ?? []).map((event) => [event.id, event]));
    if (events.size > 0) {
      const links = await db.prepare(`SELECT event_id, incident_key FROM depeg_resolver_incident_event_links WHERE event_id IN (${ids.sql})`)
        .bind(...ids.binds).all<{ event_id: number; incident_key: string }>();
      for (const { coin, incident, ids: members } of REVIEWED_NOVEMBER_FAMILIES) {
        if (!members.some((id) => events.has(id))) continue;
        if (members.some((id) => {
          const event = events.get(id);
          return event?.stablecoin_id !== coin || !links.results.some((link) => link.event_id === id && link.incident_key === incident)
            || !(event.disposition == null && event.admitted_coverage_json == null
              || event.disposition === "repaired" && event.admitted_coverage_json === "[]");
        })) {
          groupAt(REVIEWED_NOVEMBER_REOPEN).blockers.push(`reviewed-family-mismatch:${incident}`);
          continue;
        }
        verifiedNovemberIds.push(...members);
        for (const id of members) {
          const event = events.get(id)!;
          if (event.disposition == null) groupAt(REVIEWED_NOVEMBER_REOPEN).coverage.push({
            preImage: event, disposition: "repaired", admittedCoverage: [], reasons: ["reviewed-closure-artifact"],
          });
        }
      }
    }
  }

  let afterId = 0;
  while (true) {
    const { results } = await db.prepare(`SELECT * FROM depeg_events WHERE id > ? AND ended_at < ?
      AND ended_at >= ? AND disposition IS NULL AND admitted_coverage_json IS NULL AND peg_type != 'peggedUSD'
      ORDER BY id LIMIT 500`).bind(afterId, LEGACY_HISTORY_END, Math.max(0, afterReopen - 7 * 86400)).all<EventRow>();
    for (const event of results) {
      if (REVIEWED_IDS.has(event.id) || event.id === EVIDENCED_BRZ_ID) continue;
      const planned = planCoverage(event);
      if (planned != null && planned.reopen > afterReopen) groupAt(planned.reopen).coverage.push(planned.change);
    }
    if (results.length < 500) break;
    afterId = results[results.length - 1]!.id;
  }
  function targetTape(reopen: number, id: number, transitions: string[], reason: string, clearOpeningEnd = false): void {
    if (reopen > afterReopen && transitions.length > 0) groupAt(reopen).tapeTargets.set(id, { transitions, reason, clearOpeningEnd });
  }

  const retired = new Map<number, number>();
  for (const [reopen, ids] of REFERENCE_MARKET_RETIRED_EVENTS) {
    if (reopen > afterReopen) for (const id of ids) retired.set(id, reopen);
  }
  const kauSession = getReferenceSessionState("metal", 1_783_741_708);
  if (!kauSession.open && kauSession.nextOpenSec > afterReopen) retired.set(90520, kauSession.nextOpenSec);
  for (const id of verifiedNovemberIds) retired.set(id, REVIEWED_NOVEMBER_REOPEN);
  // Discover Tape-only closures with identities first. Full pre-images are read only for the selected page.
  if (retired.size > 0) {
    const { results } = await db.prepare(`
      SELECT DISTINCT CAST(ids.value AS INTEGER) AS source_id
      FROM json_each(?) ids JOIN tape_events t ON t.source_table = 'depeg_events'
        AND ${TAPE_SOURCE_MATCH_SQL}
      WHERE t.suppressed_at IS NULL AND t.transition IN ('opened', 'resolved', 'updated')`)
      .bind(JSON.stringify([...retired.keys()])).all<{ source_id: number }>();
    for (const { source_id } of results) targetTape(retired.get(source_id)!, source_id, ["opened", "resolved", "updated"],
      source_id === 90520 || REVIEWED_IDS.has(source_id) ? "reviewed-depeg-artifact" : "depeg-source-retired");
  }
  for (const [reopen, group] of groups) {
    for (const { preImage, reasons } of group.coverage) {
      const transitions = [];
      if (reasons.includes("opening-held") || reasons.includes("severe-onset-uncertain")) transitions.push("opened", "updated");
      const heldRecovery = reasons.includes("recovery-clock-unverified");
      const clearOpeningEnd = heldRecovery && !transitions.includes("opened");
      if (heldRecovery) transitions.push("resolved");
      if (clearOpeningEnd) transitions.push("opened");
      targetTape(reopen, preImage.id, transitions, "depeg-observation-unverified", clearOpeningEnd);
    }
  }
  return [...groups].sort(([left], [right]) => left - right);
}

const TAPE_SOURCE_MATCH_SQL = `(t.source_row_id = CAST(ids.value AS TEXT)
  OR (t.source_row_id >= CAST(ids.value AS TEXT) || ':' AND t.source_row_id < CAST(ids.value AS TEXT) || ';'))`;

async function loadPageTapePreimages(db: D1Database, page: ReadonlyArray<readonly [number, ClosureGroup]>) {
  const targetsById = new Map(page.flatMap(([reopen, group]) =>
    [...group.tapeTargets].map(([id, target]) => [id, { ...target, reopen }] as const)));
  const byReopen = new Map<number, { preImage: TapeEventRow; reason: string; clearEnd: boolean }[]>();
  if (targetsById.size === 0) return byReopen;
  const { results } = await db.prepare(`SELECT t.*, CAST(ids.value AS INTEGER) AS source_id
    FROM json_each(?) ids JOIN tape_events t ON t.source_table = 'depeg_events'
      AND ${TAPE_SOURCE_MATCH_SQL}
    WHERE t.suppressed_at IS NULL AND t.transition IN ('opened', 'resolved', 'updated')`)
    .bind(JSON.stringify([...targetsById.keys()])).all<TapeEventRow & { source_id: number }>();
  for (const { source_id, ...preImage } of results) {
    const target = targetsById.get(source_id);
    if (!target?.transitions.includes(preImage.transition)) continue;
    const rows = byReopen.get(target.reopen) ?? [];
    const clearEnd = target.clearOpeningEnd === true && preImage.transition === "opened";
    rows.push({ preImage, reason: target.reason, clearEnd });
    byReopen.set(target.reopen, rows);
  }
  return byReopen;
}

function restorationWrite(db: D1Database, { event }: Restoration) {
  return db.prepare(`INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
    started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source, confirmation_sources,
    pending_reason, close_reason, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'restored-evidenced')`)
    .bind(event.id, event.stablecoinId, event.symbol, event.pegType, event.direction, event.peakDeviationBps,
      event.startedAt, event.endedAt, event.startPrice, event.peakPrice, event.recoveryPrice, event.pegReference,
      event.source, event.confirmationSources, event.pendingReason, event.closeReason);
}

type PsiScore = { score: number; components: PsiComponents };

function applyPsiAdjustment(stored: PsiScore, delta: ReviewedPsiReversal["delta"]): PsiScore | null {
  const severity = stored.components.severity + delta.severity;
  const breadth = stored.components.breadth + delta.breadth;
  const overshoot = Math.max(0, -severity) + Math.max(0, -breadth);
  if (overshoot > 0.5 || ![severity, breadth, stored.score, delta.score].every(Number.isFinite)) return null;
  return {
    score: Math.round(Math.min(100, Math.max(0, stored.score + delta.score - overshoot)) * 10) / 10,
    components: {
      ...stored.components,
      severity: Math.round(Math.max(0, severity) * 100) / 100,
      breadth: Math.round(Math.max(0, breadth) * 100) / 100,
    },
  };
}

export function verifyReviewedPsiDelta(
  review: ReviewedPsiReversal,
  legacy: { previousScore: number; repairedScore: number },
  before: PsiScore,
  after: PsiScore,
  isolated: PsiScore,
): PsiScore | null {
  const original = applyPsiAdjustment({ score: legacy.previousScore, components: review.originalComponents }, {
    score: after.score - before.score,
    severity: after.components.severity - before.components.severity,
    breadth: after.components.breadth - before.components.breadth,
  });
  const valid = original?.score === legacy.repairedScore
    && stableJsonStringifyV1(original.components) === stableJsonStringifyV1(review.repairedComponents)
    && Number.isFinite(review.delta.score) && review.delta.score <= 0
    && review.delta.severity >= 0 && review.delta.breadth >= 0
    && Math.round((isolated.score - after.score) * 10) / 10 === review.delta.score
    && Math.round((isolated.components.severity - after.components.severity) * 100) / 100 === review.delta.severity
    && Math.round((isolated.components.breadth - after.components.breadth) * 100) / 100 === review.delta.breadth
    && isolated.components.stressBreadth === after.components.stressBreadth
    && isolated.components.trend === after.components.trend;
  return valid ? applyPsiAdjustment(original, review.delta) : null;
}

async function planPsiReversal(db: D1Database, { event, legacyPsi }: Restoration, coingeckoApiKey: string | null) {
  const result = [];
  for (const legacy of legacyPsi) {
    const { day, previousScore, repairedScore } = legacy;
    const { results: days } = await db.prepare("SELECT * FROM stability_index WHERE computed_at = ?").bind(day).all<DayRow>();
    const preImage = days.length === 1 ? days[0]! : null;
    const review = REVIEWED_PSI_REVERSALS[event.id];
    if (review == null) return { blocker: `reviewed-psi-reversal-unavailable:${event.id}:${day}` };
    const snapshot = preImage == null ? null : JSON.parse(preImage.input_snapshot);
    const marker = snapshot?.referenceMarketRepair;
    if (preImage == null || marker?.version !== LEGACY_REPAIR_VERSION || marker.method !== "replay-delta"
      || marker.previousScore !== previousScore || preImage.score !== repairedScore
      || snapshot?.referenceMarketRestoration != null
      || stableJsonStringifyV1(JSON.parse(preImage.components)) !== stableJsonStringifyV1(review.repairedComponents)) {
      return { blocker: `legacy-psi-preimage-mismatch:${day}` };
    }

    const events = await loadPsiEligibleDepegEvents(db, { startDay: day, endDay: day, excludedIds: [...REVIEWED_IDS] });
    const archives = await loadHistoricalPsiArchives(db, day, day);
    const allEvents = [...events, ...review.removedEvents];
    const references = await loadHistoricalPsiReferences(db, allEvents, day, day, coingeckoApiKey);
    const sampleSlots = (await loadHistoricalPsiSampleSlots(db, day, day)).get(day);
    const { results: samplePreImages } = await db.prepare(`SELECT stored_at, score, band, components, input_snapshot,
      methodology_version FROM stability_index_samples WHERE stored_at >= ? AND stored_at < ? ORDER BY stored_at`)
      .bind(day, day + DAY_SECONDS).all<{ stored_at: number; score: number }>();
    const referenceEvidence = [...allEvents].sort((a, b) => a.id - b.id).map((row) => {
      const currency = getPegTaxonomyByType(row.peg_type)?.currency;
      const referenceClocks = [...new Set([row.started_at, ...(archives.supplyByCoin.get(row.stablecoin_id) ?? [])
        .flatMap((snapshot) => snapshot.priceObservedAt == null ? [] : [snapshot.priceObservedAt])])].sort((a, b) => a - b);
      return [row.id, currency == null ? [] : referenceClocks.flatMap((at) => {
        const mark = references?.referenceAt(currency, at, row.stablecoin_id);
        return mark ? [[at, mark]] : [];
      })];
    });
    const input = {
      day, events: [...events].sort((left, right) => left.id - right.id),
      methodologyVersion: preImage.methodology_version, snapshot,
      supplyByCoin: [...archives.supplyByCoin].sort(([left], [right]) => left.localeCompare(right)),
      dewsByDay: [...archives.dewsByDay].sort(([left], [right]) => left - right).map(([date, rows]) => [date, [...rows].sort((a, b) => a.stablecoin_id.localeCompare(b.stablecoin_id))]),
      referenceEvidence, sampleSlots: sampleSlots ?? [], samplePreImages,
    };
    if (sha256Hex(stableJsonStringifyV1(input)) !== review.inputHash) {
      return { blocker: `legacy-psi-input-drift:${day}` };
    }
    const restored = review.removedEvents.find(({ id }) => id === event.id);
    if (!restored || restored.stablecoin_id !== event.stablecoinId || restored.started_at !== event.startedAt
      || restored.ended_at !== event.endedAt || restored.start_price !== event.startPrice
      || restored.peg_reference !== event.pegReference || restored.peak_deviation_bps !== event.peakDeviationBps) {
      return { blocker: `legacy-psi-restoration-identity-mismatch:${event.id}` };
    }
    const replay = (depegEvents: readonly PsiDepegEventRow[]) => replayHistoricalPsiForDay({
      day, now: review.replayAt, methodologyVersion: review.replayMethodologyVersion, depegEvents: [...depegEvents], ...archives,
      references, sampleSlots,
    });
    const before = replay(allEvents);
    const after = replay(events);
    const isolated = replay([...events, { ...restored, disposition: "restored-evidenced" }]);
    const restoration = before.result && after.result && isolated.result
      ? verifyReviewedPsiDelta(review, legacy, before.result, after.result, isolated.result) : null;
    if (!restoration) {
      return { blocker: `legacy-psi-reviewed-delta-mismatch:${day}` };
    }
    const sampleScores: Record<number, number> = {};
    if ((sampleSlots?.length ?? 0) !== samplePreImages.length) return { blocker: `psi-sample-preimage-drift:${day}` };
    for (const [index, sample] of samplePreImages.entries()) {
      const replacement = isolated.sampleScores?.[sample.stored_at];
      if (sample.stored_at !== sampleSlots?.[index] || before.sampleScores?.[sample.stored_at] !== sample.score ||
          after.sampleScores?.[sample.stored_at] == null || replacement == null || replacement < 0 || replacement > 100) {
        return { blocker: `psi-sample-correction-unverified:${sample.stored_at}` };
      }
      sampleScores[sample.stored_at] = replacement;
    }
    result.push({ preImage, day, ...restoration, delta: review.delta.score, eventId: event.id, sampleScores, samplePreImages });
  }
  return { result };
}

function coverageWrites(db: D1Database, { preImage, disposition, admittedCoverage }: CoverageChange) {
  return [
    db.prepare(`INSERT INTO depeg_events (stablecoin_id) SELECT NULL WHERE NOT EXISTS (
      SELECT 1 FROM depeg_events WHERE id = ? AND disposition IS NULL AND admitted_coverage_json IS NULL
        AND stablecoin_id = ? AND started_at = ? AND ended_at = ? AND start_price = ? AND peg_reference = ?
        AND peak_deviation_bps = ? AND recovery_price IS ? AND close_reason IS ? AND price_coverage_json IS ?
        AND last_trusted_price_at IS ? AND price_coverage_gap_started_at IS ?
        AND confirmation_sources IS ? AND pending_reason IS ? AND recovery_peg_reference IS ?
        ${preImage.peer_basis_json === undefined ? "" : "AND peer_basis_json IS ?"})`)
      .bind(preImage.id, preImage.stablecoin_id, preImage.started_at, preImage.ended_at, preImage.start_price,
        preImage.peg_reference, preImage.peak_deviation_bps, preImage.recovery_price, preImage.close_reason ?? null,
        preImage.price_coverage_json ?? null, preImage.last_trusted_price_at ?? null, preImage.price_coverage_gap_started_at ?? null,
        preImage.confirmation_sources ?? null, preImage.pending_reason ?? null, preImage.recovery_peg_reference ?? null,
        ...(preImage.peer_basis_json === undefined ? [] : [preImage.peer_basis_json])),
    db.prepare("UPDATE depeg_events SET disposition = ?, admitted_coverage_json = ? WHERE id = ?")
      .bind(disposition, admittedCoverage == null ? null : JSON.stringify(admittedCoverage), preImage.id),
  ];
}

type PsiReversal = NonNullable<Awaited<ReturnType<typeof planPsiReversal>>["result"]>[number];

export function psiReversalWrites(db: D1Database, reversal: PsiReversal, now: number) {
  const { preImage, score, components, delta, eventId, sampleScores, samplePreImages } = reversal;
  const marker = JSON.stringify({ version: REPAIR_VERSION, eventId, delta, repairedAt: now });
  const sampleMarker = samplePreImages.length === 0 ? null : JSON.stringify({ method: "samples", sampleScores });
  return [
    db.prepare(`INSERT INTO stability_index (computed_at, score, band, components, input_snapshot)
      SELECT NULL, NULL, NULL, NULL, NULL WHERE NOT EXISTS (
        SELECT 1 FROM stability_index WHERE id = ? AND computed_at = ? AND score = ? AND band = ?
          AND components = ? AND input_snapshot = ? AND methodology_version = ?)
        OR (SELECT count(*) FROM stability_index_samples WHERE stored_at >= ? AND stored_at < ?) != json_array_length(?)
        OR EXISTS (
          SELECT 1 FROM json_each(?) expected LEFT JOIN stability_index_samples s
            ON s.stored_at = json_extract(expected.value, '$.stored_at')
          WHERE s.stored_at IS NULL OR s.score IS NOT json_extract(expected.value, '$.score')
            OR s.band IS NOT json_extract(expected.value, '$.band')
            OR s.components IS NOT json_extract(expected.value, '$.components')
            OR s.input_snapshot IS NOT json_extract(expected.value, '$.input_snapshot')
            OR s.methodology_version IS NOT json_extract(expected.value, '$.methodology_version'))`)
      .bind(preImage.id, preImage.computed_at, preImage.score, preImage.band, preImage.components,
        preImage.input_snapshot, preImage.methodology_version, reversal.day, reversal.day + DAY_SECONDS,
        JSON.stringify(samplePreImages), JSON.stringify(samplePreImages)),
    db.prepare(`UPDATE stability_index SET score = ?2, band = ?3, components = ?4,
      input_snapshot = json_set(CASE WHEN ?1 IS NULL THEN input_snapshot ELSE
        json_set(input_snapshot, '$.referenceMarketRepair',
          json_patch(json_extract(input_snapshot, '$.referenceMarketRepair'), json(?1))) END,
        '$.referenceMarketRestoration', json(?5)) WHERE id = ?6`)
      .bind(sampleMarker, score, getConditionBand(score), JSON.stringify(components), marker, preImage.id),
  ];
}

export async function handleRepairReferenceMarketArtifacts(
  { db, url, coingeckoApiKey = null }: { db: D1Database; url: URL; request?: Request; coingeckoApiKey?: string | null },
  reviewedReaderRevision = REVIEWED_READER_REVISION,
): Promise<Response> {
  const dryRun = url.searchParams.get("dry-run") !== "false";
  const bookmark = url.searchParams.get("time-travel-bookmark")?.trim() || null;
  if (!dryRun && bookmark == null) {
    return jsonResponse({ error: "time-travel-bookmark-required" }, { status: 400 });
  }
  const limit = dryRun ? Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "5", 10) || 5)) : 1;
  const afterReopen = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
  const now = Math.floor(Date.now() / 1000);
  const groups = await loadClosureGroups(db, afterReopen);
  const page = groups.slice(0, limit);
  const tapeByReopen = await loadPageTapePreimages(db, page);
  const results = [];
  for (const [reopen, group] of page) {
    const tape = tapeByReopen.get(reopen) ?? [];
    const statements = group.coverage.flatMap((change) => coverageWrites(db, change));
    if (tape.length > 0) {
      const preimages = JSON.stringify(tape.map(({ preImage }) => preImage));
      statements.push(
        db.prepare(`INSERT INTO tape_events (event_id) SELECT NULL WHERE EXISTS (
          SELECT 1 FROM json_each(?) expected LEFT JOIN tape_events t ON t.id = json_extract(expected.value, '$.id')
           WHERE t.id IS NULL OR t.suppressed_at IS NOT NULL
             OR t.event_id IS NOT json_extract(expected.value, '$.event_id')
             OR t.source_table IS NOT json_extract(expected.value, '$.source_table')
             OR t.source_row_id IS NOT json_extract(expected.value, '$.source_row_id')
             OR t.transition IS NOT json_extract(expected.value, '$.transition')
             OR t.ts IS NOT json_extract(expected.value, '$.ts')
             OR t.ends_at IS NOT json_extract(expected.value, '$.ends_at')
             OR t.title IS NOT json_extract(expected.value, '$.title')
             OR t.summary IS NOT json_extract(expected.value, '$.summary')
             OR t.payload_json IS NOT json_extract(expected.value, '$.payload_json'))`)
          .bind(preimages),
      );
      const suppressed = tape.filter(({ clearEnd }) => !clearEnd).map(({ preImage }) => preImage.id);
      const clearEnds = tape.filter(({ clearEnd }) => clearEnd).map(({ preImage }) => preImage.id);
      if (suppressed.length > 0) statements.push(
        db.prepare(`UPDATE tape_events SET suppressed_at = ?, suppression_reason = ? WHERE id IN (
          SELECT value FROM json_each(?))`).bind(now, DEPEG_CLAIM_RETRACTED_REASON, JSON.stringify(suppressed)),
      );
      if (clearEnds.length > 0) statements.push(
        db.prepare(`UPDATE tape_events SET ends_at = NULL, payload_json = json_set(payload_json, '$.endedAt', NULL)
          WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(clearEnds)),
      );
    }
    const reversals: PsiReversal[] = [];
    const blockers = [...group.blockers];
    if (!dryRun && !reviewedReaderRevision) blockers.push("repair-reader-integration-unverified");
    for (const restoration of group.restorations) {
      const reversal = await planPsiReversal(db, restoration, coingeckoApiKey);
      if (reversal.result == null) blockers.push(reversal.blocker);
      else {
        reversals.push(...reversal.result);
        statements.push(restorationWrite(db, restoration), ...reversal.result.flatMap((row) => psiReversalWrites(db, row, now)));
      }
    }
    if (statements.length > D1_BATCH_SIZE) blockers.push(`exceeds-atomic-batch:${statements.length}`);
    if (!dryRun && blockers.length === 0) await executeAtomicBatch(db, statements);
    results.push({
      reopen, status: blockers.length > 0 ? "blocked" : dryRun ? "planned" : "applied", blockers,
      coverage: group.coverage,
      tape,
      restored: group.restorations.map(({ event, archive }) => ({ event, archive, preImage: null, disposition: "restored-evidenced" })),
      days: reversals,
    });
  }
  return jsonResponse({
    dryRun, bookmark, reviewedReaderRevision, version: REPAIR_VERSION, limit, closuresWithChanges: groups.length,
    processed: results.length, results,
  }, { status: !dryRun && results.some((result) => result.status === "blocked") ? 409 : 200 });
}
