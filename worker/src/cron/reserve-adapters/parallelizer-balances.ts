import { toErrorMessage } from "@shared/lib/error-utils";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { decodeAbiParameters } from "viem/utils";
import { encodeAddressCallData, encodeUint256 } from "../../lib/evm-selectors";
import {
  buildRedemptionSnapshotMetadata,
  decimalNumberFromBigInt,
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  requireOnchainInput,
  reserveInfoWarning,
  slicesFromValues,
  valueUsdFromBigIntPrice,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";
import { decodeStrictBoolWord, decodeUint256Word } from "./abi-decode";
import { addressObservation, customObservation, executeEvmObservationPlan } from "./evm-observation-plan";

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
    const message = toErrorMessage(error);
    throw new Error(`${ADAPTER_KEY}: ${label} could not be decoded (${message})`);
  }
}

function parseOraclePrice(raw: string | null, label: string): number {
  if (raw == null || !/^0x[0-9a-fA-F]{320,}$/.test(raw)) {
    throw new Error(`${ADAPTER_KEY}: ${label} returned malformed oracle data`);
  }
  const priceRaw = BigInt(`0x${raw.slice(2 + 4 * 64, 2 + 5 * 64)}`);
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
  const callOptions = {
    chain: input.chain,
    signal,
    ctx,
    rpcUrl: deployment.rpcUrl,
    fallbackRpcUrl: deployment.fallbackRpcUrl,
  };

  const identityStage = await executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields: [
      addressObservation({
        label: "token-p", contract: deployment.vaultAddress, data: SELECTORS.tokenP,
        verify: (tokenP) => {
          if (tokenP === "0x0000000000000000000000000000000000000000") {
            throw new Error(`${ADAPTER_KEY}: tokenP() returned an invalid address`);
          }
          if (tokenP !== deployment.expectedTokenP.toLowerCase()) {
            throw new Error(`${ADAPTER_KEY}: ${deployment.chain} tokenP identity mismatch (${tokenP} != ${deployment.expectedTokenP})`);
          }
          return null;
        },
      }),
      customObservation({
        label: "collateral-list", contract: deployment.vaultAddress, data: SELECTORS.getCollateralList,
        decode: (raw) => parseAddressArray(raw, `${deployment.chain} getCollateralList()`),
      }),
    ] as const,
    onFailure: (label) => {
      if (label === "collateral-list") parseAddressArray(null, `${deployment.chain} getCollateralList()`);
      throw new Error(`${ADAPTER_KEY}: tokenP() returned an invalid address`);
    },
    onDecodeError: (error, label) => {
      if (label === "token-p") throw new Error(`${ADAPTER_KEY}: tokenP() returned an invalid address`);
      throw error;
    },
    read: async (calls) => {
      const results = await fetchOnchainMulticall3({ ...callOptions, calls });
      if (!results) throw new Error(`${ADAPTER_KEY}: ${deployment.chain} identity multicall failed`);
      return results;
    },
  });
  const collateralAddresses = identityStage.values["collateral-list"];
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
  const pauseStage = await executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields: [customObservation({
      label: "redemption-paused", contract: deployment.vaultAddress,
      data: encodePauseCall(collateralAddresses[0]!),
      optional: true, decode: decodeStrictBoolWord,
    })] as const,
    read: async (calls) => {
      const results = await fetchOnchainMulticall3({ ...callOptions, calls });
      if (!results) throw new Error(`${ADAPTER_KEY}: ${deployment.chain} redemption pause multicall failed`);
      return results;
    },
  });
  const paused = pauseStage.values["redemption-paused"];
  if (paused == null) throw new Error(`${ADAPTER_KEY}: ${deployment.chain} redemption pause check failed`);

  const assetStage = await executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields: collateralAddresses.flatMap((address, index) => [
      customObservation({
        label: `asset:${index}:decimals`, contract: deployment.vaultAddress,
        data: encodeAddressCallData(SELECTORS.getCollateralDecimals, address),
        optional: true, decode: decodeUint256Word,
      }),
      customObservation({
        label: `asset:${index}:balance`, contract: address,
        data: encodeAddressCallData(ERC20_BALANCE_OF_SELECTOR, deployment.vaultAddress),
        optional: true, decode: decodeUint256Word,
      }),
      customObservation({
        label: `asset:${index}:oracle`, contract: deployment.vaultAddress,
        data: encodeAddressCallData(SELECTORS.getOracleValues, address),
        decode: (raw) => parseOraclePrice(raw, `${deployment.chain} ${address} getOracleValues()`),
      }),
    ]),
    onDecodeError: (error) => { throw error; },
    read: async (calls) => {
      const results = await fetchOnchainMulticall3({ ...callOptions, calls });
      if (!results) throw new Error(`${ADAPTER_KEY}: ${deployment.chain} asset multicall failed`);
      return results;
    },
  });

  return collateralAddresses.map((address, index) => {
    const descriptor = configuredByAddress.get(address);
    // Decimals are always read from the vault (addCollateral stores the
    // token's on-chain decimals), so a configured descriptor is verified
    // against chain truth instead of being trusted.
    const decimalsRaw = assetStage.values[`asset:${index}:decimals`];
    const balanceRaw = assetStage.values[`asset:${index}:balance`];
    const priceUsd = assetStage.values[`asset:${index}:oracle`];
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
  });
}

export async function fetchParallelizerBalancesReserves(
  _coin: ReserveAdapterCoin,
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
    sourceKey: string;
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
      sourceKey: `parallelizer-balances:${(descriptor?.address ?? observation.address).toLowerCase()}`,
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
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: unpausedReserveUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        routeObserved: true,
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
