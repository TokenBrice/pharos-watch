import type { ReserveRisk, ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  computeUnknownExposurePct,
  decimalNumberFromBigInt,
  fetchJsonPostWithRetry,
  fetchJsonWithRetry,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  slicesFromValues,
} from "./helpers";
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
  };
}

interface UsddHistoryResponse {
  code?: number;
  data?: {
    items?: Array<{
      statisticTime?: number;
    }>;
  };
}

const USDD_HISTORY_INTERVAL = "WEEKLY";
const USDD_UNKNOWN_VAULT_SLICE_NAME = "Unknown / unmapped collateral vaults";

type BucketValue = {
  name: string;
  value: number;
  risk: ReserveRisk;
  coinId?: string;
  depType?: ReserveSlice["depType"];
};

function assertSuccess<T extends { code?: number }>(payload: T, label: string): T {
  if (payload.code !== 0) {
    throw new Error(`${label} returned code ${String(payload.code)}`);
  }
  return payload;
}

export function buildUsddHistoryUrl(latestUrl: string): string {
  const latest = new URL(latestUrl);
  const history = new URL(latest.toString());
  history.pathname = latest.pathname.endsWith("/latest-collateral")
    ? latest.pathname.replace(/\/latest-collateral$/, "/collateral-history")
    : "/data-platform/collateral-history";
  history.search = "";
  history.searchParams.set("interval", USDD_HISTORY_INTERVAL);
  const chain = latest.searchParams.get("chain");
  if (chain) {
    history.searchParams.set("chain", chain);
  }
  return history.toString();
}

function createUnknownVaultWarning(
  unknownVaultTypes: Iterable<string>,
  unknownExposurePct: number,
): LiveReserveWarning {
  return buildUnknownExposureWarning({
    code: "unknown-vault-type",
    message: `USDD collateral feed includes unmapped vault types: ${Array.from(unknownVaultTypes).sort().join(", ")}`,
    unknownExposurePct,
  });
}

export function adaptUsddLatestCollateral(
  latest: UsddLatestCollateralResponse,
  history?: UsddHistoryResponse,
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

  for (const item of items) {
    const lockedValue = Number(item.lockedValue ?? 0);
    if (!Number.isFinite(lockedValue) || lockedValue <= 0) continue;
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

  const historyItems = history ? (assertSuccess(history, "usdd collateral history").data?.items ?? []) : [];
  // statisticTime may be a millisecond epoch; parseTimestampLikeToUnixSeconds auto-detects the unit.
  const statisticTimeRaw = historyItems.reduce<number | null>((latestPoint, item) => {
    if (typeof item.statisticTime !== "number" || !Number.isFinite(item.statisticTime)) {
      return latestPoint;
    }
    return latestPoint == null || item.statisticTime > latestPoint
      ? item.statisticTime
      : latestPoint;
  }, null);

  const bucketSlices: BucketValue[] = [
    {
      name: "Smart Allocator (stablecoin DeFi via Aave/JustLend)",
      value: bucketValues.smartAllocatorUsd,
      risk: "medium",
    },
    {
      name: "USDT (PSM vaults)",
      value: bucketValues.psmUsdtUsd,
      risk: "low",
      coinId: "usdt-tether",
      depType: "collateral",
    },
    {
      name: "TRX",
      value: bucketValues.trxUsd,
      risk: "high",
    },
    {
      name: "USDT (direct vaults)",
      value: bucketValues.directUsdtUsd,
      risk: "high",
      coinId: "usdt-tether",
    },
    {
      name: "sTRX (direct vaults)",
      value: bucketValues.stakedTrxUsd,
      risk: "high",
    },
    ...(unknownVaultUsd > 0
      ? [{
          name: USDD_UNKNOWN_VAULT_SLICE_NAME,
          value: unknownVaultUsd,
          risk: "high" as const,
        }]
      : []),
  ];
  const unknownExposurePct = computeUnknownExposurePct(unknownVaultUsd, totalVaultUsd);
  const warnings: LiveReserveWarning[] = unknownVaultTypes.size > 0
    ? [createUnknownVaultWarning(unknownVaultTypes, unknownExposurePct)]
    : [];
  const stableRedeemableUsd = bucketValues.psmUsdtUsd + bucketValues.directUsdtUsd;
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(statisticTimeRaw);

  return {
    slices: slicesFromValues(bucketSlices.sort((left, right) => right.value - left.value)),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      vaultCount: items.length,
      trackedVaultCount: 5,
      ...(unknownVaultCount > 0 ? { unknownVaultCount } : {}),
      ...(unknownVaultTypes.size > 0 ? { unknownVaultTypes: Array.from(unknownVaultTypes).sort() } : {}),
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      ...(sourceTimestamp != null
        ? {
            sourceTimestamp,
            freshnessMode: "verified" as const,
          }
        : {
            freshnessMode: "unverified" as const,
            details: {
              freshnessSource: "collateral-history",
              freshnessReason: "history timestamp unavailable",
            },
          }),
      stableVaultUsd: stableRedeemableUsd,
    },
  };
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
 * One TronGrid constant-contract read, returning the first result word or null
 * when the address is malformed or the contract reverts. Callers fold every
 * null into the same withhold-the-route decision.
 */
async function readTronWord(
  contractBase58: string,
  functionSelector: string,
  parameter: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string | null> {
  const contractHex = await tronBase58ToHex(contractBase58);
  if (!contractHex) return null;

  const headers: Record<string, string> = {};
  if (ctx?.trongridApiKey) headers["TRON-PRO-API-KEY"] = ctx.trongridApiKey;

  const json = await fetchJsonPostWithRetry<TronConstantContractResponse>(
    TRON_CONSTANT_CONTRACT_URL,
    {
      owner_address: TRON_ZERO_OWNER_ADDRESS_HEX41,
      contract_address: `41${contractHex.slice(2)}`,
      function_selector: functionSelector,
      parameter,
      visible: false,
    },
    signal,
    10_000,
    ctx,
    { headers },
  );

  if (json.result?.result !== true) return null;
  const word = json.constant_result?.[0];
  return typeof word === "string" && word.length === TRON_WORD_HEX_LENGTH && /^[0-9a-f]+$/i.test(word)
    ? word.toLowerCase()
    : null;
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
 * Same-run TronGrid reads of the USDD PSM's identity, buy switch, exit fee and
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
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInputFromConfig(config, "usdd-data-platform");
  const timeout = 12_000;
  const historyUrl = buildUsddHistoryUrl(input.url);
  const [latest, history] = await Promise.all([
    fetchJsonWithRetry<UsddLatestCollateralResponse>(input.url, signal, timeout, ctx),
    fetchJsonWithRetry<UsddHistoryResponse>(historyUrl, signal, timeout, ctx),
  ]);
  const adapted = adaptUsddLatestCollateral(latest, history);

  // Sequenced after the collateral fetches so the PSM's reads never widen this
  // adapter's peak connection count beyond the cron trigger's shared pool.
  const psm = isTronCollateralFeed(input.url) ? await probeUsddTronPsm(signal, ctx) : null;
  if (psm == null) return adapted;

  return {
    ...adapted,
    metadata: {
      ...adapted.metadata,
      psmGemJoinBalanceRaw: psm.capacityRaw,
      immediateRedeemableUsd: psm.capacityUsd,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: psm.capacityUsd,
        capacityKind: "live-direct",
        freshnessKind: "same-run-onchain",
        routeStatus: psm.buyEnabled ? "open" : "paused",
        routeStatusSource: "onchain",
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
