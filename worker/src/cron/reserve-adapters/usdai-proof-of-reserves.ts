import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import { toErrorMessage } from "@shared/lib/error-utils";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { rethrowIfAborted } from "../../lib/abort";
import { MULTICALL3_ADDRESS } from "../../lib/evm-rpc";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR, encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { decodeStrictAddressWord, decodeUint256Word } from "./abi-decode";
import { ERC4626_ASSET_SELECTOR, ERC4626_TOTAL_ASSETS_SELECTOR } from "./erc4626";
import { multicallResultByLabel } from "./onchain-identity";
import {
  buildUnknownExposureWarning,
  fetchTextWithRetry,
  fetchOnchainMulticall3,
  notApplicableFreshnessMetadata,
  unverifiedFreshnessMetadata,
  requireJsonInput,
  reserveInfoWarning,
  reserveDegradedWarning,
  slicesFromPercentages,
} from "./helpers";

const SHARE_SCALE = 10n ** 18n;
const PCT_MICRO_SCALE = 100_000_000n;
const PERCENTAGE_TOLERANCE_PCT = 1.5;

interface UsdAiProofOfReservesEntry {
  type?: string;
  name?: string;
  chain?: number;
  share?: string | number;
  amount?: string | number;
  reserveLink?: string;
}

interface ResolvedReserveBucket {
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  sourceKey: string;
}

type WeightMode = "share" | "amount";
const SHARE_TOTAL_SCALE = 1_000_000_000_000_000_000n;

function quoteUnsafeIntegerWeightFields(raw: string): string {
  return raw.replace(
    /("(?:share|amount)"\s*:\s*)(\d+)(?=\s*[,}])/g,
    (_match, prefix: string, value: string) => `${prefix}"${value}"`,
  );
}

function parseIntegerLike(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }

  return null;
}

function ratioToPct(value: bigint, total: bigint): number {
  if (value <= 0n || total <= 0n) {
    return 0;
  }
  return Number((value * PCT_MICRO_SCALE + total / 2n) / total) / 1_000_000;
}

function shareToPct(share: bigint): number {
  return ratioToPct(share, SHARE_SCALE);
}

function hasFullShareCoverage(totalShare: bigint): boolean {
  return totalShare > 0n && Math.abs(shareToPct(totalShare) - 100) <= PERCENTAGE_TOLERANCE_PCT;
}

function createPartialShareCoverageWarning(totalShareDeclared: bigint): LiveReserveWarning {
  return reserveDegradedWarning(
    "usdai-share-coverage-gap",
    `USD.AI share-bearing rows cover only ${shareToPct(totalShareDeclared).toFixed(1)}% of reserves`,
  );
}

function pluralizeEntries(count: number): string {
  return count === 1 ? "entry" : "entries";
}

function pluralizeIgnoredVerb(count: number): string {
  return count === 1 ? "was" : "were";
}

function normalizeBucketKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

function resolveTbillBucket(name: string): ResolvedReserveBucket {
  const normalized = normalizeBucketKey(name);
  switch (normalized) {
    case "PYUSD":
      return { name: "PYUSD (PayPal USD)", risk: "low", coinId: "pyusd-paypal", sourceKey: "usdai-proof-of-reserves:pyusd" };
    case "USDC":
      return { name: "USDC", risk: "low", coinId: "usdc-circle", sourceKey: "usdai-proof-of-reserves:usdc" };
    case "USDT":
      return { name: "USDT", risk: "low", coinId: "usdt-tether", sourceKey: "usdai-proof-of-reserves:usdt" };
    case "M":
    case "WM":
    case "M0":
      return { name: "M0 / wM Treasury assets", risk: "low", coinId: "m-m0", sourceKey: "usdai-proof-of-reserves:m0" };
    default:
      return { name: name.trim(), risk: "low", sourceKey: `usdai-proof-of-reserves:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}` };
  }
}


