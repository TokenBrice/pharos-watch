import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { throwIfAborted } from "../../lib/abort";
import {
  decimalNumberFromBigInt,
  notApplicableFreshnessMetadata,
  requireJsonInput,
  reserveInfoWarning,
} from "./helpers";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "./request";
import type { AdapterContext, AdapterResult } from "./types";

const ADAPTER = "initia-wrapper-vault" as const;
type InitiaWrapperVaultParams = LiveReserveAdapterParamsByKey[typeof ADAPTER];
const MOVE_METADATA_TYPE = "0x1::fungible_asset::Metadata";
const MOVE_OBJECT_CORE_TYPE = "0x1::object::ObjectCore";
const MOVE_VIEW_URL = "/initia/move/v1/view/json";
const BANK_SUPPLY_URL = "/cosmos/bank/v1beta1/supply/by_denom";
const RESOURCES_BY_STRUCT_TAG_URL = "/initia/move/v1/accounts";
const EXPECTED_AUSD0_SYMBOL = "AUSD0";
const EXPECTED_AUSD0_PROJECT_URI = "https://www.agora.finance";

/**
 * The two reviewed heights showed the parent supply exceeding iUSD supply by
 * about 2.56 AUSD0. Keep a small, explicit base-unit tolerance for that stable
 * parent-side dust instead of rounding the live coverage ratio to 100%.
 *
 * The adapter reads the vault's balance, not the parent's total supply, so a
 * balance surplus within this tolerance is informational and keeps its exact
 * collateralizationRatio. Any shortfall or larger surplus is withheld.
 */
const DUST_TOLERANCE_RAW = 5_000_000n;
const DUST_TOLERANCE_TOKENS = 5;

interface InitiaViewResponse {
  data?: unknown;
}

interface InitiaSupplyResponse {
  amount?: unknown;
}

interface InitiaResourceEnvelope {
  resource?: {
    address?: unknown;
    struct_tag?: unknown;
    move_resource?: unknown;
  };
}

