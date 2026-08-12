import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import {
  accumulateBucketedExposure,
  decimalNumberFromBigInt,
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  makeOnchainCallers,
  parseTimestampLikeToUnixSeconds,
  requireJsonInputFromConfig,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
} from "./helpers";
import { parseEvmAddressResult } from "./evm";
import { rethrowIfAborted } from "../../lib/abort";

export interface FirmMarket {
  name: string;
  underlying: { symbol: string };
  totalDebt: number;
  borrowPaused: boolean;
}

interface FirmMarketsResponse {
  markets: FirmMarket[];
  timestamp: number | string;
}

type DolaBucket = "stablecoin" | "eth-lst" | "btc" | "governance" | "other";

const STABLECOIN_ASSETS = new Set(["sUSDe", "sUSDS", "DAI", "USDC", "USDT", "crvUSD", "scrvUSD", "FRAX", "PYUSD", "USR", "wstUSR", "FraxPyUSD lp", "DOLA-FRAXBP"]);
const ETH_LST_ASSETS = new Set(["WETH", "wstETH", "stETH", "rETH", "weETH", "cbETH"]);
const BTC_ASSETS = new Set(["WBTC", "cbBTC", "tBTC"]);
const GOVERNANCE_ASSETS = new Set(["INV", "CRV", "CVX", "cvxCRV", "st-yCRV", "cvxFXS"]);
const TRACKED_STABLECOIN_ASSETS: Partial<Record<string, { coinId: string; risk: ReserveSlice["risk"] }>> = {
  sUSDe: { coinId: "susde-ethena", risk: "high" },
  sUSDS: { coinId: "susds-sky", risk: "low" },
  DAI: { coinId: "dai-makerdao", risk: "low" },
  USDC: { coinId: "usdc-circle", risk: "low" },
  USDT: { coinId: "usdt-tether", risk: "low" },
  crvUSD: { coinId: "crvusd-curve", risk: "medium" },
  scrvUSD: { coinId: "scrvusd-curve", risk: "medium" },
  FRAX: { coinId: "frax-frax", risk: "low" },
  PYUSD: { coinId: "pyusd-paypal", risk: "low" },
  USR: { coinId: "usr-resolv", risk: "high" },
};

function getTrackedStablecoinAsset(symbol: string): { coinId: string; risk: ReserveSlice["risk"] } | undefined {
  if (!Object.prototype.hasOwnProperty.call(TRACKED_STABLECOIN_ASSETS, symbol)) return undefined;
  return TRACKED_STABLECOIN_ASSETS[symbol];
}

const KNOWN_ASSETS = new Set([...STABLECOIN_ASSETS, ...ETH_LST_ASSETS, ...BTC_ASSETS, ...GOVERNANCE_ASSETS]);

export function bucketForAsset(symbol: string): DolaBucket {
  if (STABLECOIN_ASSETS.has(symbol)) return "stablecoin";
  if (ETH_LST_ASSETS.has(symbol)) return "eth-lst";
  if (BTC_ASSETS.has(symbol)) return "btc";
  if (GOVERNANCE_ASSETS.has(symbol)) return "governance";
  return "other";
}

/** Resolve the base asset symbol from compound names like "DOLA-sUSDe clp" or "yv-DOLA-sUSDS". */
export function resolveBaseSymbol(market: FirmMarket): string {
  const sym = market.underlying.symbol;

  // Yearn vault wrappers: "yv-DOLA-sUSDe" → "sUSDe", "yv-sDOLA-scrvUSD" → "scrvUSD"
  if (sym.startsWith("yv-")) {
    const rest = sym.slice(3);
    if (rest.startsWith("DOLA-")) return rest.slice(5);
    if (rest.startsWith("sDOLA-")) return rest.slice(6);
    return rest;
  }

  // Curve LP tokens: "DOLA-sUSDe clp" → "sUSDe", "DOLA-wstUSR clp" → "wstUSR"
  if (sym.startsWith("DOLA-") && (sym.endsWith(" clp") || sym.endsWith(" lp"))) {
    const inner = sym.slice(5, sym.lastIndexOf(" "));
    if (inner) return inner;
  }

  // FraxPyUSD LP: "yv-DOLA-FraxPyUSD lp" already handled by yv-match above
  return sym;
}

