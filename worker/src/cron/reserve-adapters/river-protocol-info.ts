import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { encodeUint256 } from "../../lib/evm-selectors";
import { getPublicRpcUrl } from "../../lib/public-rpc-registry";
import { rethrowIfAborted } from "../../lib/abort";
import {
  buildCoverageShortfallWarnings,
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchJsonAdapterInput,
  fetchOnchainMulticall3,
  reserveDegradedWarning,
  reserveInfoWarning,
  SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC,
  summarizeSourceTimestamps,
  unverifiedFreshnessMetadata,
  verifiedFreshnessMetadata,
  type OnchainMulticall3Call,
} from "./helpers";
import { decodeAbiWordAt, decodeStrictAddressWord, decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";

interface RiverTimeseriesPoint {
  chainId?: number;
  timestamp?: string | number;
  value?: number;
}

interface RiverProtocolInfoPayload {
  tvl?: number;
  circulatingSupply?: number;
  chainCirculating?: Array<{ chain?: string; circulating?: number }>;
  tvlData?: RiverTimeseriesPoint[];
  circulatingData?: RiverTimeseriesPoint[];
}

export function adaptRiverProtocolInfo(payload: RiverProtocolInfoPayload): AdapterResult {
  const totalReserveUsd = payload.tvl;
  const supplyUsd = payload.circulatingSupply;
  if (!Number.isFinite(totalReserveUsd) || !Number.isFinite(supplyUsd) || (totalReserveUsd ?? 0) <= 0 || (supplyUsd ?? 0) <= 0) {
    throw new Error("river-protocol-info missing TVL or circulating supply");
  }
  const collateralizationRatio = (totalReserveUsd ?? 0) / (supplyUsd ?? 1);
  const warnings = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `River protocol-info TVL covers ${pct}% of circulating satUSD`,
    coverageRatio: collateralizationRatio,
  });

  const timestampSummary = summarizeSourceTimestamps([
    ...(payload.tvlData ?? []).map((point) => point.timestamp),
    ...(payload.circulatingData ?? []).map((point) => point.timestamp),
  ]);
  if (
    timestampSummary
    && timestampSummary.sourceTimestampSpreadSec > SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC
  ) {
    warnings.push(reserveDegradedWarning(
      "source-timestamp-spread",
      `River protocol-info source timestamps span ${timestampSummary.sourceTimestampSpreadSec} seconds`,
    ));
  }

  return {
    slices: [
      {
        name: "Aggregate River protocol collateral TVL",
        pct: 100,
        risk: "medium",
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...(timestampSummary
        ? {
            ...verifiedFreshnessMetadata(timestampSummary.sourceTimestamp),
            oldestSourceTimestamp: timestampSummary.sourceTimestamp,
            latestSourceTimestamp: timestampSummary.latestSourceTimestamp,
            sourceTimestampSpreadSec: timestampSummary.sourceTimestampSpreadSec,
            sourceTimestampCount: timestampSummary.timestampCount,
          }
        : unverifiedFreshnessMetadata(
            "river-protocol-info-api",
            "River protocol-info payload did not expose a trustworthy source timestamp",
          )),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio,
      chainCirculatingCount: payload.chainCirculating?.length ?? 0,
      tvlPointCount: payload.tvlData?.length ?? 0,
      circulatingPointCount: payload.circulatingData?.length ?? 0,
      sourceProvenance:
        "Aggregate TVL telemetry only. Kept proof-class until asset-level collateral composition is source-verified.",
    },
  };
}

// satUSD is a Satoshi Protocol (Liquity) fork: a holder redeems against the
// CDP troves on their own chain, so the only same-run capacity is per-chain
// trove debt. Aggregate protocol TVL is not that number — most satUSD is
// bridged or Smart-Vault-minted rather than trove-backed.
// https://docs.river.inc/products/editor/redemption
const SATOSHI_APP_BY_CHAIN: Record<string, string> = {
  ethereum: "0xb8374e4dff99202292da2fe34425e1de665b67e6",
  base: "0x9a3c724ee9603a7550499be73dc743b371811dd3",
  arbitrum: "0x07bbc5a83b83a5c440d1caedbf1081426d0aa4ec",
  bsc: "0x07bbc5a83b83a5c440d1caedbf1081426d0aa4ec",
};
// Branch enumeration is speculative because troveManagerCount() and the
// troveManagers(i) reads share one multicall; a chain that grows past this many
// branches reports a count the probe cannot cover and is dropped rather than
// silently fee-underreported.
const MAX_TROVE_MANAGERS_PER_CHAIN = 12;
const SATUSD_DEBT_DECIMALS = 18;
const RIVER_REDEMPTION_DOC_URL = "https://docs.river.inc/products/editor/redemption";
const RIVER_DEPLOYED_CONTRACTS_DOC_URL = "https://docs.river.inc/outro/deployed-contracts";

