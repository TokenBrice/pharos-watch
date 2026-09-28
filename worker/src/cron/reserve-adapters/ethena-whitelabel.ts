import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonAdapterInput,
  parseFiniteNumber,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  reserveInfoWarning,
  slicesFromValues,
  verifiedFreshnessMetadata,
} from "./helpers";

const ADAPTER_KEY = "ethena-whitelabel";
// Custody amounts have sub-cent rounding differences; the wire ratio has six decimals.
const BACKING_ROUNDING_TOLERANCE_USD = 0.01;
const RATIO_ROUNDING_TOLERANCE = 0.0000005 + Number.EPSILON;

interface EthenaWhitelabelCustodian {
  custodian?: string;
  network?: string;
  address?: string;
  asset?: string;
  amount?: number | string;
}

interface EthenaWhitelabelStablecoin {
  stablecoin?: string;
  totalBacking?: number | string;
  totalSupply?: number | string;
  collateralizationRatio?: number | string;
  lastUpdated?: number | string;
  custodians?: EthenaWhitelabelCustodian[];
}

export interface EthenaWhitelabelPayload {
  data?: EthenaWhitelabelStablecoin[];
}

interface AssetConfig {
  name: string;
  risk: ReserveSlice["risk"];
  coinId: string;
}

/** The whitelabel endpoint enumerates every Ethena-whitelabel stablecoin in one
 *  `data[]` payload; `custodians` is the source of truth for per-wallet amounts.
 *  `rows` is a display-level projection (it merges USDe+USDC under one custodian
 *  into a single "USDe/USDC" row) and must never be summed. */
const ON_CHAIN_ASSET_CONFIG: Record<string, AssetConfig> = {
  USDE: {
    name: "USDe (Ethena synthetic dollar)",
    risk: getCanonicalReserveAssetRisk("USDE") ?? "high",
    coinId: "usde-ethena",
  },
  USDC: {
    name: "USDC cash-equivalent reserves",
    risk: getCanonicalReserveAssetRisk("USDC") ?? "low",
    coinId: "usdc-circle",
  },
};

/** Custodian rows whose network is an off-chain custody system (Coinbase Prime)
 *  do not expose a public on-chain address, so they are kept as a separate
 *  slice without a `coinId` and the adapter never describes them as on-chain
 *  verified. */
const OFF_CHAIN_NETWORKS: Record<string, true> = { coinbase_prime: true };

const parseStrictAmount = (value: unknown, label: string): number =>
  parseFiniteNumber(value, { label: `${ADAPTER_KEY} ${label}` });

