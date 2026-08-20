import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { decodeAbiParameters } from "viem/utils";
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

function encodeAddressWord(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function encodeAddressCall(selector: string, address: string): string {
  return `${selector}${encodeAddressWord(address)}`;
}

function encodePauseCall(address: string): string {
  return `${SELECTORS.isPaused}${encodeAddressWord(address)}${REDEEM_ACTION.toString(16).padStart(64, "0")}`;
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

  // Parallelizer pause state is per collateral: read it for every address
  // instead of stamping the first collateral's flag deployment-wide.
  return Promise.all(collateralAddresses.map(async (address) => {
    const descriptor = configuredByAddress.get(address);
    const [decimalsRaw, balanceRaw, oracleRaw, pauseRaw] = await Promise.all([
      descriptor
        ? Promise.resolve(BigInt(descriptor.decimals))
        : onchain.uint256(
            deployment.vaultAddress,
            encodeAddressCall(SELECTORS.getCollateralDecimals, address),
          ),
      onchain.uint256(address, `${ERC20_BALANCE_OF_SELECTOR}${encodeAddressWord(deployment.vaultAddress)}`),
      onchain.raw(deployment.vaultAddress, encodeAddressCall(SELECTORS.getOracleValues, address)),
      onchain.uint256(deployment.vaultAddress, encodePauseCall(address)),
    ]);
    if (pauseRaw == null || (pauseRaw !== 0n && pauseRaw !== 1n)) {
      throw new Error(`${ADAPTER_KEY}: ${deployment.chain} ${address} redemption pause check failed`);
    }
    const paused = pauseRaw === 1n;
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
  // Pause is per collateral: only unpaused holdings are redeemable capacity,
  // and the route is paused only when no unpaused positive holding remains.
  const unpausedReserveUsd = positiveObservations
    .filter((observation) => !observation.paused)
    .reduce((sum, observation) => sum + observation.value, 0);
  const pausedCollateral = observations
    .filter((observation) => observation.paused)
    .map((observation) => `${observation.chain}:${observation.descriptor?.name ?? observation.address}`);
  const unlinked = slices.filter((slice) => !slice.coinId);
  const warnings = unlinked.length > 0
    ? [reserveInfoWarning(
        "parallelizer-unlinked-collateral",
        `Parallelizer emitted ${unlinked.length} unlinked collateral slice(s): ${unlinked.map((slice) => slice.name).join(", ")}`,
      )]
    : [];
  const routeStatus = pausedCollateral.length === 0
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
      immediateRedeemableUsd: unpausedReserveUsd,
      ...buildRedemptionSnapshotMetadata({
        capacityUsd: unpausedReserveUsd,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus,
        routeStatusSource: "onchain",
        routeStatusReason: pausedCollateral.length > 0
          ? `Parallelizer redemption is paused for ${pausedCollateral.join(", ")}`
          : "All configured Parallelizer redemption pause checks returned false",
        ...(params.holderEligibility ? { holderEligibility: params.holderEligibility } : {}),
        ...(params.settlementDelaySec != null ? { settlementDelaySec: params.settlementDelaySec } : {}),
        sourceUrls: params.sourceUrls,
      }),
    },
  };
}
