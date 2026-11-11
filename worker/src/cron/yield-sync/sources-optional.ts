import { DAY_SECONDS } from "@shared/lib/time-constants";
import { OPTIONAL_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
import { type ChainRpcConfig } from "../../lib/chain-registry";
import { fetchZephyrZysSource } from "../../lib/yield-source-adapters/zephyr";
import { runTimedOptionalSource } from "./sources-rpc";
import type { ResolvedYield } from "./types";

import { loadMidasMmevOracleAnchorRow, loadOndoOracleAnchorRow } from "./optional-nav-history";
import {
  fetchHashnoteUsycSource,
  fetchMidasMmevNavOracleSource,
  fetchOndoUsdyOracleSource,
  fetchReProtocolReusdSource,
} from "./sources-optional-nav";
import {
  BASEDOLLAR_SP_CONFIG,
  fetchBprotocolLqtyOnlySource,
  fetchCurveScrvusdCurrentRateSource,
  fetchLiquityV2StabilityPoolSource,
  LIQUITY_V2_SP_CONFIG,
} from "./sources-optional-onchain";
import { fetchYearnYboldSource } from "./sources-optional-vaults";
export interface TrackedOptionalSourceContext {
  db: D1Database;
  startSec: number;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
  /** B15 — forwarded to `runTimedOptionalSource` so a swallowed failure reaches run metadata. */
  onOutcome?: (outcome: { label: string; outcome: "failed" | "timeout" }) => void;
}

interface TrackedOptionalSourceEntry {
  stablecoinId: string;
  sourceKey: string;
  /**
   * B15 — set only when the entry's coin is deliberately not in
   * `ACTIVE_YIELD_BEARING_STABLECOINS`, so the registry cannot silently strand a
   * source behind a coin that will never be iterated. Absent means "must be active".
   */
  intendedDormant?: string;
  run: (context: TrackedOptionalSourceContext) => Promise<ResolvedYield | null>;
}

const OPTIONAL_SOURCE_READERS = {
  scrvusd: (signal, context) => fetchCurveScrvusdCurrentRateSource(context.startSec, signal, context.chainRpcs),
  lusd: (signal, context) => fetchBprotocolLqtyOnlySource(context.startSec, signal, context.chainRpcs, context.coingeckoApiKey),
  baseDollar: (signal, context) => fetchLiquityV2StabilityPoolSource(context.startSec, BASEDOLLAR_SP_CONFIG, signal, context.chainRpcs),
  bold: (signal, context) => fetchLiquityV2StabilityPoolSource(context.startSec, LIQUITY_V2_SP_CONFIG, signal, context.chainRpcs),
  ybold: (signal) => fetchYearnYboldSource(signal),
  hashnote: (signal) => fetchHashnoteUsycSource(signal),
  midas: async (signal, context) => {
    const candidate = await fetchMidasMmevNavOracleSource({
      loadAnchor: async (observedAt) => {
        const anchor = await loadMidasMmevOracleAnchorRow(context.db, observedAt);
        return anchor?.source_observed_at != null
          ? { exchangeRate: anchor.exchange_rate, observedAt: anchor.source_observed_at } : null;
      },
      nowSec: context.startSec,
      signal,
      chainRpcs: context.chainRpcs,
    });
    return candidate?.yield ?? null;
  },
  ondo: async (signal, context) => {
    const anchorRow = await loadOndoOracleAnchorRow(context.db, context.startSec);
    const daysDelta = anchorRow ? (context.startSec - anchorRow.recorded_at) / DAY_SECONDS : 0;
    return fetchOndoUsdyOracleSource(
      anchorRow?.exchange_rate ?? null,
      daysDelta,
      anchorRow?.recorded_at ?? null,
      signal,
      context.chainRpcs,
    );
  },
  re: (signal) => fetchReProtocolReusdSource(signal),
  zephyr: (signal) => fetchZephyrZysSource(signal),
} satisfies Record<keyof typeof OPTIONAL_YIELD_SOURCES,
  (signal: AbortSignal, context: TrackedOptionalSourceContext) => Promise<ResolvedYield | null>>;

const orderedSources = Object.entries(OPTIONAL_YIELD_SOURCES)
  .map(([key, source]) => ({ ...source, key: key as keyof typeof OPTIONAL_YIELD_SOURCES }))
  .sort((a, b) => a.dispatchOrder - b.dispatchOrder);

function attachOptionalSource(source: typeof orderedSources[number]): TrackedOptionalSourceEntry {
  return {
    stablecoinId: source.stablecoinId,
    sourceKey: source.sourceKey,
    intendedDormant: undefined,
    run: (context) => runTimedOptionalSource(
      source.timeoutLabel,
      context.signal,
      (signal) => OPTIONAL_SOURCE_READERS[source.key](signal, context),
      null,
      context.onOutcome,
    ),
  };
}

export const TRACKED_OPTIONAL_SOURCE_REGISTRY = orderedSources
  .filter((source) => !source.standalone).map(attachOptionalSource);

export const TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID = new Map<string, TrackedOptionalSourceEntry[]>();
for (const entry of TRACKED_OPTIONAL_SOURCE_REGISTRY) {
  const list = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get(entry.stablecoinId) ?? [];
  list.push(entry);
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.set(entry.stablecoinId, list);
}

export const STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: readonly TrackedOptionalSourceEntry[] = orderedSources
  .filter((source) => source.standalone).map(attachOptionalSource);
