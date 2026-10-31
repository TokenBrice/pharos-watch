import type { ReserveRisk, ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  decimalNumberFromBigInt,
  fetchJsonPostWithRetry,
  fetchJsonWithRetry,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  slicesFromValues,
} from "./helpers";
import { verifiedFreshnessMetadata } from "./freshness";
import { rethrowIfAborted } from "../../lib/abort";
import { tronBase58ToHex } from "../../lib/tron-address";

interface UsddCollateralItem {
  lockedValue?: number;
  vaultType?: string;
}

interface UsddLatestCollateralResponse {
  code?: number;
  data?: {
    items?: UsddCollateralItem[];
    totalCollateralValue?: number;
    totalSupplyValue?: number;
  };
}

interface UsddCollateralHistoryItem {
  collateralValue?: number;
  totalSupplyValue?: number;
  statisticTime?: number;
}

interface UsddCollateralHistoryResponse {
  code?: number;
  data?: {
    items?: UsddCollateralHistoryItem[];
  };
}

const USDD_HISTORY_LOOKBACK_MS = 86_400_000;
// The history join only upgrades freshness, so it gets one short attempt and
// leaves the adapter deadline to the PSM reads that follow it.
const USDD_HISTORY_TIMEOUT_MS = 5_000;

const USDD_UNKNOWN_VAULT_SLICE_NAME = "Unknown / unmapped collateral vaults";

type BucketValue = {
  name: string;
  value: number;
  risk: ReserveRisk;
  sourceKey?: string;
  coinId?: string;
  depType?: ReserveSlice["depType"];
};

function assertSuccess<T extends { code?: number }>(payload: T, label: string): T {
  if (payload.code !== 0) {
    throw new Error(`${label} returned code ${String(payload.code)}`);
  }
  return payload;
}

function createUnknownVaultWarning(
  unknownVaultTypes: Iterable<string>,
  unknownExposurePct: number,
): LiveReserveWarning {
  return buildUnknownExposureWarning({ adapterKey: "usdd-data-platform", code: "unknown-vault-type",
  message: `USDD collateral feed includes unmapped vault types: ${Array.from(unknownVaultTypes).sort().join(", ")}`,
  unknownExposurePct, });
}

// Vault rows are published to the cent, so the itemized book may differ from
// the headline total by at most one cent of rounding per row.
const USDD_RECONCILIATION_TOLERANCE_USD_PER_ROW = 0.01;

interface UsddCollateralReconciliation {
  itemizedUsd: number;
  headlineUsd: number;
  reconciled: boolean;
}

/**
 * Reconciles the itemized vault book against latest-collateral's headline
 * `totalCollateralValue`. Returns null when the headline is absent or not a
 * finite positive number (nothing to reconcile against). Only a reconciled
 * book may borrow the collateral-history clock, which dates the headline.
 */
export function reconcileUsddItemizedCollateral(
  latest: UsddLatestCollateralResponse,
): UsddCollateralReconciliation | null {
  const headlineUsd = latest.data?.totalCollateralValue;
  if (typeof headlineUsd !== "number" || !Number.isFinite(headlineUsd) || headlineUsd <= 0) return null;
  const items = latest.data?.items ?? [];
  let itemizedUsd = 0;
  for (const item of items) {
    if (typeof item.lockedValue !== "number" || !Number.isFinite(item.lockedValue)) return null;
    itemizedUsd += item.lockedValue;
  }
  const toleranceUsd = USDD_RECONCILIATION_TOLERANCE_USD_PER_ROW * Math.max(1, items.length);
  return { itemizedUsd, headlineUsd, reconciled: Math.abs(itemizedUsd - headlineUsd) <= toleranceUsd };
}

/**
 * Combine the issuer's per-chain latest-collateral feeds into the whole-coin
 * book. Every configured chain is required: a missing feed fails the read
 * rather than publishing the surviving chain as a whole-book composition. A
 * chain without a usable headline leaves the combined headline undefined so
 * neither reconciliation nor the history clock can borrow a partial total.
 */
