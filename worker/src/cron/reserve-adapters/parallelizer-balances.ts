import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { decodeAbiParameters } from "viem/utils";
import { encodeAddressCallData, encodeUint256 } from "../../lib/evm-selectors";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  makeOnchainCallers,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveInfoWarning,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER_KEY = "parallelizer-balances";
const SELECTORS = {
  tokenP: "0x1978a5ed",
  getCollateralList: "0xb7181361",
  getCollateralDecimals: "0xeb7aac5f",
  getOracleValues: "0x38c269eb",
  isPaused: "0x0d126627",
} as const;
const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";
const REDEEM_ACTION = 2n;
const MAX_COLLATERALS_PER_DEPLOYMENT = 32;

type ParallelizerBalancesParams = ReturnType<typeof parseLiveReserveAdapterParams<typeof ADAPTER_KEY>>;
type ParallelizerAsset = ParallelizerBalancesParams["deployments"][number]["assets"][number];
type ParallelizerDeployment = ParallelizerBalancesParams["deployments"][number];

interface ParallelizerBalanceObservation {
  chain: string;
  vaultAddress: string;
  address: string;
  value: number;
  balanceRaw: string;
  priceUsd: number;
  descriptor?: ParallelizerAsset;
  paused: boolean;
}

function encodePauseCall(address: string): string {
  return `${encodeAddressCallData(SELECTORS.isPaused, address)}${encodeUint256(REDEEM_ACTION)}`;
}

function parseAddressWord(value: bigint | null, label: string): string {
  if (value == null || value === 0n || value >= 1n << 160n) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned an invalid address`);
  }
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function parseAddressArray(raw: string | null, label: string): string[] {
  if (raw == null || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned malformed data`);
  }
  try {
    const [addresses] = decodeAbiParameters([{ type: "address[]" }], raw as `0x${string}`);
    if (addresses.length === 0 || addresses.length > MAX_COLLATERALS_PER_DEPLOYMENT) {
      throw new Error("unexpected collateral count");
    }
    const normalized = addresses.map((address) => address.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      throw new Error("duplicate collateral address");
    }
    return normalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${ADAPTER_KEY}: ${label} could not be decoded (${message})`);
  }
}

function parseOraclePrice(raw: string | null, label: string): number {
  if (raw == null || !/^0x[0-9a-fA-F]{320,}$/.test(raw)) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned malformed oracle data`);
  }
  const priceRaw = BigInt(`0x${raw.slice(2, 66)}`);
  const priceUsd = decimalNumberFromBigInt(priceRaw, 18);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned a non-positive oracle price`);
  }
  return priceUsd;
}

async function readDeployment(
  primaryInput: ReturnType<typeof requireOnchainInput>,
  deployment: ParallelizerDeployment,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<ParallelizerBalanceObservation[]> {
  const input = { chain: deployment.chain, rpcMode: primaryInput.rpcMode };
  const onchain = makeOnchainCallers(input, {
    signal,
    ctx,
    rpcUrl: deployment.rpcUrl,
    fallbackRpcUrl: deployment.fallbackRpcUrl,
  });

  const tokenP = parseAddressWord(await onchain.uint256(deployment.vaultAddress, SELECTORS.tokenP), "tokenP()");
  if (tokenP.toLowerCase() !== deployment.expectedTokenP.toLowerCase()) {
    throw new Error(
      `${ADAPTER_KEY}: ${deployment.chain} tokenP identity mismatch (${tokenP} != ${deployment.expectedTokenP})`,
    );
  }

  const collateralAddresses = parseAddressArray(
    await onchain.raw(deployment.vaultAddress, SELECTORS.getCollateralList),
    `${deployment.chain} getCollateralList()`,
  );
  const configuredByAddress = new Map(
    deployment.assets.map((asset) => [asset.address.toLowerCase(), asset]),
  );
  const missingConfigured = deployment.assets
    .map((asset) => asset.address.toLowerCase())
    .filter((address) => !collateralAddresses.includes(address));
  if (missingConfigured.length > 0) {
    throw new Error(
      `${ADAPTER_KEY}: ${deployment.chain} collateral list is missing configured assets: ${missingConfigured.join(", ")}`,
    );
  }

  // Redeem pause is GLOBAL per Parallelizer vault: LibSetters._setPauseState in
  // parallel-protocol/parallel-parallelizer routes Mint/Burn to per-collateral
  // flags but Redeem to the vault-wide `isRedemptionLive`, ignoring the
  // collateral argument. One read per deployment; the flag applies to every
  // collateral held by that vault.
  const pauseRaw = await onchain.uint256(
    deployment.vaultAddress,
    encodePauseCall(collateralAddresses[0]!),
  );
  if (pauseRaw == null || (pauseRaw !== 0n && pauseRaw !== 1n)) {
    throw new Error(`${ADAPTER_KEY}: ${deployment.chain} redemption pause check failed`);
  }
  const paused = pauseRaw === 1n;

  return Promise.all(collateralAddresses.map(async (address) => {
    const descriptor = configuredByAddress.get(address);
    // Decimals are always read from the vault (addCollateral stores the
    // token's on-chain decimals), so a configured descriptor is verified
    // against chain truth instead of being trusted.
    const [decimalsRaw, balanceRaw, oracleRaw] = await Promise.all([
      onchain.uint256(
        deployment.vaultAddress,
        encodeAddressCallData(SELECTORS.getCollateralDecimals, address),
      ),
      onchain.uint256(address, encodeAddressCallData(ERC20_BALANCE_OF_SELECTOR, deployment.vaultAddress)),
      onchain.raw(deployment.vaultAddress, encodeAddressCallData(SELECTORS.getOracleValues, address)),
    ]);
    if (decimalsRaw == null || decimalsRaw < 0n || decimalsRaw > 36n) {
      throw new Error(`${ADAPTER_KEY}: ${deployment.chain} ${address} returned invalid decimals`);
    }
    const decimals = Number(decimalsRaw);
    if (descriptor && decimals !== descriptor.decimals) {
      throw new Error(
        `${ADAPTER_KEY}: ${deployment.chain} ${address} decimals mismatch (${decimals} != ${descriptor.decimals})`,
      );
    }
    if (balanceRaw == null) {
      throw new Error(`${ADAPTER_KEY}: ${deployment.chain} ${address} balance read failed`);
    }
    const priceUsd = parseOraclePrice(oracleRaw, `${deployment.chain} ${address} getOracleValues()`);
    const value = valueUsdFromBigIntPrice(balanceRaw, decimals, priceUsd);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${ADAPTER_KEY}: ${deployment.chain} ${address} produced an invalid USD value`);
    }
    return {
      chain: deployment.chain,
      vaultAddress: deployment.vaultAddress,
      address,
      value,
      balanceRaw: balanceRaw.toString(),
      priceUsd,
      ...(descriptor ? { descriptor } : {}),
      paused,
    };
  }));
}

export async function fetchParallelizerBalancesReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const primaryInput = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const observations = (await Promise.all(
    params.deployments.map((deployment) => readDeployment(primaryInput, deployment, signal, ctx)),
  )).flat();

  const positiveObservations = observations.filter((observation) => observation.value > 0);
  if (positiveObservations.length === 0) {
    throw new Error(`${ADAPTER_KEY}: all configured collateral balances are zero`);
  }

  const grouped = new Map<string, {
    value: number;
    name: ReserveSlice["name"];
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
  }>();
  for (const observation of positiveObservations) {
    const descriptor = observation.descriptor;
    const key = descriptor?.name ?? `untracked:${observation.address}`;
    const existing = grouped.get(key);
    if (existing) {
      if (
        existing.risk !== (descriptor?.risk ?? "high")
        || existing.coinId !== descriptor?.coinId
        || existing.depType !== descriptor?.depType
      ) {
        throw new Error(`${ADAPTER_KEY}: conflicting metadata for reserve slice ${key}`);
      }
      existing.value += observation.value;
      continue;
    }
    grouped.set(key, {
      value: observation.value,
      name: descriptor?.name ?? `Untracked Parallelizer collateral ${observation.address}`,
      risk: descriptor?.risk ?? "high",
      ...(descriptor?.coinId ? { coinId: descriptor.coinId } : {}),
      ...(descriptor?.depType ? { depType: descriptor.depType } : {}),
    });
  }

  const slices = slicesFromValues([...grouped.values()], 6);
  if (slices.length === 0) {
    throw new Error(`${ADAPTER_KEY}: no positive reserve slices were produced`);
  }

  const totalReserveUsd = positiveObservations.reduce((sum, observation) => sum + observation.value, 0);
  // Redeem pause is global per vault (per chain deployment): a paused vault's
  // whole basket is unavailable while other deployments keep redeeming, so
  // capacity counts unpaused deployments only and a partially paused route
  // publishes degraded.
  const unpausedReserveUsd = positiveObservations
    .filter((observation) => !observation.paused)
    .reduce((sum, observation) => sum + observation.value, 0);
  const pausedDeployments = [...new Set(
    observations.filter((observation) => observation.paused).map((observation) => observation.chain),
  )];
  const unlinked = slices.filter((slice) => !slice.coinId);
  const unlinkedCollateralPct = unlinked.reduce((sum, slice) => sum + slice.pct, 0);
  const warnings = unlinked.length > 0
    ? [reserveInfoWarning(
        "parallelizer-unlinked-collateral",
        `Parallelizer emitted ${unlinked.length} unlinked collateral slice(s) covering ${unlinkedCollateralPct.toFixed(6)}% of reserves: ${unlinked.map((slice) => slice.name).join(", ")}`,
      )]
    : [];
  const routeStatus = pausedDeployments.length === 0
    ? "open" as const
    : unpausedReserveUsd > 0
      ? "degraded" as const
      : "paused" as const;

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "onchain-parallelizer-balances" }),
      parallelizerDeployments: params.deployments.map((deployment) => ({
        chain: deployment.chain,
        vaultAddress: deployment.vaultAddress,
        assetCount: deployment.assets.length,
      })),
      parallelizerBalanceObservations: positiveObservations.map((observation) => ({
        chain: observation.chain,
        vaultAddress: observation.vaultAddress,
        address: observation.address,
        balanceRaw: observation.balanceRaw,
        priceUsd: observation.priceUsd,
        valueUsd: observation.value,
        ...(observation.descriptor?.coinId ? { coinId: observation.descriptor.coinId } : {}),
      })),
      totalReserveUsd,
      unlinkedCollateralPct,
      // Canonical field consumed by adapter validation's material-unknown gate.
      unknownExposurePct: unlinkedCollateralPct,
      immediateRedeemableUsd: unpausedReserveUsd,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: unpausedReserveUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        routeStatusReason: pausedDeployments.length > 0
          ? `Parallelizer redemption is paused on ${pausedDeployments.join(", ")}`
          : "All Parallelizer deployment redemption pause checks returned false",
        ...(params.holderEligibility ? { holderEligibility: params.holderEligibility } : {}),
        ...(params.settlementDelaySec != null ? { settlementDelaySec: params.settlementDelaySec } : {}),
        sourceUrls: params.sourceUrls,
      }),
    },
  };
}