export function parseUsdAiProofOfReserves(raw: string): UsdAiProofOfReservesEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteUnsafeIntegerWeightFields(raw)) as unknown;
  } catch (error) {
    throw new Error(
      `usdai-proof-of-reserves payload is malformed: ${toErrorMessage(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("usdai-proof-of-reserves payload was not an array");
  }

  return parsed as UsdAiProofOfReservesEntry[];
}

export function adaptUsdAiProofOfReserves(
  entries: UsdAiProofOfReservesEntry[],
): AdapterResult {
  const warnings: LiveReserveWarning[] = [];
  const tbillBuckets = new Map<string, { share: bigint; bucket: ResolvedReserveBucket }>();
  const unknownTypes = new Set<string>();
  const chains = new Set<number>();
  const parsedEntries = entries.map((entry) => ({
    type: typeof entry.type === "string" ? entry.type.trim().toUpperCase() : "",
    name: typeof entry.name === "string" ? entry.name.trim() : "",
    chain: typeof entry.chain === "number" && Number.isFinite(entry.chain) ? entry.chain : null,
    share: parseIntegerLike(entry.share),
    amount: parseIntegerLike(entry.amount),
  }));
  const totalShareDeclared = parsedEntries.reduce(
    (acc, entry) => acc + (entry.share && entry.share > 0n ? entry.share : 0n),
    0n,
  );
  const totalAmountDeclared = parsedEntries.reduce(
    (acc, entry) => acc + (entry.amount && entry.amount > 0n ? entry.amount : 0n),
    0n,
  );
  let syntheticUndisclosedShare = 0n;
  const weightMode: WeightMode = (() => {
    if (hasFullShareCoverage(totalShareDeclared)) {
      return "share";
    }

    if (totalAmountDeclared > 0n) {
      if (totalShareDeclared > 0n) {
        warnings.push(createPartialShareCoverageWarning(totalShareDeclared));
      }
      return "amount";
    }

    if (totalShareDeclared > 0n) {
      if (totalShareDeclared < SHARE_TOTAL_SCALE) {
        warnings.push(createPartialShareCoverageWarning(totalShareDeclared));
        syntheticUndisclosedShare = SHARE_TOTAL_SCALE - totalShareDeclared;
        return "share";
      }
      throw new Error(
        `usdai-proof-of-reserves share-bearing rows cover only ${shareToPct(totalShareDeclared).toFixed(1)}% of reserves`,
      );
    }
    throw new Error("usdai-proof-of-reserves payload contained no usable share or amount weights");
  })();
  const ignoredAmountOnlyEntries = weightMode === "share"
    ? parsedEntries.filter((entry) => entry.share == null && entry.amount != null && entry.amount > 0n)
    : [];
  let dealShare = 0n;
  let unknownShare = 0n;
  let totalWeight = 0n;
  let dealCount = 0;

  for (const entry of parsedEntries) {
    const { type, name } = entry;
    const weight = weightMode === "share" ? entry.share : entry.amount;

    if (!type) {
      throw new Error("usdai-proof-of-reserves entry is missing a reserve type");
    }
    if (weight == null) {
      if (weightMode === "share" && entry.amount != null && entry.amount > 0n) {
        continue;
      }
      throw new Error(`usdai-proof-of-reserves entry is missing a valid ${weightMode}: ${name || type}`);
    }
    if (weight === 0n) continue;

    totalWeight += weight;

    if (entry.chain != null) {
      chains.add(entry.chain);
    }

    if (type === "DEAL") {
      dealShare += weight;
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
        existing.share += weight;
      } else {
        tbillBuckets.set(bucket.name, { share: weight, bucket });
      }
      continue;
    }

    unknownShare += weight;
    unknownTypes.add(type);
  }

  if (ignoredAmountOnlyEntries.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "missing-share-rows-ignored",
        `${ignoredAmountOnlyEntries.length} USD.AI reserve ${pluralizeEntries(ignoredAmountOnlyEntries.length)} `
        + `lacked composition share weights and ${pluralizeIgnoredVerb(ignoredAmountOnlyEntries.length)} ignored while share-bearing rows already covered `
        + `${shareToPct(totalShareDeclared).toFixed(2)}% of reserves`,
      ),
    );
  }

  const weightToPct = (value: bigint) => (
    weightMode === "share"
      ? shareToPct(value)
      : ratioToPct(value, totalAmountDeclared)
  );

  const sliceInputs = Array.from(tbillBuckets.values()).map(({ share, bucket }) => ({
    sourceKey: bucket.sourceKey,
    name: bucket.name,
    pct: weightToPct(share),
    risk: bucket.risk,
    ...(bucket.coinId ? { coinId: bucket.coinId } : {}),
  }));

  if (dealShare > 0n) {
    sliceInputs.push({
      sourceKey: "usdai-proof-of-reserves:deal",
      name: "GPU-backed infrastructure loans (NVIDIA hardware)",
      pct: weightToPct(dealShare),
      risk: "high",
    });
  }

  if (syntheticUndisclosedShare > 0n) {
    sliceInputs.push({
      sourceKey: "usdai-proof-of-reserves:undisclosed",
      name: "Undisclosed USD.AI reserve buckets",
      pct: weightToPct(syntheticUndisclosedShare),
      risk: "high",
    });
    warnings.push(
      reserveDegradedWarning(
        "usdai-share-coverage-gap",
        `USD.AI payload disclosed only ${shareToPct(totalShareDeclared).toFixed(1)}% of reserves; the remainder is undisclosed`,
      ),
    );
  }

  if (unknownShare > 0n) {
    sliceInputs.push({
      sourceKey: "usdai-proof-of-reserves:unknown",
      name: "Unmapped USD.AI reserve buckets",
      pct: weightToPct(unknownShare),
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
    warnings.push(buildUnknownExposureWarning({ adapterKey: "usdai-proof-of-reserves", code: "unknown-reserve-type",
    message: `Unmapped USD.AI reserve types: ${Array.from(unknownTypes).sort().join(", ")}`,
    unknownExposurePct: weightToPct(unknownShare), }));
  }
  const unknownExposureWeight = unknownShare + syntheticUndisclosedShare;

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      apiEntryCount: entries.length,
      liquidBucketCount: tbillBuckets.size,
      dealCount,
      weightingBasis: weightMode,
      ...(weightMode === "share" ? { declaredSharePct: shareToPct(totalShareDeclared) } : {}),
      unknownTypeCount: unknownTypes.size,
      ...(tbillBuckets.size > 0 ? { liquidReserveLabels: Array.from(tbillBuckets.keys()) } : {}),
      ...(chains.size > 0 ? { chains: Array.from(chains).sort((a, b) => a - b) } : {}),
      ...(unknownTypes.size > 0 ? { unknownReserveTypes: Array.from(unknownTypes).sort() } : {}),
      ...(ignoredAmountOnlyEntries.length > 0 ? { ignoredMissingShareEntryCount: ignoredAmountOnlyEntries.length } : {}),
      ...(totalWeight > 0n || syntheticUndisclosedShare > 0n ? { unknownExposurePct: weightToPct(unknownExposureWeight) } : {}),
      ...unverifiedFreshnessMetadata(
        "usdai-proof-of-reserves-api",
        "USD.AI proof-of-reserves API does not expose a trustworthy source timestamp",
      ),
    },
  };
}

// PoR amounts use 18 decimals, including the 6-decimal PYUSD liquid sleeve.
// Document-update times describe GPU paperwork, not this accounting state.
async function anchorUsdAiComposition(
  entries: UsdAiProofOfReservesEntry[],
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<{ metadata?: AdapterResult["metadata"]; warning?: LiveReserveWarning }> {
  const params = parseLiveReserveAdapterParams("usdai-proof-of-reserves", config.params);
  const anchor = params.anchor;
  if (!anchor) throw new Error("on-chain anchor is not configured");
  const mismatch = (message: string) => ({
    warning: reserveDegradedWarning("usdai-anchor-mismatch", `USD.AI on-chain anchor: ${message}`),
  });
  const liquidRows = entries.filter((entry) => entry.type?.trim().toUpperCase() === "TBILL");
  const matchedRows = anchor.liquidReserves.map((reserve) => liquidRows.filter((row) =>
    row.name?.trim().toUpperCase() === reserve.name.toUpperCase()
    && row.chain === 42161
    && typeof row.reserveLink === "string"
    // eslint-disable-next-line security/detect-non-literal-regexp -- tokenAddress is adapter-owned reviewed anchor config, not user input.
    && new RegExp(`^https://arbiscan\\.io/token/${reserve.tokenAddress}(?:[?#/]|$)`, "i").test(row.reserveLink),
  ));
  if (liquidRows.length !== anchor.liquidReserves.length || matchedRows.some((rows) => rows.length !== 1)
    || new Set(matchedRows.map((rows) => rows[0])).size !== liquidRows.length) {
    return mismatch("liquid reserve identities do not match the reviewed token links");
  }
  const results = await fetchOnchainMulticall3({
    chain: "arbitrum", signal, ctx,
    rpcUrl: params.rpcUrl, fallbackRpcUrl: params.fallbackRpcUrl,
    // Keep every observation, including the block evidence, in one EVM call.
    multicallBatchSize: 32,
    calls: [
      // Arbitrum block.number is an L1 estimate; ArbSys returns the actual L2 block.
      { label: "block", contract: "0x0000000000000000000000000000000000000064", data: "0xa3b1b31d" },
      { label: "timestamp", contract: MULTICALL3_ADDRESS, data: "0x0f28c97d" },
      { label: "asset", contract: anchor.vaultAddress, data: ERC4626_ASSET_SELECTOR },
      { label: "assets", contract: anchor.vaultAddress, data: ERC4626_TOTAL_ASSETS_SELECTOR },
      { label: "supply", contract: anchor.vaultAddress, data: TOTAL_SUPPLY_SELECTOR },
      { label: "vault-decimals", contract: anchor.vaultAddress, data: DECIMALS_SELECTOR },
      { label: "asset-decimals", contract: anchor.assetAddress, data: DECIMALS_SELECTOR },
      ...anchor.liquidReserves.flatMap((reserve, index) => [
        { label: `balance-${index}`, contract: reserve.tokenAddress, data: encodeBalanceOfCallData(reserve.holderAddress) },
        { label: `decimals-${index}`, contract: reserve.tokenAddress, data: DECIMALS_SELECTOR },
      ]),
    ],
  });
  if (!results) throw new Error("Multicall3 is unavailable");
  const uint = (label: string) => {
    const value = decodeUint256Word(multicallResultByLabel(results, label));
    if (value == null) throw new Error(`${label} returned no valid uint256`);
    return value;
  };
  const block = uint("block");
  const timestamp = uint("timestamp");
  const totalAssets = uint("assets");
  const totalSupply = uint("supply");
  if (block <= 0n || timestamp <= 0n || block > BigInt(Number.MAX_SAFE_INTEGER) || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("invalid observed block evidence");
  }
  if (decodeStrictAddressWord(multicallResultByLabel(results, "asset"))?.toLowerCase() !== anchor.assetAddress.toLowerCase()
    || uint("vault-decimals") !== 18n || uint("asset-decimals") !== 18n) {
    return mismatch("vault asset or decimals changed");
  }
  if (totalAssets <= 0n || totalSupply <= 0n) return mismatch("vault has zero assets or shares");
  const withinTolerance = (actual: bigint, expected: bigint) =>
    (actual > expected ? actual - expected : expected - actual) * 10_000n <= expected * BigInt(anchor.toleranceBps);
  const totalShare = entries.reduce((sum, row) => sum + (parseIntegerLike(row.share) ?? 0n), 0n);
  if (!withinTolerance(totalShare, SHARE_SCALE)) return mismatch("composition shares are incomplete");
  const checkedRows = [];
  let totalLiquidBalance = 0n;
  for (const [index, reserve] of anchor.liquidReserves.entries()) {
    const row = matchedRows[index][0];
    const amount = parseIntegerLike(row.amount);
    const share = parseIntegerLike(row.share);
    if (amount == null || share == null) return mismatch("liquid row lacks usable amount/share accounting");
    if (uint(`decimals-${index}`) !== BigInt(reserve.decimals)) return mismatch(`${reserve.name} decimals changed`);
    const balance = uint(`balance-${index}`) * 10n ** BigInt(18 - reserve.decimals);
    totalLiquidBalance += balance;
    if (!withinTolerance(amount, balance) || !withinTolerance(share * totalAssets, balance * SHARE_SCALE)) {
      return mismatch(`${reserve.name} exceeds ${anchor.toleranceBps} bps tolerance at block ${block}: amount=${amount}, balance=${balance}, share=${share}, vaultAssets=${totalAssets} (18-decimal accounting)`);
    }
    checkedRows.push({ name: reserve.name, tokenAddress: reserve.tokenAddress, amountRaw: amount.toString(), balanceRaw: balance.toString() });
  }
  if (totalLiquidBalance <= 0n) return mismatch("no positive liquid exposure can anchor the composition");
  return {
    metadata: {
      ...notApplicableFreshnessMetadata({
        freshnessSource: "same-run-onchain",
        anchor: {
          block: Number(block), checkedRows, tolerance: anchor.toleranceBps / 10_000,
          totalAssetsRaw: totalAssets.toString(), totalSupplyRaw: totalSupply.toString(),
        },
      }),
      observedBlock: { number: Number(block), timestamp: Number(timestamp) },
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
  const entries = parseUsdAiProofOfReserves(await fetchTextWithRetry(input.url, signal, 12_000, ctx));
  const result = adaptUsdAiProofOfReserves(entries);
  try {
    const anchor = await anchorUsdAiComposition(entries, config, signal, ctx);
    if (anchor.metadata) result.metadata = { ...result.metadata, ...anchor.metadata };
    if (anchor.warning) result.warnings = [...(result.warnings ?? []), anchor.warning];
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.warnings = [...(result.warnings ?? []), reserveDegradedWarning(
      "usdai-anchor-unavailable",
      `USD.AI composition remains unverified: ${toErrorMessage(error)}`,
    )];
  }
  return result;
}