export function mergeUsddCollateralFeeds(
  feeds: UsddLatestCollateralResponse[],
): UsddLatestCollateralResponse {
  if (feeds.length === 0) throw new Error("usdd-data-platform: no collateral feeds configured");
  const items: UsddCollateralItem[] = [];
  let totalCollateralValue: number | undefined = 0;
  let totalSupplyValue: number | undefined = 0;
  for (const feed of feeds) {
    assertSuccess(feed, "usdd latest collateral");
    items.push(...(feed.data?.items ?? []));
    const collateral = feed.data?.totalCollateralValue;
    const supply = feed.data?.totalSupplyValue;
    totalCollateralValue = totalCollateralValue != null
      && typeof collateral === "number" && Number.isFinite(collateral)
      ? totalCollateralValue + collateral
      : undefined;
    totalSupplyValue = totalSupplyValue != null
      && typeof supply === "number" && Number.isFinite(supply)
      ? totalSupplyValue + supply
      : undefined;
  }
  return {
    code: 0,
    data: {
      items,
      ...(totalCollateralValue != null ? { totalCollateralValue } : {}),
      ...(totalSupplyValue != null ? { totalSupplyValue } : {}),
    },
  };
}

export function adaptUsddLatestCollateral(
  latest: UsddLatestCollateralResponse,
): AdapterResult {
  const items = assertSuccess(latest, "usdd latest collateral").data?.items ?? [];

  const bucketValues = {
    smartAllocatorUsd: 0,
    psmUsdtUsd: 0,
    trxUsd: 0,
    directUsdtUsd: 0,
    stakedTrxUsd: 0,
  };
  const unknownVaultTypes = new Set<string>();
  let unknownVaultCount = 0;
  let unknownVaultUsd = 0;
  let totalVaultUsd = 0;

  for (const [index, item] of items.entries()) {
    const lockedValue = item.lockedValue;
    if (typeof lockedValue !== "number" || !Number.isFinite(lockedValue) || lockedValue < 0) {
      throw new Error(`usdd-data-platform: collateral item ${index} lockedValue is missing or invalid`);
    }
    if (lockedValue === 0) continue;
    totalVaultUsd += lockedValue;
    switch (item.vaultType) {
      case "SA001-A":
        bucketValues.smartAllocatorUsd += lockedValue;
        break;
      case "PSM-USDT-A":
        bucketValues.psmUsdtUsd += lockedValue;
        break;
      case "TRX-A":
      case "TRX-B":
      case "TRX-C":
        bucketValues.trxUsd += lockedValue;
        break;
      case "USDT-A":
        bucketValues.directUsdtUsd += lockedValue;
        break;
      case "STRX-A":
        bucketValues.stakedTrxUsd += lockedValue;
        break;
      default:
        unknownVaultCount += 1;
        unknownVaultUsd += lockedValue;
        unknownVaultTypes.add(
          typeof item.vaultType === "string" && item.vaultType.trim().length > 0
            ? item.vaultType.trim()
            : "unknown",
        );
        break;
    }
  }

  const bucketSlices: BucketValue[] = [
    {
      name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)",
      value: bucketValues.smartAllocatorUsd,
      risk: "medium",
      sourceKey: "usdd-data-platform:smart-allocator",
    },
    {
      name: "USDT (PSM vaults)",
      value: bucketValues.psmUsdtUsd,
      risk: "low",
      sourceKey: "usdd-data-platform:psm-usdt",
      coinId: "usdt-tether",
      depType: "collateral",
    },
    {
      name: "TRX",
      value: bucketValues.trxUsd,
      risk: "high",
      sourceKey: "usdd-data-platform:trx",
    },
    {
      name: "USDT (direct vaults)",
      value: bucketValues.directUsdtUsd,
      risk: "high",
      sourceKey: "usdd-data-platform:direct-usdt",
      coinId: "usdt-tether",
      depType: "collateral",
    },
    {
      name: "sTRX (direct vaults)",
      value: bucketValues.stakedTrxUsd,
      risk: "high",
      sourceKey: "usdd-data-platform:staked-trx",
    },
    ...(unknownVaultUsd > 0
      ? [{
          name: USDD_UNKNOWN_VAULT_SLICE_NAME,
          value: unknownVaultUsd,
          risk: "high" as const,
          sourceKey: "usdd-data-platform:unknown",
        }]
      : []),
  ];
  const unknownExposurePct = computeUnknownExposurePct(unknownVaultUsd, totalVaultUsd);
  const warnings: LiveReserveWarning[] = unknownVaultTypes.size > 0
    ? [createUnknownVaultWarning(unknownVaultTypes, unknownExposurePct)]
    : [];
  const reconciliation = reconcileUsddItemizedCollateral(latest);
  if (reconciliation && !reconciliation.reconciled) {
    warnings.push(reserveDegradedWarning(
      "itemized-collateral-mismatch",
      `USDD itemized vault collateral $${reconciliation.itemizedUsd.toFixed(2)} does not reconcile with the headline totalCollateralValue $${reconciliation.headlineUsd.toFixed(2)}`,
    ));
  }
  const stableRedeemableUsd = bucketValues.psmUsdtUsd + bucketValues.directUsdtUsd;

  return {
    slices: slicesFromValues(bucketSlices.sort((left, right) => right.value - left.value)),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      vaultCount: items.length,
      trackedVaultCount: 5,
      ...(unknownVaultCount > 0 ? { unknownVaultCount } : {}),
      ...(unknownVaultTypes.size > 0 ? { unknownVaultTypes: Array.from(unknownVaultTypes).sort() } : {}),
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      freshnessMode: "unverified" as const,
      details: {
        freshnessSource: "latest-collateral",
        freshnessReason: "composition timestamp unavailable; collateral-history is not joined to this snapshot",
      },
      stableVaultUsd: stableRedeemableUsd,
      ...(reconciliation
        ? {
          itemizedCollateralUsd: reconciliation.itemizedUsd,
          headlineCollateralUsd: reconciliation.headlineUsd,
          itemizedCollateralReconciled: reconciliation.reconciled,
        }
        : {}),
    },
  };
}