export function adaptEthenaWhitelabel(
  payload: EthenaWhitelabelPayload,
  stablecoin: string,
): AdapterResult {
  const data = payload.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("ethena-whitelabel payload missing data[]");
  }

  const entry = data.find(
    (row) => typeof row?.stablecoin === "string" && row.stablecoin.trim() === stablecoin,
  );
  if (!entry) {
    throw new Error(`ethena-whitelabel payload has no entry for stablecoin ${stablecoin}`);
  }

  const supplyUsd = parseStrictAmount(entry.totalSupply, "totalSupply");
  if (!(supplyUsd > 0)) {
    throw new Error("ethena-whitelabel payload has invalid totalSupply");
  }
  const sourceTotalBackingUsd = parseStrictAmount(entry.totalBacking, "totalBacking");
  const sourceCollateralizationRatio = parseStrictAmount(entry.collateralizationRatio, "collateralizationRatio");
  if (sourceTotalBackingUsd < 0 || sourceCollateralizationRatio < 0) {
    throw new Error("ethena-whitelabel payload has negative backing or collateralizationRatio");
  }

  const sourceTimestamp = parseTimestampLikeToUnixSeconds(entry.lastUpdated);
  if (sourceTimestamp == null) {
    throw new Error("ethena-whitelabel payload has an unreadable lastUpdated");
  }

  const custodians = entry.custodians;
  if (!Array.isArray(custodians) || custodians.length === 0) {
    throw new Error("ethena-whitelabel payload missing custodians[]");
  }

  const warnings: LiveReserveWarning[] = [];
  const onChainTotals = new Map<string, number>();
  const unmappedAssets = new Set<string>();
  let unmappedUsd = 0;
  let offChainUsd = 0;
  const offChainCustodians = new Set<string>();
  const custodyIdentities = new Set<string>();

  for (const [index, custodian] of custodians.entries()) {
    const amount = parseStrictAmount(custodian?.amount, `custodian ${index} amount`);
    if (amount < 0) {
      throw new Error(`ethena-whitelabel custodian ${index} has a negative amount`);
    }
    const network = typeof custodian?.network === "string" ? custodian.network.trim().toLowerCase() : "";
    const asset = typeof custodian?.asset === "string" ? custodian.asset.trim().toUpperCase() : "";
    const address = typeof custodian?.address === "string" ? custodian.address.trim() : "";
    const custodyName = typeof custodian?.custodian === "string" ? custodian.custodian.trim() : "";
    const location = address || (OFF_CHAIN_NETWORKS[network] ? custodyName : "");
    if (!network || !asset || !location) {
      throw new Error(`ethena-whitelabel custodian ${index} has an incomplete custody identity`);
    }
    const identity = JSON.stringify([network, location.startsWith("0x") ? location.toLowerCase() : location, asset]);
    if (custodyIdentities.has(identity)) {
      throw new Error(`ethena-whitelabel custodian ${index} duplicates a custody identity`);
    }
    custodyIdentities.add(identity);
    if (amount === 0) continue;
    if (OFF_CHAIN_NETWORKS[network]) {
      offChainUsd += amount;
      if (typeof custodian?.custodian === "string" && custodian.custodian.trim() !== "") {
        offChainCustodians.add(custodian.custodian);
      }
      continue;
    }

    if (!asset || !ON_CHAIN_ASSET_CONFIG[asset]) {
      unmappedAssets.add(asset || "unknown");
      unmappedUsd += amount;
      continue;
    }

    onChainTotals.set(asset, (onChainTotals.get(asset) ?? 0) + amount);
  }

  const sliceInputs: Array<{
    value: number;
    sourceKey: string;
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
  }> = [];

  for (const [asset, value] of onChainTotals) {
    const config = ON_CHAIN_ASSET_CONFIG[asset];
    sliceInputs.push({ sourceKey: `ethena-whitelabel:${asset.toLowerCase()}`, name: config.name, value, risk: config.risk, coinId: config.coinId });
  }

  if (unmappedUsd > 0) {
    warnings.push(reserveDegradedWarning(
      "unknown-asset",
      `Unmapped suiUSDe backing asset(s): ${Array.from(unmappedAssets).sort().join(", ")} ($${unmappedUsd.toFixed(2)})`,
    ));
    sliceInputs.push({ sourceKey: "ethena-whitelabel:unknown", name: "Unmapped suiUSDe backing assets", value: unmappedUsd, risk: "high" });
  }

  if (offChainUsd > 0) {
    warnings.push(reserveInfoWarning(
      "off-chain-custody",
      `suiUSDe backing includes ${offChainUsd.toFixed(2)} held in off-chain custody (${Array.from(offChainCustodians).sort().join(", ")}); this balance is not independently on-chain verifiable`,
    ));
    sliceInputs.push({ sourceKey: "ethena-whitelabel:off-chain", name: "Coinbase Prime custody (off-chain)", value: offChainUsd, risk: "low" });
  }

  if (sliceInputs.length === 0) {
    throw new Error("ethena-whitelabel payload contained no positive custodian amounts");
  }

  const totalReserveUsd = sliceInputs.reduce((sum, slice) => sum + slice.value, 0);
  if (!Number.isFinite(totalReserveUsd)
    || Math.abs(totalReserveUsd - sourceTotalBackingUsd) > BACKING_ROUNDING_TOLERANCE_USD) {
    throw new Error("ethena-whitelabel custodian sum does not reconcile with totalBacking");
  }
  const collateralizationRatio = totalReserveUsd / supplyUsd;
  if (!Number.isFinite(collateralizationRatio)
    || Math.abs(sourceCollateralizationRatio - sourceTotalBackingUsd / supplyUsd) > RATIO_ROUNDING_TOLERANCE) {
    throw new Error("ethena-whitelabel collateralizationRatio does not reconcile with backing and supply");
  }
  if (collateralizationRatio < 1) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      "Ethena whitelabel custodian backing is below the reported supply",
    ));
  }
  const unknownExposurePct = totalReserveUsd > 0 ? (unmappedUsd / totalReserveUsd) * 100 : 0;

  return {
    slices: slicesFromValues(sliceInputs, 3),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(sourceTimestamp),
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio,
      ...(unmappedUsd > 0 ? { unknownExposurePct } : {}),
      details: { lastUpdated: entry.lastUpdated, sourceTotalBackingUsd, sourceCollateralizationRatio },
    },
  };
}

export async function fetchEthenaWhitelabelReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const payload = await fetchJsonAdapterInput<EthenaWhitelabelPayload>(
    config,
    ADAPTER_KEY,
    signal,
    12_000,
    ctx,
  );
  return adaptEthenaWhitelabel(payload, params.stablecoin);
}