export function adaptFirmMarkets(payload: FirmMarketsResponse): AdapterResult {
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.timestamp);
  const {
    bucketTotals,
    totalValue: totalDebt,
    unknownValue: unknownDebt,
  } = accumulateBucketedExposure({
    items: payload.markets,
    getValue: (market) => market.totalDebt,
    getBucket: (market) => {
      const symbol = resolveBaseSymbol(market);
      if (getTrackedStablecoinAsset(symbol)) return "stablecoin";
      return bucketForAsset(symbol);
    },
    isUnknown: (market) => !KNOWN_ASSETS.has(resolveBaseSymbol(market)),
  });
  const trackedStableValues = new Map<string, number>();
  for (const market of payload.markets) {
    const value = market.totalDebt;
    if (!Number.isFinite(value) || value <= 0) continue;
    const symbol = resolveBaseSymbol(market);
    if (!getTrackedStablecoinAsset(symbol)) continue;
    trackedStableValues.set(symbol, (trackedStableValues.get(symbol) ?? 0) + value);
  }
  const trackedStableTotal = Array.from(trackedStableValues.values()).reduce((sum, value) => sum + value, 0);

  const slices = slicesFromValues([
    ...Array.from(trackedStableValues, ([symbol, value]) => {
      const config = getTrackedStablecoinAsset(symbol)!;
      return {
        name: `${symbol} collateral`,
        value,
        risk: config.risk,
        coinId: config.coinId,
        depType: "collateral" as const,
      };
    }),
    {
      name: "Other stablecoin collateral",
      value: Math.max(0, (bucketTotals.get("stablecoin") ?? 0) - trackedStableTotal),
      risk: getCanonicalReserveAssetRisk("sUSDe") ?? "low",
    },
    {
      name: "ETH / Liquid staking (wstETH, WETH)",
      value: bucketTotals.get("eth-lst") ?? 0,
      risk: getCanonicalReserveAssetRisk("wstETH") ?? "low",
    },
    {
      name: "BTC (WBTC, cbBTC)",
      value: bucketTotals.get("btc") ?? 0,
      risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium",
    },
    {
      name: "Governance tokens (INV, CRV, CVX)",
      value: bucketTotals.get("governance") ?? 0,
      risk: "very-high",
    },
    {
      name: "Other collateral",
      value: bucketTotals.get("other") ?? 0,
      risk: "high",
    },
  ]);

  const activeMarkets = payload.markets.filter((m) => m.totalDebt > 0).length;

  return {
    slices,
    metadata: {
      activeMarkets,
      totalMarkets: payload.markets.length,
      timestamp: sourceTimestamp,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "firm-markets-api",
        "FiRM markets payload did not expose a trustworthy source timestamp",
      ),
      unknownExposurePct: totalDebt > 0 ? (unknownDebt / totalDebt) * 100 : 0,
    },
  };
}

export function listUnexpectedDolaAssets(payload: FirmMarketsResponse): string[] {
  return Array.from(
    accumulateBucketedExposure({
      items: payload.markets,
      getValue: (market) => market.totalDebt,
      getBucket: (market) => bucketForAsset(resolveBaseSymbol(market)),
      isUnknown: (market) => !KNOWN_ASSETS.has(resolveBaseSymbol(market)),
      getUnknownKey: (market) => resolveBaseSymbol(market),
    }).unknownValuesByKey.keys(),
  );
}

// Inverse's DOLA/USDS Peg Stability Module. Deployed 2025-08-10 and drained
// since 2025-12-10 — lifetime usage is two test sells totalling ~$55 — so a
// same-run read is the only honest capacity source for this route.
// https://etherscan.io/address/0x4dfd662622d766304cb539e66f893c4defa19398
const INVERSE_PSM_ADDRESS = "0x4dfd662622d766304cb539e66f893c4defa19398";
// Pinned identities the PSM's immutable/derived getters must still resolve to;
// any mismatch means the pinned route no longer describes this contract.
const INVERSE_PSM_VAULT_ADDRESS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd"; // sUSDS
const INVERSE_PSM_COLLATERAL_ADDRESS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f"; // USDS
const INVERSE_PSM_DOLA_ADDRESS = "0x865377367054516e17014ccded1e7d814edc9ce4"; // DOLA
const INVERSE_PSM_DECIMALS = 18;
const INVERSE_PSM_BPS_DENOMINATOR = 10_000;
const INVERSE_PSM_DOC_URL =
  "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module";

// supply() / vault() / collateral() / DOLA() / sellFeeBps()
const PSM_SUPPLY_SELECTOR = "0x047fc9aa";
const PSM_VAULT_SELECTOR = "0xfbfa77cf";
const PSM_COLLATERAL_SELECTOR = "0xd8dfeb45";
const PSM_DOLA_SELECTOR = "0x92c592d0";
const PSM_SELL_FEE_BPS_SELECTOR = "0x23cbe1f3";
// ERC-4626 maxWithdraw(address) on the sUSDS vault
const VAULT_MAX_WITHDRAW_SELECTOR = "0xce96cb77";