/**
 * latest-collateral carries no timestamp, but collateral-history's open
 * bucket reports the same live aggregates. When a history row's
 * collateralValue and totalSupplyValue both equal latest-collateral's, the
 * snapshot is dated by that row's statisticTime: the bucket's UTC+8 day
 * start, which is conservative because the state was observed after it.
 * Returns seconds, or null when no row matches exactly.
 */
export function matchUsddCollateralHistoryTimestamp(
  latest: UsddLatestCollateralResponse,
  history: UsddCollateralHistoryResponse,
  nowSec: number,
): number | null {
  const collateralValue = latest.data?.totalCollateralValue;
  const totalSupplyValue = latest.data?.totalSupplyValue;
  if (typeof collateralValue !== "number" || typeof totalSupplyValue !== "number") return null;
  if (history.code !== 0) return null;

  let matchedSec: number | null = null;
  for (const item of history.data?.items ?? []) {
    if (item.collateralValue !== collateralValue || item.totalSupplyValue !== totalSupplyValue) continue;
    const statisticTime = item.statisticTime;
    if (typeof statisticTime !== "number" || !Number.isSafeInteger(statisticTime) || statisticTime <= 0) continue;
    const statisticSec = Math.floor(statisticTime / 1000);
    if (statisticSec > nowSec) continue;
    if (matchedSec == null || statisticSec > matchedSec) matchedSec = statisticSec;
  }
  return matchedSec;
}

function buildUsddCollateralHistoryUrl(latestUrl: string, nowMs: number): string | null {
  let url: URL;
  try {
    url = new URL(latestUrl);
  } catch {
    return null;
  }
  if (!url.pathname.endsWith("/latest-collateral")) return null;
  url.pathname = url.pathname.replace(/\/latest-collateral$/, "/collateral-history");
  url.searchParams.set("startTime", String(nowMs - USDD_HISTORY_LOOKBACK_MS));
  url.searchParams.set("endTime", String(nowMs));
  return url.toString();
}

