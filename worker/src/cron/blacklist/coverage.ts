import { BLACKLIST_DERIVED_GENERATION_KEY, BLACKLIST_EVENT_COVERAGE_KEY, BLACKLIST_EVENT_COVERAGE_PROGRESS_KEY } from "../../lib/blacklist-cache-keys";
import { CONTRACT_CONFIGS } from "../../lib/blacklist-contracts";
import { fetchEvmBlockHeader } from "../../lib/evm-rpc";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "../../lib/blacklist/run-budget";
import { includeActiveTrackedIds } from "../shared/exclude-frozen";
import { getBlacklistCoverageRosterFingerprint } from "../weekly-recap/blacklist";
import type { BlacklistConfigScanSummary } from "./config-scan";
import { z } from "zod";
import { tryParseJson } from "../../lib/json-parse";

const CursorSpanSchema = z.object({
  fromCursor: z.number().int().positive(),
  toCursor: z.number().int().positive(),
});
const CoverageProgressSchema = z.object({
  generation: z.string().nullable(),
  rosterFingerprint: z.string(),
  spans: z.record(z.string(), CursorSpanSchema),
});

/** Intersect all materialized scan intervals after checking their finalized event-time bounds. */
export async function publishBlacklistEventCoverage(
  db: D1Database,
  scan: Pick<BlacklistConfigScanSummary, "committedScans" | "configStates">,
  generation: string | null,
  budget: BlacklistRunBudget,
  chainRpcs?: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
): Promise<void> {
  if (blacklistRuntimeBudgetReached(budget) || !Object.keys(scan.committedScans).length) return;
  const rosterFingerprint = getBlacklistCoverageRosterFingerprint();
  const states = includeActiveTrackedIds(scan.configStates, (state) => state.config.stablecoinId);
  const roster = includeActiveTrackedIds(CONTRACT_CONFIGS, (config) => config.stablecoinId);
  if (new Set(states.map((state) => state.configKey)).size !== roster.length ||
    roster.some((config) => !states.some((state) => state.configKey === config.configKey))) return;
  const old = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(BLACKLIST_EVENT_COVERAGE_PROGRESS_KEY)
    .first<string>("value");
  const prior = CoverageProgressSchema.safeParse(tryParseJson(old)).data;
  const spans = prior?.generation === generation && prior.rosterFingerprint === rosterFingerprint ? { ...prior.spans } : {};
  for (const state of states) {
    const { configKey, cursorValue } = state;
    const previous = spans[configKey];
    if (previous && previous.toCursor > cursorValue) delete spans[configKey];
    const committed = scan.committedScans[configKey];
    if (!committed) continue;
    const contiguous = previous?.toCursor === committed.fromCursor;
    spans[configKey] = { fromCursor: contiguous ? previous.fromCursor : committed.fromCursor, toCursor: committed.toCursor };
  }

  const now = Math.floor(Date.now() / 1000);
  const headers = new Map<string, Awaited<ReturnType<typeof fetchEvmBlockHeader>>>();
  const readHeader = async (chainId: string, selector: number | "finalized") => {
    const key = `${chainId}:${selector}`;
    if (headers.has(key)) return headers.get(key) ?? null;
    if (blacklistRuntimeBudgetReached(budget) || blacklistSubrequestBudgetReached(budget)) return null;
    const header = await fetchEvmBlockHeader(chainId, selector, {
      chainRpcs, signal, deadlineMs: budget.deadlineMs, maxRetries: 0, excludeSupplementalRpc: true,
      beforeRequest: () => {
        if (blacklistSubrequestBudgetReached(budget)) return false;
        budget.subrequestBudget.count++;
        return true;
      },
    });
    headers.set(key, header);
    return header;
  };
  let headerUnavailable = false;
  let start = 0;
  let end = Number.POSITIVE_INFINITY;
  if (states.length > 0 && states.every(({ configKey }) => spans[configKey] != null)) {
    // Identical boundaries across configs on the same EVM chain share the exact header reads.
    const bounds = new Map<string, { fromCursor: number; toCursor: number; tron: boolean }>();
    for (const { configKey, config, cursorKind } of states) {
      const span = spans[configKey];
      const chainId = config.chain.chainId;
      const aggregate = bounds.get(chainId);
      bounds.set(chainId, { tron: cursorKind === "tron_timestamp_ms",
        fromCursor: Math.max(aggregate?.fromCursor ?? 0, span.fromCursor),
        toCursor: Math.min(aggregate?.toCursor ?? Infinity, span.toCursor) });
    }
    for (const [chainId, span] of bounds) {
      if (span.tron) {
        start = Math.max(start, Math.ceil(span.fromCursor / 1_000));
        end = Math.min(end, Math.floor(span.toCursor / 1_000));
        continue;
      }
      const finalized = await readHeader(chainId, "finalized");
      if (!finalized) { headerUnavailable = true; end = 0; break; }
      const upper = Math.min(finalized.number, span.toCursor);
      if (upper <= span.fromCursor) { end = 0; break; }
      const first = await readHeader(chainId, span.fromCursor + 1);
      const last = upper === finalized.number ? finalized : await readHeader(chainId, upper);
      if (!first || !last) { headerUnavailable = true; end = 0; break; }
      if (first.timestamp > last.timestamp || finalized.timestamp > now || last.timestamp > now) { end = 0; break; }
      // Exclude a boundary second that could be shared with an unscanned block.
      start = Math.max(start, first.timestamp + 1);
      end = Math.min(end, last.timestamp);
    }
  }
  // A failed extension can retain only a receipt whose entire prior scan still fits.
  const retainsPrior = headerUnavailable && prior?.generation === generation && prior.rosterFingerprint === rosterFingerprint
    && states.every(({ configKey }) => {
      const before = prior.spans[configKey];
      const after = spans[configKey];
      return before && after && after.fromCursor <= before.fromCursor && after.toCursor >= before.toCursor;
    });
  const progress = JSON.stringify({ generation, rosterFingerprint, spans });
  const receipt = start > 0 && start < end && end <= now ? JSON.stringify({
    version: 1, generation: crypto.randomUUID(), invalidationGeneration: generation, rosterFingerprint,
    eventPeriod: { start, end },
  }) : null;
  const writeProgress = db.prepare(`/* blacklist-event-coverage-progress */ INSERT INTO cache (key, value, updated_at)
      SELECT ?, ?, ? WHERE (SELECT value FROM cache WHERE key = ?) IS ?
        AND (SELECT value FROM cache WHERE key = ?) IS ?
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) AS expected
          LEFT JOIN blacklist_sync_state AS state ON state.config_key = json_extract(expected.value, '$[0]')
          WHERE state.attempt_generation IS NOT json_extract(expected.value, '$[1]')
             OR MAX(state.last_block, COALESCE(state.cursor_value, 0)) IS NOT json_extract(expected.value, '$[2]')
        )
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(BLACKLIST_EVENT_COVERAGE_PROGRESS_KEY, progress, now, BLACKLIST_DERIVED_GENERATION_KEY, generation,
        BLACKLIST_EVENT_COVERAGE_PROGRESS_KEY, old,
        JSON.stringify(states.map((state) => [state.configKey, state.attemptGeneration, state.cursorValue])));
  if (receipt == null && retainsPrior) {
    await writeProgress.run();
    return;
  }
  await db.batch([writeProgress, receipt == null
      ? db.prepare(`DELETE FROM cache WHERE key = ? AND changes() = 1`).bind(BLACKLIST_EVENT_COVERAGE_KEY)
      : db.prepare(`/* blacklist-event-coverage-receipt */ INSERT INTO cache (key, value, updated_at)
          SELECT ?, ?, ? WHERE changes() = 1
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(BLACKLIST_EVENT_COVERAGE_KEY, receipt, now),
  ]);
}
