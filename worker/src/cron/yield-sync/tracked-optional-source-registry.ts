import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildOnChainSourceKey } from "../yield-helpers";
import {
  BASEDOLLAR_SP_CONFIG,
  LIQUITY_V2_SP_CONFIG,
  fetchBimaSusbdSource,
  fetchBprotocolLqtyOnlySource,
  fetchCurveScrvusdCurrentRateSource,
  fetchEtherfuseCetesSource,
  fetchHashnoteUsycSource,
  fetchLiquityV2StabilityPoolSource,
  fetchOndoUsdyOracleSource,
  fetchReProtocolReusdSource,
  fetchYearnYboldSource,
  fetchZephyrZysSource,
} from "./sources";
import { fetchMidasMmevNavOracleSource } from "./midas-mmev-nav-oracle";
import { runTimedOptionalSource } from "./optional-source-runtime";
import type { ResolvedYield } from "./types";
import type { ChainRpcConfig } from "../../lib/chain-registry";

const LIQUITY_V1_LUSD_ID = "lusd-liquity";
const BASEDOLLAR_BD_ID = "bd-basedollar";
const SCRVUSD_CURVE_ID = "scrvusd-curve";
const BIMA_USBD_ID = "usbd-bima";
const CETES_ETHERFUSE_ID = "cetes-etherfuse";
const HASHNOTE_USYC_ID = "usyc-hashnote";
const MIDAS_MMEV_ID = "mmev-midas";
const ONDO_USDY_ID = "usdy-ondo-finance";
const RE_REUSD_ID = "reusd-re-protocol";
const ZEPHYR_ZYS_ID = "zys-zephyr-protocol";
const YEARN_YBOLD_ID = "ybold-yearn";
const LIQUITY_V2_BOLD_ID = "bold-liquity";
const MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY = "protocol-api:midas-mmev-nav-oracle";
const ONDO_USDY_ORACLE_SOURCE_KEY = "protocol-api:ondo-usdy-oracle";
const SCRVUSD_CURRENT_RATE_SOURCE_KEY = "onchain:scrvusd-curve:scrvusd-current-rate";
const YEARN_YBOLD_SOURCE_KEY = "protocol-api:yearn:ybold";

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

type OracleAnchorRow = { exchange_rate: number; recorded_at: number };