async function fetchUsddCollateralHistoryTimestamp(
  latestUrl: string,
  latest: UsddLatestCollateralResponse,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<number | null> {
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const historyUrl = buildUsddCollateralHistoryUrl(latestUrl, nowSec * 1000);
  if (historyUrl == null) return null;
  try {
    const history = await fetchJsonWithRetry<UsddCollateralHistoryResponse>(
      historyUrl, signal, USDD_HISTORY_TIMEOUT_MS, ctx, { maxRetries: 0 },
    );
    return matchUsddCollateralHistoryTimestamp(latest, history, nowSec);
  } catch (error) {
    // Only the parent's cancellation propagates; a history timeout or failure
    // falls back to the unverified composition.
    if (signal.aborted) rethrowIfAborted(error, signal);
    return null;
  }
}

// Tron mainnet USDD v2 PSM-USDT. buyGem() burns USDD and settles the USDT leg
// with gemJoin.exit(), so the GemJoin's own USDT balance — not the wider USDD
// collateral feed, which counts TRX vaults and Smart Allocator positions — is
// the executable USDD -> USDT exit bound.
// https://github.com/decentralized-usd/psm/blob/main/src/psm.sol
const USDD_PSM_ADDRESS = "TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz";
// The pinned GemJoin only describes the modeled route while the PSM's own
// gemJoin()/usdd() still resolve here, so an identity mismatch fails closed.
const USDD_PSM_GEM_JOIN_ADDRESS = "TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ";
const USDD_PSM_USDD_ADDRESS = "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz";
const USDD_PSM_GEM_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDD_PSM_GEM_DECIMALS = 6;
const USDD_PSM_DOC_URL = "https://docs.usdd.io/user-guide/psm-peg-stability-module";
const USDD_PSM_MAX_FEE_BPS = 10_000;
// tout is a WAD-scaled exit fee (fee = gemAmt18 * tout / 1e18), so one basis
// point of fee is 1e14 in WAD units.
const USDD_PSM_WAD_PER_BPS = 1e14;

const TRON_CONSTANT_CONTRACT_URL = "https://api.trongrid.io/wallet/triggerconstantcontract";
// Tron's constant-contract call requires a well-formed owner_address even for
// reads that never inspect msg.sender; the zero address is the standard filler.
const TRON_ZERO_OWNER_ADDRESS_HEX41 = "410000000000000000000000000000000000000000";
const TRON_WORD_HEX_LENGTH = 64;

interface TronConstantContractResponse {
  result?: { result?: boolean };
  constant_result?: string[];
}

/**
 * One supported constant-contract read, preferring admitted Dwellir to TronGrid.
 * Returns null when the address is malformed or the contract reverts. Callers fold every
 * null into the same withhold-the-route decision.
 */
async function readTronWord(
  contractBase58: string,
  functionSelector: string,
  parameter: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string | null> {
  if (ctx?.observedBlock?.chain === "tron") return null;
  const contractHex = await tronBase58ToHex(contractBase58);
  if (!contractHex) return null;

  const headers: Record<string, string> = {};
  if (ctx?.trongridApiKey) headers["TRON-PRO-API-KEY"] = ctx.trongridApiKey;

  const request = {
    owner_address: TRON_ZERO_OWNER_ADDRESS_HEX41,
    contract_address: `41${contractHex.slice(2)}`,
    function_selector: functionSelector,
    parameter,
    visible: false,
  };
  for (const provider of ctx?.dwellirNative ? ["dwellir", "trongrid"] : ["trongrid"]) {
    try {
      const json = provider === "dwellir"
        ? await ctx!.dwellirNative!.readJson<TronConstantContractResponse>(
          "tron", "/wallet/triggerconstantcontract", signal, ctx, request,
        )
        : await fetchJsonPostWithRetry<TronConstantContractResponse>(
          TRON_CONSTANT_CONTRACT_URL, request, signal, 10_000, ctx, { headers },
        );
      if (json.result?.result !== true) continue;
      const word = json.constant_result?.[0];
      if (typeof word === "string" && word.length === TRON_WORD_HEX_LENGTH && /^[0-9a-f]+$/i.test(word)) {
        return word.toLowerCase();
      }
    } catch (error) {
      rethrowIfAborted(error, signal);
    }
  }
  return null;
}

function decodeTronWordUint(word: string | null): bigint | null {
  return word == null ? null : BigInt(`0x${word}`);
}

function decodeTronWordAddress(word: string | null): string | null {
  return word == null ? null : `0x${word.slice(24)}`;
}

interface UsddPsmProbe {
  capacityUsd: number;
  capacityRaw: string;
  feeBps: number;
  buyEnabled: boolean;
}

/**
 * Same-run constant reads of the USDD PSM's identity, buy switch, exit fee and
 * paying USDT balance. Any failed, reverted or malformed read resolves to null
 * so the caller withholds redemption telemetry rather than publishing an
 * unproven route.
 */
async function probeUsddTronPsm(signal: AbortSignal, ctx?: AdapterContext): Promise<UsddPsmProbe | null> {
  const gemJoinHex = await tronBase58ToHex(USDD_PSM_GEM_JOIN_ADDRESS);
  if (!gemJoinHex) return null;

  try {
    const [gemJoinWord, usddWord, buyEnabledWord, toutWord, balanceWord] = await Promise.all([
      readTronWord(USDD_PSM_ADDRESS, "gemJoin()", "", signal, ctx),
      readTronWord(USDD_PSM_ADDRESS, "usdd()", "", signal, ctx),
      readTronWord(USDD_PSM_ADDRESS, "buyEnabled()", "", signal, ctx),
      readTronWord(USDD_PSM_ADDRESS, "tout()", "", signal, ctx),
      readTronWord(
        USDD_PSM_GEM_ADDRESS,
        "balanceOf(address)",
        gemJoinHex.slice(2).padStart(TRON_WORD_HEX_LENGTH, "0"),
        signal,
        ctx,
      ),
    ]);

    if (decodeTronWordAddress(gemJoinWord) !== gemJoinHex) return null;
    if (decodeTronWordAddress(usddWord) !== (await tronBase58ToHex(USDD_PSM_USDD_ADDRESS))) return null;

    const buyEnabledRaw = decodeTronWordUint(buyEnabledWord);
    if (buyEnabledRaw == null || buyEnabledRaw > 1n) return null;

    const toutRaw = decodeTronWordUint(toutWord);
    if (toutRaw == null) return null;
    const feeBps = Number(toutRaw) / USDD_PSM_WAD_PER_BPS;
    if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > USDD_PSM_MAX_FEE_BPS) return null;

    const balanceRaw = decodeTronWordUint(balanceWord);
    if (balanceRaw == null) return null;
    const capacityUsd = decimalNumberFromBigInt(balanceRaw, USDD_PSM_GEM_DECIMALS);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

    return {
      capacityUsd,
      capacityRaw: balanceRaw.toString(),
      feeBps,
      buyEnabled: buyEnabledRaw === 1n,
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

/**
 * The PSM this adapter reads lives on Tron, so the route only describes a run
 * whose collateral feed is the Tron chain view.
 */
function isTronCollateralFeed(url: string): boolean {
  try {
    return new URL(url).searchParams.get("chain") === "tron";
  } catch {
    return false;
  }
}

export async function fetchUsddDataPlatformReserves(
  _coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "usdd-data-platform");
  const params = parseLiveReserveAdapterParams("usdd-data-platform", config.params);
  const timeout = 12_000;
  const feedUrls = [input.url, ...(params.additionalCollateralUrls ?? [])];
  const feeds = await Promise.all(
    feedUrls.map((url) => fetchJsonWithRetry<UsddLatestCollateralResponse>(url, signal, timeout, ctx)),
  );
  const latest = mergeUsddCollateralFeeds(feeds);
  const composition = adaptUsddLatestCollateral(latest);
  // Sequenced after the collateral fetch so the history join never widens
  // this adapter's peak connection count.
  // The history row dates one chain's headline totals only. An aggregated
  // whole-coin book therefore cannot borrow a per-chain history clock, and a
  // single-feed book still needs its itemized total to reconcile first.
  const historySourceTimestamp = feedUrls.length === 1 && reconcileUsddItemizedCollateral(latest)?.reconciled === true
    ? await fetchUsddCollateralHistoryTimestamp(input.url, latest, signal, ctx)
    : null;
  const adapted: AdapterResult = historySourceTimestamp == null
    ? composition
    : {
      ...composition,
      metadata: {
        ...composition.metadata,
        ...verifiedFreshnessMetadata(historySourceTimestamp),
        details: {
          freshnessSource: "collateral-history",
          freshnessReason: "latest-collateral totals equal a collateral-history row; dated by its UTC+8 bucket start (statisticTime)",
        },
      },
    };

  // Sequenced after the collateral fetch so the PSM's reads never widen this
  // adapter's peak connection count beyond the cron trigger's shared pool.
  const psm = isTronCollateralFeed(input.url) ? await probeUsddTronPsm(signal, ctx) : null;
  if (psm == null) return adapted;

  return {
    ...adapted,
    metadata: {
      ...adapted.metadata,
      psmGemJoinBalanceRaw: psm.capacityRaw,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: psm.capacityUsd,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: psm.buyEnabled ? "open" : "paused",
        routeStatusSource: "onchain",
        routeObserved: true,
        routeStatusReason: psm.buyEnabled
          ? `USDD PSM ${USDD_PSM_ADDRESS} read in the same run: gemJoin() is ${USDD_PSM_GEM_JOIN_ADDRESS}, usdd() is ${USDD_PSM_USDD_ADDRESS}, buyEnabled() is 1, tout() is ${psm.feeBps} bps, and USDT balanceOf(gemJoin) is ${psm.capacityRaw} (6 decimals)`
          : `USDD PSM ${USDD_PSM_ADDRESS} buyEnabled() returned 0 in the same run, so the USDD -> USDT exit is disabled`,
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: psm.feeBps,
        sourceUrls: [USDD_PSM_DOC_URL],
      }),
    },
  };
}