interface ParsedMoveResource {
  type: string;
  data: Record<string, unknown>;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${ADAPTER}: ${label} is missing or malformed`);
  }
  return value as Record<string, unknown>;
}

function parseMoveResource(value: unknown, label: string): ParsedMoveResource {
  if (typeof value !== "string") {
    throw new Error(`${ADAPTER}: ${label} move_resource is missing or malformed`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`${ADAPTER}: ${label} move_resource is not valid JSON`);
  }
  const resource = readRecord(decoded, `${label} move_resource`);
  const type = resource.type;
  const data = readRecord(resource.data, `${label} move_resource.data`);
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(`${ADAPTER}: ${label} move_resource.type is missing`);
  }
  return { type, data };
}

function assertResourceIdentity(
  response: InitiaResourceEnvelope,
  expectedAddress: string,
  expectedStructTag: string,
  label: string,
): ParsedMoveResource {
  const resource = readRecord(response.resource, `${label} resource`);
  if (resource.address !== expectedAddress) {
    throw new Error(
      `${ADAPTER}: ${label} address mismatch (expected ${expectedAddress}, got ${String(resource.address)})`,
    );
  }
  if (resource.struct_tag !== expectedStructTag) {
    throw new Error(
      `${ADAPTER}: ${label} struct tag mismatch (expected ${expectedStructTag}, got ${String(resource.struct_tag)})`,
    );
  }
  const parsed = parseMoveResource(resource.move_resource, label);
  if (parsed.type !== expectedStructTag) {
    throw new Error(
      `${ADAPTER}: ${label} move resource type mismatch (expected ${expectedStructTag}, got ${parsed.type})`,
    );
  }
  return parsed;
}

function parseRawUnsigned(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${ADAPTER}: ${label} must be a non-negative integer string`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${ADAPTER}: ${label} is outside the supported integer range`);
  }
}

/** Initia's JSON view wraps the u64 return value in an escaped JSON string. */
function parseViewBalance(response: InitiaViewResponse): bigint {
  if (typeof response.data !== "string") {
    throw new Error(`${ADAPTER}: view response data is missing or malformed`);
  }

  let value: unknown = response.data;
  try {
    const decoded = JSON.parse(response.data);
    if (typeof decoded === "string") {
      value = decoded;
    }
  } catch {
    // Some compatible LCD proxies return the unescaped numeric string directly.
    // It is still checked strictly below; arbitrary text never becomes zero.
  }
  return parseRawUnsigned(value, "vault AUSD0 balance");
}

function parseBankSupply(response: InitiaSupplyResponse, expectedDenom: string): bigint {
  const amount = readRecord(response.amount, "bank supply amount");
  if (amount.denom !== expectedDenom) {
    throw new Error(
      `${ADAPTER}: iUSD denom mismatch (expected ${expectedDenom}, got ${String(amount.denom)})`,
    );
  }
  return parseRawUnsigned(amount.amount, "iUSD bank supply");
}

function readSlice(params: InitiaWrapperVaultParams): ReserveSlice {
  if (params.slice.coinId !== "ausd-agora" || params.slice.depType !== "wrapper") {
    throw new Error(`${ADAPTER}: slice must target ausd-agora with depType wrapper`);
  }
  return {
    name: params.slice.name,
    pct: 100,
    risk: params.slice.risk,
    coinId: "ausd-agora",
    depType: "wrapper",
  };
}

function readAUsd0Metadata(
  response: InitiaResourceEnvelope,
  params: InitiaWrapperVaultParams,
): { name: string; symbol: string; decimals: number; projectUri: string } {
  const metadata = assertResourceIdentity(
    response,
    params.ausd0MetadataAddress,
    MOVE_METADATA_TYPE,
    "AUSD0 metadata",
  );
  const name = metadata.data.name;
  const symbol = metadata.data.symbol;
  const decimals = metadata.data.decimals;
  const projectUri = metadata.data.project_uri;
  if (
    typeof name !== "string" ||
    typeof symbol !== "string" ||
    name !== EXPECTED_AUSD0_SYMBOL ||
    symbol !== EXPECTED_AUSD0_SYMBOL
  ) {
    throw new Error(`${ADAPTER}: AUSD0 metadata symbol/name mismatch`);
  }
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals !== params.decimals || params.decimals !== 6) {
    throw new Error(
      `${ADAPTER}: AUSD0 metadata decimals mismatch (expected ${params.decimals}, got ${String(decimals)})`,
    );
  }
  if (typeof projectUri !== "string" || projectUri !== EXPECTED_AUSD0_PROJECT_URI) {
    throw new Error(
      `${ADAPTER}: AUSD0 metadata project_uri mismatch (expected ${EXPECTED_AUSD0_PROJECT_URI}, got ${String(projectUri)})`,
    );
  }
  return { name, symbol, decimals, projectUri };
}

export async function fetchInitiaWrapperVaultReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER);
  const params = parseLiveReserveAdapterParams(ADAPTER, config.params);
  const lcdUrl = params.lcdUrl.replace(/\/+$/, "");
  const denomMetadataAddress = params.iusdDenom.startsWith("move/")
    ? `0x${params.iusdDenom.slice("move/".length)}`
    : "";
  if (denomMetadataAddress !== params.iusdMetadataAddress) {
    throw new Error(
      `${ADAPTER}: iUSD denom and metadata address do not identify the same asset`,
    );
  }
  if (input.url.replace(/\/+$/, "") !== lcdUrl) {
    throw new Error(`${ADAPTER}: primary input URL does not match params.lcdUrl`);
  }
  const slice = readSlice(params);

  // Keep these four reads sequential. The trigger-wide budget limits concurrent
  // header waits; identity correctness is worth four single-connection reads.
  throwIfAborted(signal);
  const viewResponse = await fetchJsonPostWithRetry<InitiaViewResponse>(
    `${lcdUrl}${MOVE_VIEW_URL}`,
    {
      address: "0x1",
      module_name: "primary_fungible_store",
      function_name: "balance",
      type_args: [MOVE_METADATA_TYPE],
      // Initia's ViewJSON args are JSON-stringified Move values. These two
      // authored object identities are therefore part of every balance read.
      args: [JSON.stringify(params.vaultOwnerAddress), JSON.stringify(params.ausd0MetadataAddress)],
    },
    signal,
    12_000,
    ctx,
  );
  const vaultBalanceRaw = parseViewBalance(viewResponse);
  if (vaultBalanceRaw <= 0n) {
    throw new Error(`${ADAPTER}: vault AUSD0 balance is zero for ${coin.id}`);
  }

  throwIfAborted(signal);
  const supplyResponse = await fetchJsonWithRetry<InitiaSupplyResponse>(
    `${lcdUrl}${BANK_SUPPLY_URL}?denom=${encodeURIComponent(params.iusdDenom)}`,
    signal,
    12_000,
    ctx,
  );
  const iusdSupplyRaw = parseBankSupply(supplyResponse, params.iusdDenom);
  if (iusdSupplyRaw <= 0n) {
    throw new Error(`${ADAPTER}: iUSD bank supply is zero for ${coin.id}`);
  }

  throwIfAborted(signal);
  const iusdIdentity = await fetchJsonWithRetry<InitiaResourceEnvelope>(
    `${lcdUrl}${RESOURCES_BY_STRUCT_TAG_URL}/${params.iusdMetadataAddress}/resources/by_struct_tag?struct_tag=${encodeURIComponent(MOVE_OBJECT_CORE_TYPE)}`,
    signal,
    12_000,
    ctx,
  );
  const iusdObjectCore = assertResourceIdentity(
    iusdIdentity,
    params.iusdMetadataAddress,
    MOVE_OBJECT_CORE_TYPE,
    "iUSD ObjectCore",
  );
  if (iusdObjectCore.data.owner !== params.vaultOwnerAddress) {
    throw new Error(
      `${ADAPTER}: iUSD metadata owner mismatch (expected ${params.vaultOwnerAddress}, got ${String(iusdObjectCore.data.owner)})`,
    );
  }

  throwIfAborted(signal);
  // The metadata object is mutable: the params and view arg pin which object
  // was requested, while this live read proves it still identifies Agora AUSD0
  // with the authored six-decimal representation.
  const ausd0MetadataResponse = await fetchJsonWithRetry<InitiaResourceEnvelope>(
    `${lcdUrl}${RESOURCES_BY_STRUCT_TAG_URL}/${params.ausd0MetadataAddress}/resources/by_struct_tag?struct_tag=${encodeURIComponent(MOVE_METADATA_TYPE)}`,
    signal,
    12_000,
    ctx,
  );
  const ausd0Metadata = readAUsd0Metadata(ausd0MetadataResponse, params);

  const supplyTokens = decimalNumberFromBigInt(iusdSupplyRaw, params.decimals);
  const vaultBalanceTokens = decimalNumberFromBigInt(vaultBalanceRaw, params.decimals);
  const collateralizationRatio = Number(vaultBalanceRaw) / Number(iusdSupplyRaw);
  if (!Number.isFinite(supplyTokens) || !Number.isFinite(vaultBalanceTokens) || !Number.isFinite(collateralizationRatio)) {
    throw new Error(`${ADAPTER}: reserve values are outside the supported numeric range`);
  }

  if (vaultBalanceRaw < iusdSupplyRaw) {
    throw new Error(
      `${ADAPTER}: vault balance is under iUSD supply (${vaultBalanceRaw} < ${iusdSupplyRaw}; coverage ${collateralizationRatio})`,
    );
  }
  const surplusRaw = vaultBalanceRaw - iusdSupplyRaw;
  if (surplusRaw > DUST_TOLERANCE_RAW) {
    throw new Error(
      `${ADAPTER}: vault/iUSD surplus exceeds ${DUST_TOLERANCE_TOKENS} ${EXPECTED_AUSD0_SYMBOL} dust tolerance (${surplusRaw} raw units)`,
    );
  }

  const warnings = surplusRaw > 0n
    ? [reserveInfoWarning(
        "reserve-overcollateralized-dust",
        `${coin.id} vault exceeds iUSD supply by ${decimalNumberFromBigInt(surplusRaw, params.decimals)} AUSD0 within the ${DUST_TOLERANCE_TOKENS} AUSD0 tolerance`,
      )]
    : undefined;

  return {
    slices: [slice],
    ...(warnings ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata({ proofKind: "initia-move-view" }),
      supplyTokens,
      totalReserveQuantity: vaultBalanceTokens,
      collateralizationRatio,
      details: {
        proofKind: "initia-wrapper-vault-balance-vs-bank-supply",
        vaultBalanceRaw: vaultBalanceRaw.toString(),
        iusdSupplyRaw: iusdSupplyRaw.toString(),
        surplusRaw: surplusRaw.toString(),
        dustToleranceRaw: DUST_TOLERANCE_RAW.toString(),
        vaultOwnerAddress: params.vaultOwnerAddress,
        iusdMetadataAddress: params.iusdMetadataAddress,
        iusdDenom: params.iusdDenom,
        ausd0MetadataAddress: params.ausd0MetadataAddress,
        ausd0Metadata,
      },
    },
  };
}
