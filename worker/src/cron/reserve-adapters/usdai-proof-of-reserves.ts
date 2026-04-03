import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildUnknownExposureWarning,
  fetchTextWithRetry,
  getAdapterTimeout,
  requireJsonInput,
  slicesFromPercentages,
  unverifiedFreshnessMetadata,
} from "./helpers";

const SHARE_SCALE = 10n ** 18n;
const PCT_MICRO_SCALE = 100_000_000n;

interface UsdAiProofOfReservesEntry {
  type?: string;
  name?: string;
  chain?: number;
  share?: string | number;
}

interface ResolvedReserveBucket {
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
}

function parseShare(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }

  return null;
}

function shareToPct(share: bigint): number {
  return Number((share * PCT_MICRO_SCALE + SHARE_SCALE / 2n) / SHARE_SCALE) / 1_000_000;
}

function normalizeBucketKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

function resolveTbillBucket(name: string): ResolvedReserveBucket {
  const normalized = normalizeBucketKey(name);
  switch (normalized) {
    case "PYUSD":
      return { name: "PYUSD (PayPal USD)", risk: "low", coinId: "pyusd-paypal" };
    case "USDC":
      return { name: "USDC", risk: "low", coinId: "usdc-circle" };
    case "USDT":
      return { name: "USDT", risk: "low", coinId: "usdt-tether" };
    case "M":
    case "WM":
    case "M0":
      return { name: "M0 / wM Treasury assets", risk: "low", coinId: "m-m0" };
    default:
      return { name: name.trim(), risk: "low" };
  }
}

export function parseUsdAiProofOfReserves(raw: string): UsdAiProofOfReservesEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/("share"\s*:\s*)(\d+)/g, '$1"$2"')) as unknown;
  } catch (error) {
    throw new Error(
      `usdai-proof-of-reserves payload is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("usdai-proof-of-reserves payload was not an array");
  }

  return parsed as UsdAiProofOfReservesEntry[];
}

export function adaptUsdAiProofOfReserves(entries: UsdAiProofOfReservesEntry[]): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const tbillBuckets = new Map<string, { share: bigint; bucket: ResolvedReserveBucket }>();
  const unknownTypes = new Set<string>();
  const chains = new Set<number>();
  let dealShare = 0n;
  let unknownShare = 0n;
  let totalShare = 0n;
  let dealCount = 0;

  for (const entry of entries) {
    const type = typeof entry.type === "string" ? entry.type.trim().toUpperCase() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const share = parseShare(entry.share);

    if (!type) {
      throw new Error("usdai-proof-of-reserves entry is missing a reserve type");
    }
    if (share == null) {
      throw new Error(`usdai-proof-of-reserves entry is missing a valid share: ${name || type}`);
    }
    if (share === 0n) continue;

    totalShare += share;

    if (typeof entry.chain === "number" && Number.isFinite(entry.chain)) {
      chains.add(entry.chain);
    }

    if (type === "DEAL") {
      dealShare += share;
      dealCount += 1;
      continue;
    }

    if (type === "TBILL") {
      if (!name) {
        throw new Error("usdai-proof-of-reserves TBILL entry is missing a name");
      }
      const bucket = resolveTbillBucket(name);
      const existing = tbillBuckets.get(bucket.name);
      if (existing) {
        existing.share += share;
      } else {
        tbillBuckets.set(bucket.name, { share, bucket });
      }
      continue;
    }

    unknownShare += share;
    unknownTypes.add(type);
  }

  const sliceInputs = Array.from(tbillBuckets.values()).map(({ share, bucket }) => ({
    name: bucket.name,
    pct: shareToPct(share),
    risk: bucket.risk,
    ...(bucket.coinId ? { coinId: bucket.coinId } : {}),
  }));

  if (dealShare > 0n) {
    sliceInputs.push({
      name: "GPU-backed infrastructure loans (NVIDIA hardware)",
      pct: shareToPct(dealShare),
      risk: "high",
    });
  }

  if (unknownShare > 0n) {
    sliceInputs.push({
      name: "Unmapped USD.AI reserve buckets",
      pct: shareToPct(unknownShare),
      risk: "high",
    });
  }

  if (sliceInputs.length === 0) {
    throw new Error("usdai-proof-of-reserves payload contained no positive-share reserve entries");
  }

  const slices = slicesFromPercentages(sliceInputs, {
    decimals: 1,
    context: "USD.AI proof-of-reserves",
  });

  if (unknownShare > 0n) {
    warnings.push(buildUnknownExposureWarning({
      code: "unknown-reserve-type",
      message: `Unmapped USD.AI reserve types: ${Array.from(unknownTypes).sort().join(", ")}`,
      unknownExposurePct: shareToPct(unknownShare),
    }));
  }

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      apiEntryCount: entries.length,
      liquidBucketCount: tbillBuckets.size,
      dealCount,
      declaredSharePct: shareToPct(totalShare),
      unknownTypeCount: unknownTypes.size,
      ...(tbillBuckets.size > 0 ? { liquidReserveLabels: Array.from(tbillBuckets.keys()) } : {}),
      ...(chains.size > 0 ? { chains: Array.from(chains).sort((a, b) => a - b) } : {}),
      ...(unknownTypes.size > 0 ? { unknownReserveTypes: Array.from(unknownTypes).sort() } : {}),
      unknownExposurePct: shareToPct(unknownShare),
      ...unverifiedFreshnessMetadata(
        "usdai-proof-of-reserves-api",
        "USD.AI proof-of-reserves API does not expose a trustworthy source timestamp",
      ),
    },
  };
}

export async function fetchUsdAiProofOfReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "usdai-proof-of-reserves");
  const raw = await fetchTextWithRetry(input.url, signal, getAdapterTimeout(config, 12_000), ctx);
  return adaptUsdAiProofOfReserves(parseUsdAiProofOfReserves(raw));
}