async function loadNavOracleAnchorRow(
  db: D1Database,
  stablecoinId: string,
  sourceKey: string,
  startSec: number,
  minAgeDays: number,
  maxAgeDays: number,
): Promise<OracleAnchorRow | null> {
  const newestAllowed = startSec - minAgeDays * DAY_SECONDS;
  const oldestAllowed = startSec - maxAgeDays * DAY_SECONDS;
  const rawRow = await db
    .prepare(
      `SELECT /* pharos:yield-sync:nav-oracle-prior-anchor */
         exchange_rate, recorded_at FROM yield_history
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND recorded_at <= ?
         AND recorded_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(stablecoinId, sourceKey, newestAllowed, oldestAllowed)
    .first<OracleAnchorRow>();
  if (rawRow) return rawRow;

  // Raw history keeps `YIELD_HISTORY_RAW_DAYS` (30), but these NAV-oracle anchors
  // deliberately look back up to 45 days, so the 30–45 day band now exists only
  // in the daily tier. Reading it here keeps the documented long-horizon anchor
  // window satisfiable instead of silently narrowing it to the raw retention
  // window — which would strand a sparsely-updating NAV oracle (Midas has no
  // shorter-window fallback, unlike Ondo) once the band is pruned.
  return db
    .prepare(
      `SELECT /* pharos:yield-sync:nav-oracle-prior-anchor-daily */
         exchange_rate, recorded_at FROM yield_history_daily
       WHERE stablecoin_id = ? AND source_key = ?
         AND exchange_rate IS NOT NULL
         AND recorded_at <= ?
         AND recorded_at >= ?
         AND (publication_generation_id IS NULL OR publication_state = 'published')
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .bind(stablecoinId, sourceKey, newestAllowed, oldestAllowed)
    .first<OracleAnchorRow>();
}

export async function loadOndoOracleAnchorRow(
  db: D1Database,
  startSec: number,
): Promise<OracleAnchorRow | null> {
  const preferredPriorRow = await loadNavOracleAnchorRow(
    db,
    ONDO_USDY_ID,
    ONDO_USDY_ORACLE_SOURCE_KEY,
    startSec,
    7,
    45,
  );
  if (preferredPriorRow) return preferredPriorRow;

  return loadNavOracleAnchorRow(db, ONDO_USDY_ID, ONDO_USDY_ORACLE_SOURCE_KEY, startSec, 3, 14);
}

async function loadMidasMmevOracleAnchorRow(
  db: D1Database,
  startSec: number,
): Promise<OracleAnchorRow | null> {
  return loadNavOracleAnchorRow(db, MIDAS_MMEV_ID, MIDAS_MMEV_NAV_ORACLE_SOURCE_KEY, startSec, 7, 45);
}

/**
 * Ordinary entry shape: the registry applies the shared per-source timeout
 * policy once here instead of repeating it in every descriptor. Entries that
 * must prepare D1 anchors before the timed region (Ondo, Midas) keep a
 * bespoke `run` that opens the timer only after that preparation.
 */
function timedOptionalSourceEntry(
  stablecoinId: string,
  sourceKey: string,
  label: string,
  fetchSource: (
    budgetSignal: AbortSignal,
    context: TrackedOptionalSourceContext,
  ) => Promise<ResolvedYield | null>,
  intendedDormant?: string,
): TrackedOptionalSourceEntry {
  return {
    stablecoinId,
    sourceKey,
    intendedDormant,
    run: (context) =>
      runTimedOptionalSource(
        label,
        context.signal,
        (budgetSignal) => fetchSource(budgetSignal, context),
        null,
        context.onOutcome,
      ),
  };
}

export const TRACKED_OPTIONAL_SOURCE_REGISTRY: TrackedOptionalSourceEntry[] = [
  timedOptionalSourceEntry(
    SCRVUSD_CURVE_ID,
    SCRVUSD_CURRENT_RATE_SOURCE_KEY,
    "Curve scrvUSD current-rate source",
    (budgetSignal, context) =>
      fetchCurveScrvusdCurrentRateSource(context.startSec, budgetSignal, context.chainRpcs),
  ),
  timedOptionalSourceEntry(
    BIMA_USBD_ID,
    "protocol-api:bima-susbd",
    "BIMA sUSBD source",
    (budgetSignal) => fetchBimaSusbdSource(budgetSignal),
    // B15 — usbd-bima carries no `flags.yieldBearing`, so `sync-yield-data` never
    // iterates the coin and this adapter cannot run. Dormant by intent, not broken.
    "usbd-bima is not yieldBearing in the stablecoin registry, so the active yield cohort never resolves it",
  ),
  timedOptionalSourceEntry(
    CETES_ETHERFUSE_ID,
    "protocol-api:etherfuse-cetes-current-issuance",
    "Etherfuse CETES current-issuance source",
    (budgetSignal) => fetchEtherfuseCetesSource(budgetSignal),
    // B15 — the coin is quarantined, so it is absent from ACTIVE_YIELD_BEARING_STABLECOINS.
    "cetes-etherfuse is quarantined and therefore outside the active yield cohort",
  ),
  timedOptionalSourceEntry(
    HASHNOTE_USYC_ID,
    "protocol-api:hashnote-usyc",
    "Hashnote USYC source",
    (budgetSignal) => fetchHashnoteUsycSource(budgetSignal),
  ),
  {
    stablecoinId: ONDO_USDY_ID,
    sourceKey: ONDO_USDY_ORACLE_SOURCE_KEY,
    run: async (context) => {
      const anchorRow = await loadOndoOracleAnchorRow(context.db, context.startSec);
      const daysDelta = anchorRow ? (context.startSec - anchorRow.recorded_at) / DAY_SECONDS : 0;

      return runTimedOptionalSource(
        "Ondo USDY oracle source",
        context.signal,
        (budgetSignal) => fetchOndoUsdyOracleSource(
          anchorRow?.exchange_rate ?? null,
          daysDelta,
          anchorRow?.recorded_at ?? null,
          budgetSignal,
          context.chainRpcs,
        ),
        null,
        context.onOutcome,
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
        context.onOutcome,
      );
      return candidate?.yield ?? null;
    },
  },
  timedOptionalSourceEntry(
    RE_REUSD_ID,
    "protocol-api:re-protocol-reusd",
    "Re Protocol reUSD source",
    (budgetSignal) => fetchReProtocolReusdSource(budgetSignal),
  ),
  timedOptionalSourceEntry(
    ZEPHYR_ZYS_ID,
    "protocol-api:zys-zephyr-protocol",
    "Zephyr ZYS source",
    (budgetSignal) => fetchZephyrZysSource(budgetSignal),
  ),
  timedOptionalSourceEntry(
    YEARN_YBOLD_ID,
    YEARN_YBOLD_SOURCE_KEY,
    "Yearn yBOLD source",
    (budgetSignal) => fetchYearnYboldSource(budgetSignal),
  ),
];

export const TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID = new Map<string, TrackedOptionalSourceEntry[]>();
for (const entry of TRACKED_OPTIONAL_SOURCE_REGISTRY) {
  const list = TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.get(entry.stablecoinId) ?? [];
  list.push(entry);
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID.set(entry.stablecoinId, list);
}

export const STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: readonly TrackedOptionalSourceEntry[] = [
  timedOptionalSourceEntry(
    LIQUITY_V1_LUSD_ID,
    buildOnChainSourceKey(LIQUITY_V1_LUSD_ID),
    "B.Protocol LQTY-only source",
    (budgetSignal, context) =>
      fetchBprotocolLqtyOnlySource(context.startSec, budgetSignal, context.chainRpcs, context.coingeckoApiKey),
  ),
  timedOptionalSourceEntry(
    BASEDOLLAR_BD_ID,
    buildOnChainSourceKey(BASEDOLLAR_BD_ID),
    "Base Dollar SP interest-only source",
    (budgetSignal, context) =>
      fetchLiquityV2StabilityPoolSource(context.startSec, BASEDOLLAR_SP_CONFIG, budgetSignal, context.chainRpcs),
  ),
  timedOptionalSourceEntry(
    LIQUITY_V2_BOLD_ID,
    buildOnChainSourceKey(LIQUITY_V2_BOLD_ID),
    "Liquity V2 SP interest-only source",
    (budgetSignal, context) =>
      fetchLiquityV2StabilityPoolSource(context.startSec, LIQUITY_V2_SP_CONFIG, budgetSignal, context.chainRpcs),
  ),
];