const DEBT_TOKEN_SELECTOR = "0xf8d89898"; // debtToken()
const GLOBAL_SYSTEM_BALANCES_SELECTOR = "0x716c53c2"; // getGlobalSystemBalances()
const GET_TCR_SELECTOR = "0xb620115d"; // getTCR()
const TROVE_MANAGER_COUNT_SELECTOR = "0x679df0d9"; // troveManagerCount()
const TROVE_MANAGERS_SELECTOR = "0x3b707478"; // troveManagers(uint256)
const REDEMPTION_RATE_WITH_DECAY_SELECTOR = "0xc52861f2"; // getRedemptionRateWithDecay()
const MCR_SELECTOR = "0x794e5724"; // MCR()
const SUNSETTING_SELECTOR = "0x9484fb8e"; // sunsetting()

interface RiverChainRedemption {
  chain: string;
  app: string;
  capacityUsd: number;
  totalDebtRaw: string;
  tcrRaw: string;
  troveManagerCount: number;
  feeBps: number | null;
  sunsettingBranches: number;
}

interface RiverRedemptionProbe {
  capacityUsd: number;
  feeBps: number | null;
  chains: RiverChainRedemption[];
  droppedChains: string[];
}

function readMulticallResults(
  results: Awaited<ReturnType<typeof fetchOnchainMulticall3>>,
): Map<string, `0x${string}`> | null {
  if (!results) return null;
  const byLabel = new Map<string, `0x${string}`>();
  for (const result of results) {
    if (!result.success) return null;
    byLabel.set(result.label, result.returnData);
  }
  return byLabel;
}

/**
 * Same-run read of one chain's satUSD redemption engine. `redeemCollateral()`
 * burns satUSD against trove debt on the same chain, so `getGlobalSystemBalances()`
 * bounds what any holder on that chain can redeem, and the per-branch
 * `getRedemptionRateWithDecay()` bounds what it costs. The chain is dropped
 * whenever `debtToken()` no longer round-trips to the coin's own satUSD
 * deployment, when the global TCR sits below a branch MCR (redemption reverts
 * there), or when any read fails.
 */