function encodeAddressArg(selector: string, address: string): string {
  return `${selector}${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

interface InversePsmProbe {
  capacityUsd: number;
  supplyRaw: string;
  vaultWithdrawableRaw: string;
}

/**
 * Same-run read of the PSM's DOLA -> USDS exit capacity. `sell()` decrements
 * `supply` before calling `vault.withdraw()`, so both legs bind: capacity is the
 * lower of the PSM's own accounted supply and what the sUSDS vault will actually
 * pay it. Returns `null` when any read fails or an identity no longer matches,
 * so the caller withholds the whole redemption surface rather than publishing an
 * unproven route.
 */
async function probeInversePsm(signal: AbortSignal, ctx?: AdapterContext): Promise<InversePsmProbe | null> {
  const onchain = makeOnchainCallers({ chain: "ethereum" }, { signal, ctx });
  try {
    const [vaultHex, collateralHex, dolaHex, supplyRaw, maxWithdrawRaw] = await Promise.all([
      onchain.raw(INVERSE_PSM_ADDRESS, PSM_VAULT_SELECTOR),
      onchain.raw(INVERSE_PSM_ADDRESS, PSM_COLLATERAL_SELECTOR),
      onchain.raw(INVERSE_PSM_ADDRESS, PSM_DOLA_SELECTOR),
      onchain.uint256(INVERSE_PSM_ADDRESS, PSM_SUPPLY_SELECTOR),
      onchain.uint256(
        INVERSE_PSM_VAULT_ADDRESS,
        encodeAddressArg(VAULT_MAX_WITHDRAW_SELECTOR, INVERSE_PSM_ADDRESS),
      ),
    ]);

    const vault = vaultHex ? parseEvmAddressResult(vaultHex as `0x${string}`) : null;
    const collateral = collateralHex ? parseEvmAddressResult(collateralHex as `0x${string}`) : null;
    const dola = dolaHex ? parseEvmAddressResult(dolaHex as `0x${string}`) : null;
    if (vault !== INVERSE_PSM_VAULT_ADDRESS) return null;
    if (collateral !== INVERSE_PSM_COLLATERAL_ADDRESS) return null;
    if (dola !== INVERSE_PSM_DOLA_ADDRESS) return null;

    if (supplyRaw == null || supplyRaw < 0n) return null;
    if (maxWithdrawRaw == null || maxWithdrawRaw < 0n) return null;

    const bindingRaw = supplyRaw < maxWithdrawRaw ? supplyRaw : maxWithdrawRaw;
    const capacityUsd = decimalNumberFromBigInt(bindingRaw, INVERSE_PSM_DECIMALS);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

    return {
      capacityUsd,
      supplyRaw: supplyRaw.toString(),
      vaultWithdrawableRaw: maxWithdrawRaw.toString(),
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

/**
 * Same-run read of the DOLA -> USDS sell fee, in basis points. The getter is
 * already denominated in bps and is gov-settable, so a failed read falls back to
 * the reviewed cost model instead of publishing a fee this run could not observe.
 */
async function probeInversePsmSellFeeBps(signal: AbortSignal, ctx?: AdapterContext): Promise<number | null> {
  const onchain = makeOnchainCallers({ chain: "ethereum" }, { signal, ctx });
  try {
    const raw = await onchain.uint256(INVERSE_PSM_ADDRESS, PSM_SELL_FEE_BPS_SELECTOR);
    if (raw == null || raw < 0n || raw > BigInt(INVERSE_PSM_BPS_DENOMINATOR)) return null;
    return Number(raw);
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

export async function fetchDolaInverseReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireJsonInputFromConfig(config, "dola-inverse");
  const [payload, psm, sellFeeBps] = await Promise.all([
    fetchJsonAdapterInput<FirmMarketsResponse>(config, "dola-inverse", signal, 12_000, ctx),
    probeInversePsm(signal, ctx),
    probeInversePsmSellFeeBps(signal, ctx),
  ]);
  const adapted = adaptFirmMarkets(payload);
  const warnings: LiveReserveWarning[] = listUnexpectedDolaAssets(payload).map((asset) => reserveDegradedWarning(
    "unknown-asset",
    `DOLA FiRM asset bucketed into other: ${asset}`,
  ));
  if (psm == null) {
    warnings.push(
      reserveInfoWarning(
        "dola-psm-unreadable",
        `Inverse PSM ${INVERSE_PSM_ADDRESS} did not return a matching vault()/collateral()/DOLA()/supply() set this run; redemption telemetry withheld`,
      ),
    );
  }

  return {
    ...adapted,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...adapted.metadata,
      ...(psm != null
        ? {
            psmSupplyRaw: psm.supplyRaw,
            psmVaultWithdrawableRaw: psm.vaultWithdrawableRaw,
            redemption: {
              capacityUsd: psm.capacityUsd,
              capacityKind: "live-direct" as const,
              freshnessKind: "same-run-onchain" as const,
              holderEligibility: "any-holder" as const,
              settlementDelaySec: 0,
              // The PSM exposes no pause surface and its Controller is a
              // permissive stub, so an empty PSM is not a paused one. Zero
              // measured capacity is no evidence of an open route either, so
              // openness is asserted only when the route can actually pay out.
              ...(psm.capacityUsd > 0
                ? {
                    routeStatus: "open" as const,
                    routeStatusSource: "onchain" as const,
                    routeStatusReason: `Inverse PSM ${INVERSE_PSM_ADDRESS} read in the same run: vault() is sUSDS, collateral() is USDS, supply() is ${psm.supplyRaw} and sUSDS maxWithdraw() is ${psm.vaultWithdrawableRaw} (18 decimals)`,
                  }
                : {}),
              ...(sellFeeBps != null ? { feeBps: sellFeeBps } : {}),
              sourceUrls: [primaryInput.url, INVERSE_PSM_DOC_URL],
            },
          }
        : {}),
    },
  };
}
