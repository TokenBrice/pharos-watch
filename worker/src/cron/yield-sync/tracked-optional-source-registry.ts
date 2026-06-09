import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildOnChainSourceKey } from "../yield-helpers";
import {
  fetchBimaSusbdSource,
  fetchBprotocolLqtyOnlySource,
  fetchCurveScrvusdCurrentRateSource,
  fetchEtherfuseCetesSource,
  fetchHashnoteUsycSource,
  fetchOndoUsdyOracleSource,
  fetchZephyrZysSource,
} from "./sources";
import { fetchMidasMmevNavOracleSource } from "./midas-mmev-nav-oracle";
import { runTimedOptionalSource } from "./optional-source-runtime";
import type { ResolvedYield } from "./types";
import type { ChainRpcConfig } from "../../lib/chain-registry";

const LIQUITY_V1_LUSD_ID = "lusd-liquity";
const SCRVUSD_CURVE_ID = "scrvusd-curve";
const BIMA_USBD_ID = "usbd-bima";
const CETES_ETHERFUSE_ID = "cetes-etherfuse";
const HASHNOTE_USYC_ID = "usyc-hashnote";
const MIDAS_MMEV_ID = "mmev-midas";
const ONDO_USDY_ID = "usdy-ondo-finance";
const ZEPHYR_ZYS_ID = "zys-zephyr-protocol";
const MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY = "protocol-api:midas-mmev-nav-oracle";
const SCRVUSD_CURRENT_RATE_SOURCE_KEY = "onchain:scrvusd-curve:scrvusd-current-rate";

export interface TrackedOptionalSourceContext {
  db: D1Database;
  startSec: number;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
}

interface TrackedOptionalSourceEntry {
  stablecoinId: string;
  sourceKey: string;
  run: (context: TrackedOptionalSourceContext) => Promise<ResolvedYield | null>;
}