async function probeRiverChain(
  chain: string,
  satUsdAddress: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<RiverChainRedemption | null> {
  const app = SATOSHI_APP_BY_CHAIN[chain];
  const rpcUrl = getPublicRpcUrl(chain);
  if (!app || !rpcUrl) return null;

  try {
    const appCalls: OnchainMulticall3Call[] = [
      { label: "app:debt-token", contract: app, data: DEBT_TOKEN_SELECTOR },
      { label: "app:balances", contract: app, data: GLOBAL_SYSTEM_BALANCES_SELECTOR },
      { label: "app:tcr", contract: app, data: GET_TCR_SELECTOR },
      { label: "app:trove-manager-count", contract: app, data: TROVE_MANAGER_COUNT_SELECTOR },
    ];
    for (let index = 0; index < MAX_TROVE_MANAGERS_PER_CHAIN; index += 1) {
      appCalls.push({
        label: `app:trove-manager:${index}`,
        contract: app,
        data: `${TROVE_MANAGERS_SELECTOR}${encodeUint256(index)}`,
        allowFailure: true,
      });
    }
    const appResults = readMulticallResults(
      await fetchOnchainMulticall3({ calls: appCalls, chain, signal, ctx, rpcUrl, timeoutMs: 12_000 }),
    );
    if (!appResults) return null;

    if (decodeStrictAddressWord(appResults.get("app:debt-token")) !== satUsdAddress.toLowerCase()) return null;

    const totalDebtRaw = decodeUint256Word(decodeAbiWordAt(appResults.get("app:balances"), 1));
    const tcrRaw = decodeUint256Word(appResults.get("app:tcr"));
    const countRaw = decodeUint256Word(appResults.get("app:trove-manager-count"));
    if (totalDebtRaw == null || tcrRaw == null || countRaw == null) return null;
    if (countRaw <= 0n || countRaw > BigInt(MAX_TROVE_MANAGERS_PER_CHAIN)) return null;

    const troveManagers: string[] = [];
    for (let index = 0; index < Number(countRaw); index += 1) {
      const address = decodeStrictAddressWord(appResults.get(`app:trove-manager:${index}`));
      if (!address) return null;
      troveManagers.push(address);
    }

    const branchCalls: OnchainMulticall3Call[] = troveManagers.flatMap((troveManager, index) => [
      { label: `branch:debt-token:${index}`, contract: troveManager, data: DEBT_TOKEN_SELECTOR },
      { label: `branch:rate:${index}`, contract: troveManager, data: REDEMPTION_RATE_WITH_DECAY_SELECTOR },
      { label: `branch:mcr:${index}`, contract: troveManager, data: MCR_SELECTOR },
      { label: `branch:sunsetting:${index}`, contract: troveManager, data: SUNSETTING_SELECTOR },
    ]);
    const branchResults = readMulticallResults(
      await fetchOnchainMulticall3({ calls: branchCalls, chain, signal, ctx, rpcUrl, timeoutMs: 12_000 }),
    );
    if (!branchResults) return null;

    let maxRateRaw = 0n;
    let maxMcrRaw = 0n;
    let sunsettingBranches = 0;
    for (let index = 0; index < troveManagers.length; index += 1) {
      if (decodeStrictAddressWord(branchResults.get(`branch:debt-token:${index}`)) !== satUsdAddress.toLowerCase()) {
        return null;
      }
      const rateRaw = decodeUint256Word(branchResults.get(`branch:rate:${index}`));
      const mcrRaw = decodeUint256Word(branchResults.get(`branch:mcr:${index}`));
      const sunsetting = decodeStrictBoolWord(branchResults.get(`branch:sunsetting:${index}`));
      if (rateRaw == null || mcrRaw == null || sunsetting == null) return null;
      if (rateRaw > maxRateRaw) maxRateRaw = rateRaw;
      if (mcrRaw > maxMcrRaw) maxMcrRaw = mcrRaw;
      if (sunsetting) sunsettingBranches += 1;
    }

    // redeemCollateral() reverts on "Cannot redeem when TCR < MCR", so a chain
    // whose global TCR sits under its deepest branch requirement cannot pay any
    // holder this run.
    if (tcrRaw < maxMcrRaw) return null;

    const capacityUsd = decimalNumberFromBigInt(totalDebtRaw, SATUSD_DEBT_DECIMALS);
    if (!Number.isFinite(capacityUsd) || capacityUsd < 0) return null;

    // The rate is an 18-decimal fraction of the redeemed amount; the highest
    // branch rate is the conservative cost of the route as a whole.
    const scale = 10n ** BigInt(SATUSD_DEBT_DECIMALS);
    const feeBps = maxRateRaw > scale ? null : Number((maxRateRaw * 10_000n + scale / 2n) / scale);

    return {
      chain,
      app,
      capacityUsd,
      totalDebtRaw: totalDebtRaw.toString(),
      tcrRaw: tcrRaw.toString(),
      troveManagerCount: troveManagers.length,
      feeBps,
      sunsettingBranches,
    };
  } catch (error) {
    rethrowIfAborted(error, signal);
    return null;
  }
}

/**
 * Aggregate the per-chain probes. Capacity sums only the chains that verified,
 * so an unreachable chain understates the route rather than asserting depth the
 * run could not observe; the fee is the highest verified branch rate.
 */
async function probeRiverRedemption(
  coin: StablecoinMeta,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<RiverRedemptionProbe | null> {
  const probeable = (coin.contracts ?? []).filter((contract) => SATOSHI_APP_BY_CHAIN[contract.chain]);
  if (probeable.length === 0) return null;

  const results = await Promise.all(
    probeable.map((contract) => probeRiverChain(contract.chain, contract.address, signal, ctx)),
  );
  const chains = results.filter((entry): entry is RiverChainRedemption => entry != null);
  if (chains.length === 0) return null;

  const feeBpsValues = chains.map((entry) => entry.feeBps).filter((fee): fee is number => fee != null);
  return {
    capacityUsd: chains.reduce((sum, entry) => sum + entry.capacityUsd, 0),
    feeBps: feeBpsValues.length === chains.length ? Math.max(...feeBpsValues) : null,
    chains,
    droppedChains: probeable
      .map((contract) => contract.chain)
      .filter((chain) => !chains.some((entry) => entry.chain === chain)),
  };
}

function buildRiverRedemptionMetadata(
  probe: RiverRedemptionProbe,
): NonNullable<AdapterResult["metadata"]> {
  const probedChains = probe.chains.map((entry) => entry.chain);
  return {
    ...buildRedemptionSnapshotMetadata({
      capacityUsd: probe.capacityUsd,
      // Bounded twice over: per chain it is total trove debt rather than the
      // debt of troves currently above MCR, and it covers only the chains with
      // a pinned Satoshi app and a public RPC.
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      holderEligibility: "any-holder",
      ...(probe.capacityUsd > 0
        ? {
            routeStatus: "open" as const,
            routeStatusSource: "onchain" as const,
            routeStatusReason:
              `Satoshi Protocol redemption read in the same run on ${probedChains.join(", ")}: ` +
              probe.chains
                .map((entry) => `${entry.chain} debtToken() is the tracked satUSD with ` +
                  `getGlobalSystemBalances() debt ${entry.totalDebtRaw} across ${entry.troveManagerCount} branches`)
                .join("; "),
          }
        : {}),
      ...(probe.feeBps != null ? { feeBps: probe.feeBps } : {}),
      sourceUrls: [RIVER_REDEMPTION_DOC_URL, RIVER_DEPLOYED_CONTRACTS_DOC_URL],
    }),
    details: {
      redeemRoute: {
        proofKind: "satoshi-protocol-branch-trove-debt",
        probedChains,
        ...(probe.droppedChains.length > 0 ? { droppedChains: probe.droppedChains } : {}),
        chains: probe.chains.map((entry) => ({
          chain: entry.chain,
          app: entry.app,
          totalDebtRaw: entry.totalDebtRaw,
          tcrRaw: entry.tcrRaw,
          troveManagerCount: entry.troveManagerCount,
          feeBps: entry.feeBps,
          sunsettingBranches: entry.sunsettingBranches,
        })),
      },
    },
  };
}

export async function fetchRiverProtocolInfoReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const [payload, probe] = await Promise.all([
    fetchJsonAdapterInput<RiverProtocolInfoPayload>(config, "river-protocol-info", signal, 12_000, ctx),
    probeRiverRedemption(coin, signal, ctx),
  ]);
  const adapted = adaptRiverProtocolInfo(payload);
  if (probe == null) {
    return {
      ...adapted,
      warnings: [
        ...(adapted.warnings ?? []),
        reserveInfoWarning(
          "river-redemption-unreadable",
          `No Satoshi Protocol chain returned a matching debtToken()/getGlobalSystemBalances()/branch set for ${coin.id} this run; redemption telemetry withheld`,
        ),
      ],
    };
  }

  const redemption = buildRiverRedemptionMetadata(probe);
  const warnings: LiveReserveWarning[] = probe.droppedChains.length > 0
    ? [
        reserveInfoWarning(
          "river-redemption-partial-chain-coverage",
          `Satoshi Protocol redemption capacity omits unverified chains: ${probe.droppedChains.join(", ")}`,
        ),
      ]
    : [];

  return {
    ...adapted,
    ...(adapted.warnings || warnings.length > 0
      ? { warnings: [...(adapted.warnings ?? []), ...warnings] }
      : {}),
    metadata: {
      ...adapted.metadata,
      ...redemption,
      details: {
        ...(adapted.metadata?.details ?? {}),
        ...(redemption.details ?? {}),
      },
    },
  };
}