export async function loadOndoOracleAnchorRow(
  db: D1Database,
  startSec: number,
): Promise<{ exchange_rate: number; recorded_at: number } | null> {
  const preferredPriorRow = await db
    .prepare(
      `SELECT /* pharos:yield-sync:ondo-prior-anchor-preferred */
         exchange_rate, recorded_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = 'protocol-api:ondo-usdy-oracle'
         AND exchange_rate IS NOT NULL
         AND recorded_at <= ?
         AND recorded_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(ONDO_USDY_ID, startSec - 7 * DAY_SECONDS, startSec - 45 * DAY_SECONDS)
    .first<{ exchange_rate: number; recorded_at: number }>();

  if (preferredPriorRow) return preferredPriorRow;

  return db
    .prepare(
      `SELECT /* pharos:yield-sync:ondo-prior-anchor-fallback */
         exchange_rate, recorded_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = 'protocol-api:ondo-usdy-oracle'
         AND exchange_rate IS NOT NULL
         AND recorded_at <= ?
         AND recorded_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(ONDO_USDY_ID, startSec - 3 * DAY_SECONDS, startSec - 14 * DAY_SECONDS)
    .first<{ exchange_rate: number; recorded_at: number }>();
}

async function loadMidasMmevOracleAnchorRow(
  db: D1Database,
  startSec: number,
): Promise<{ exchange_rate: number; recorded_at: number } | null> {
  return db
    .prepare(
      `SELECT /* pharos:yield-sync:midas-mmev-prior-anchor */
         exchange_rate, recorded_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND recorded_at <= ?
         AND recorded_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(MIDAS_MMEV_ID, MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY, startSec - 7 * DAY_SECONDS, startSec - 45 * DAY_SECONDS)
    .first<{ exchange_rate: number; recorded_at: number }>();
}

const TRACKED_OPTIONAL_SOURCE_REGISTRY: TrackedOptionalSourceEntry[] = [
  {
    stablecoinId: SCRVUSD_CURVE_ID,
    sourceKey: SCRVUSD_CURRENT_RATE_SOURCE_KEY,
    run: (context) =>
      runTimedOptionalSource(
        "Curve scrvUSD current-rate source",
        context.signal,
        (budgetSignal) => fetchCurveScrvusdCurrentRateSource(
          context.startSec,
          budgetSignal,
          context.chainRpcs,
        ),
        null,
      ),
  },
  {
    stablecoinId: BIMA_USBD_ID,
    sourceKey: "protocol-api:bima-susbd",
    run: (context) =>
      runTimedOptionalSource(
        "BIMA sUSBD source",
        context.signal,
        (budgetSignal) => fetchBimaSusbdSource(budgetSignal),
        null,
      ),
  },
  {
    stablecoinId: CETES_ETHERFUSE_ID,
    sourceKey: "protocol-api:etherfuse-cetes-current-issuance",
    run: (context) =>
      runTimedOptionalSource(
        "Etherfuse CETES current-issuance source",
        context.signal,
        (budgetSignal) => fetchEtherfuseCetesSource(budgetSignal),
        null,
      ),
  },
  {
    stablecoinId: HASHNOTE_USYC_ID,
    sourceKey: "protocol-api:hashnote-usyc",
    run: (context) =>
      runTimedOptionalSource(
        "Hashnote USYC source",
        context.signal,
        (budgetSignal) => fetchHashnoteUsycSource(budgetSignal),
        null,
      ),
  },
  {
    stablecoinId: ONDO_USDY_ID,
    sourceKey: "protocol-api:ondo-usdy-oracle",
    run: async (context) => {
      const anchorRow = await loadOndoOracleAnchorRow(context.db, context.startSec);
      const prevPriceBigint = anchorRow?.exchange_rate
        ? BigInt(Math.round(anchorRow.exchange_rate * 1e18))
        : null;
      const daysDelta = anchorRow ? (context.startSec - anchorRow.recorded_at) / DAY_SECONDS : 0;

      return runTimedOptionalSource(
        "Ondo USDY oracle source",
        context.signal,
        (budgetSignal) => fetchOndoUsdyOracleSource(
          prevPriceBigint,
          daysDelta,
          anchorRow?.recorded_at ?? null,
          budgetSignal,
          context.chainRpcs,
        ),
        null,
      );
    },
  },
  {
    stablecoinId: MIDAS_MMEV_ID,
    sourceKey: MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY,
    run: async (context) => {
      const anchorRow = await loadMidasMmevOracleAnchorRow(context.db, context.startSec);
      const daysDelta = anchorRow ? (context.startSec - anchorRow.recorded_at) / DAY_SECONDS : 0;

      const candidate = await runTimedOptionalSource(
        "Midas mMEV NAV oracle source",
        context.signal,
        (budgetSignal) => fetchMidasMmevNavOracleSource({
          prevExchangeRate: anchorRow?.exchange_rate ?? null,
          daysDelta,
          comparisonAnchorObservedAt: anchorRow?.recorded_at ?? null,
          signal: budgetSignal,
          chainRpcs: context.chainRpcs,
        }),
        null,
      );
      return candidate?.yield ?? null;
    },
  },
  {
    stablecoinId: ZEPHYR_ZYS_ID,
    sourceKey: "protocol-api:zys-zephyr-protocol",
    run: (context) =>
      runTimedOptionalSource(
        "Zephyr ZYS source",
        context.signal,
        (budgetSignal) => fetchZephyrZysSource(budgetSignal),
        null,
      ),
  },
] as const;

export const TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID = new Map<string, TrackedOptionalSourceEntry[]>();
for (const entry of TRACKED_OPTIONAL_SOURCE_REGISTRY) {
  const list = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get(entry.stablecoinId) ?? [];
  list.push(entry);
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.set(entry.stablecoinId, list);
}

export const STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: readonly TrackedOptionalSourceEntry[] = [
  {
    stablecoinId: LIQUITY_V1_LUSD_ID,
    sourceKey: buildOnChainSourceKey(LIQUITY_V1_LUSD_ID),
    run: (context) =>
      runTimedOptionalSource(
        "B.Protocol LQTY-only source",
        context.signal,
        (budgetSignal) => fetchBprotocolLqtyOnlySource(
          budgetSignal,
          context.chainRpcs,
          context.coingeckoApiKey,
        ),
        null,
      ),
  },
];
