import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  buildCoverageShortfallWarnings,
  fetchIcrcLedgerTotalSupply,
  notApplicableFreshnessMetadata,
  requireJsonInput,
} from "./helpers";
import {
  decodeCandidReply,
  icpLabelId,
  icpLebEncode,
  icpPrincipalBytes,
  icpPrincipalText,
  queryIcpCanister,
} from "./icp";

const ADAPTER_KEY = "icp-gldt";
const GOLD_SOURCE_KEY = "icp-gldt:locked-gld-nft";
const PROOF_KIND = "icp-gldt-swap-locked-nfts";

// GLDT is minted 1:1 against locked GLD NFTs at a fixed 100 GLDT per gram
// (1 GLDT = 0.01 g of fine gold). Both the ledger supply and the swap-config
// `division` field are expressed in 8-dp base units, so a gram is 10^10 of
// them. The same gram-unit convention as chainlink-por's XAU_G applies.
const GLDT_DECIMALS = 8;
const GLDT_PER_GRAM = 100;
const BASE_UNITS_PER_GLDT = 10n ** BigInt(GLDT_DECIMALS);
const BASE_UNITS_PER_GRAM = BASE_UNITS_PER_GLDT * BigInt(GLDT_PER_GRAM);

// `FractionalizationConfig` case names from the swap canister's candid interface
// (`get_swap_configs`). GLDT's GLD bars are uniform, so only `General` is supported.
const GENERAL_FRACTIONALIZATION_CASE = "General";

type IcpGldtParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

export interface IcpGldtSwapConfig {
  /** ORIGYN ICRC-7 canister holding one GLD NFT denomination (text principal). */
  canisterId: string;
  /** GLDT base units minted per locked NFT (e.g. 10^10 = 1 g = 100 GLDT). */
  divisionBaseUnits: bigint;
  /** Per-swap fee in GLDT base units (diagnostic only). */
  swapFeeBaseUnits: bigint;
  /** The ICRC-1 GLDT ledger the config fractionalizes against (text principal). */
  ledgerId: string;
}

export interface IcpGldtState {
  swapConfigs: IcpGldtSwapConfig[];
  /** Number of NFTs the swap canister holds per config, parallel to `swapConfigs`. */
  balances: bigint[];
  /** GLDT ledger `icrc1_total_supply` in 8-dp base units. */
  supplyBaseUnits: bigint;
  /** Certified state time of the swap-config read, in nanoseconds since epoch. */
  certifiedTimeNanos: bigint | null;
}

function toBigInt(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") {
    throw new Error(`${ADAPTER_KEY}: ${label} is not a candid nat`);
  }
  return value;
}

function principalBytesToText(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new Error(`${ADAPTER_KEY}: swap config principal is not a byte blob`);
  }
  return icpPrincipalText(value);
}

/**
 * One field of a hash-keyed Candid record (see `decodeCandidReply`). The canister's
 * declared field order is not stable, so every field is read by its candid label;
 * a record that changed shape fails closed instead of shifting values into the
 * wrong slots.
 */
function candidField(record: unknown, label: string): unknown {
  if (!(record instanceof Map)) {
    throw new Error(`${ADAPTER_KEY}: swap config field ${label} is not inside a candid record`);
  }
  const value = record.get(icpLabelId(label));
  if (value === undefined) {
    throw new Error(`${ADAPTER_KEY}: swap config record is missing its ${label} field`);
  }
  return value;
}

/** Decode the `vec SwapCanisterConfig` reply into normalized configs. */
export function parseIcpGldtSwapConfigs(decoded: unknown[]): IcpGldtSwapConfig[] {
  const configs = decoded[0];
  if (!Array.isArray(configs)) {
    throw new Error(`${ADAPTER_KEY}: get_swap_configs returned no config vector`);
  }
  return configs.map((entry) => {
    const canisterId = principalBytesToText(candidField(entry, "icrc7_canister_id"));
    const fractionalization = candidField(entry, "fractionalization_config");
    if (!(fractionalization instanceof Map)) {
      throw new Error(`${ADAPTER_KEY}: malformed fractionalization config`);
    }
    const general = fractionalization.get(icpLabelId(GENERAL_FRACTIONALIZATION_CASE));
    if (general === undefined) {
      throw new Error(`${ADAPTER_KEY}: custom (per-token) fractionalization config is not supported`);
    }
    return {
      canisterId,
      divisionBaseUnits: toBigInt(candidField(general, "division"), "division"),
      swapFeeBaseUnits: toBigInt(candidField(general, "swap_fee"), "swap_fee"),
      ledgerId: principalBytesToText(candidField(general, "ledger_id")),
    };
  });
}

/** Decode the `vec nat` reply into the first balance (we query one account). */
function parseBalance(decoded: unknown[]): bigint {
  const balances = decoded[0];
  if (!Array.isArray(balances) || balances.length === 0) {
    throw new Error(`${ADAPTER_KEY}: icrc7_balance_of returned no balance`);
  }
  return toBigInt(balances[0], "balance");
}

function concatBytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const total = parts.reduce((acc, part) => acc + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `get_swap_configs : (null) -> (vec SwapCanisterConfig)` — a single `null` arg. */
function encodeNullArg(): Uint8Array {
  // DIDL magic, empty type table, one `null` argument (opcode -1 = 0x7f).
  return Uint8Array.from([0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x7f]);
}

/** `icrc7_balance_of : (vec Account) -> (vec nat)` with one owner account and
 *  no subaccount. The argument type table is hand-built to match the ORIGYN
 *  ICRC-7 `Account = record { owner : principal; subaccount : opt blob }`:
 *  record fields must reference composite types by table index (the canister's
 *  Rust candid parser rejects an inline `opt` opcode), and their hashes ascend. */
export function encodeIcpGldtBalanceOfArg(ownerCanisterId: string): Uint8Array {
  const ownerBytes = icpPrincipalBytes(ownerCanisterId);
  const ownerHash = icpLebEncode(BigInt(icpLabelId("owner")));
  const subaccountHash = icpLebEncode(BigInt(icpLabelId("subaccount")));
  return concatBytes(
    [0x44, 0x49, 0x44, 0x4c], // DIDL magic
    [
      0x04, // 4 type-table entries
      0x6d, 0x7b, // 0: vec nat8 (blob)
      0x6e, 0x00, // 1: opt -> 0
      0x6c, 0x02, // 2: record, 2 fields
      ...ownerHash, 0x68, //     "owner" -> principal
      ...subaccountHash, 0x01, //     "subaccount" -> 1 (opt blob)
      0x6d, 0x02, // 3: vec -> 2 (vec Account)
    ],
    [0x01, 0x03], // 1 arg of type 3
    [0x01], // vec length 1
    [0x01, ...icpLebEncode(BigInt(ownerBytes.length)), ...ownerBytes], // principal
    [0x00], // subaccount = opt null
  );
}

export function adaptIcpGldtState(state: IcpGldtState, params: IcpGldtParams): AdapterResult {
  if (state.swapConfigs.length === 0) {
    throw new Error(`${ADAPTER_KEY}: get_swap_configs returned no canister configs`);
  }
  if (state.balances.length !== state.swapConfigs.length) {
    throw new Error(`${ADAPTER_KEY}: balance read count does not match swap config count`);
  }
  if (state.supplyBaseUnits <= 0n) {
    throw new Error(`${ADAPTER_KEY}: GLDT ledger supply is not positive`);
  }

  // Every config must fractionalize against the pinned GLDT ledger. A config
  // pointing at another ledger would make the locked-NFT census measure a
  // different liability than the one we read supply for — fail closed.
  for (const config of state.swapConfigs) {
    if (config.ledgerId !== params.ledgerCanisterId) {
      throw new Error(
        `${ADAPTER_KEY}: swap config for canister ${config.canisterId} targets ledger ` +
        `${config.ledgerId}, expected ${params.ledgerCanisterId}`,
      );
    }
    if (config.divisionBaseUnits <= 0n) {
      throw new Error(`${ADAPTER_KEY}: swap config for canister ${config.canisterId} has a non-positive division`);
    }
  }

  let lockedBaseUnits = 0n;
  const positions: Array<Record<string, unknown>> = [];
  for (let index = 0; index < state.swapConfigs.length; index++) {
    const config = state.swapConfigs[index]!;
    const balance = state.balances[index]!;
    if (balance < 0n) {
      throw new Error(`${ADAPTER_KEY}: icrc7_balance_of for canister ${config.canisterId} is negative`);
    }
    lockedBaseUnits += balance * config.divisionBaseUnits;
    positions.push({
      canisterId: config.canisterId,
      balance: balance.toString(),
      divisionBaseUnits: config.divisionBaseUnits.toString(),
      swapFeeBaseUnits: config.swapFeeBaseUnits.toString(),
      lockedGrams: Number(balance * config.divisionBaseUnits) / Number(BASE_UNITS_PER_GRAM),
    });
  }

  if (lockedBaseUnits <= 0n) {
    throw new Error(`${ADAPTER_KEY}: the swap canister holds no locked GLD NFTs`);
  }

  const lockedBaseUnitsNum = Number(lockedBaseUnits);
  const supplyBaseUnitsNum = Number(state.supplyBaseUnits);
  const lockedGrams = lockedBaseUnitsNum / Number(BASE_UNITS_PER_GRAM);
  const supplyTokens = supplyBaseUnitsNum / Number(BASE_UNITS_PER_GLDT);
  const supplyGrams = supplyBaseUnitsNum / Number(BASE_UNITS_PER_GRAM);
  const collateralizationRatio = supplyBaseUnitsNum > 0 ? lockedBaseUnitsNum / supplyBaseUnitsNum : undefined;

  const warnings: LiveReserveWarning[] = buildCoverageShortfallWarnings({
    code: "reserve-undercollateralized",
    message: (pct) => `GLDT locked GLD NFTs cover ${pct}% of GLDT supply in fine gold grams`,
    coverageRatio: collateralizationRatio,
  });

  const certifiedStateTimeSec = state.certifiedTimeNanos != null
    ? Number(state.certifiedTimeNanos / 1_000_000_000n)
    : undefined;

  const slices: ReserveSlice[] = [{
    sourceKey: GOLD_SOURCE_KEY,
    name: params.label,
    pct: 100,
    risk: params.risk,
  }];

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...notApplicableFreshnessMetadata(),
      reserveUnit: "XAU_G",
      reserveUnitLabel: "grams of fine gold",
      totalReserveQuantity: lockedGrams,
      supplyTokens,
      ...(collateralizationRatio !== undefined ? { collateralizationRatio } : {}),
      details: {
        proofKind: PROOF_KIND,
        reserveUnit: "XAU_G",
        swapCanisterId: params.swapCanisterId,
        ledgerCanisterId: params.ledgerCanisterId,
        lockedGrams,
        supplyGrams,
        lockedBaseUnits: lockedBaseUnits.toString(),
        supplyBaseUnits: state.supplyBaseUnits.toString(),
        ...(certifiedStateTimeSec !== undefined ? { certifiedStateTimeSec } : {}),
        positions,
      },
    },
  };
}

export async function fetchIcpGldtReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params: IcpGldtParams = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  requireJsonInput(config.inputs.primary, ADAPTER_KEY);

  // The swap config and the ledger supply are independent; both go through the
  // adapter I/O limiter alongside the four NFT balance reads (≤3 waves at the
  // two-op limit because the balance queries fan out only after the config).
  const [swapQuery, supplyBaseUnits] = await Promise.all([
    queryIcpCanister({
      canisterId: params.swapCanisterId,
      methodName: "get_swap_configs",
      arg: encodeNullArg(),
      signal,
      ctx,
    }),
    fetchIcrcLedgerTotalSupply({ canisterId: params.ledgerCanisterId, signal, ctx }),
  ]);

  if (swapQuery.rejectMessage != null) {
    throw new Error(`${ADAPTER_KEY}: get_swap_configs was rejected: ${swapQuery.rejectMessage}`);
  }
  if (swapQuery.reply == null) {
    throw new Error(`${ADAPTER_KEY}: get_swap_configs returned no reply`);
  }
  if (supplyBaseUnits == null) {
    throw new Error(`${ADAPTER_KEY}: GLDT ledger supply could not be read`);
  }

  const swapConfigs = parseIcpGldtSwapConfigs(decodeCandidReply(swapQuery.reply));

  const balanceQueries = await Promise.all(
    swapConfigs.map((config) =>
      queryIcpCanister({
        canisterId: config.canisterId,
        methodName: "icrc7_balance_of",
        arg: encodeIcpGldtBalanceOfArg(params.swapCanisterId),
        signal,
        ctx,
      }),
    ),
  );

  const balances = balanceQueries.map((query, index) => {
    if (query.rejectMessage != null) {
      throw new Error(
        `${ADAPTER_KEY}: icrc7_balance_of on ${swapConfigs[index]!.canisterId} was rejected: ${query.rejectMessage}`,
      );
    }
    if (query.reply == null) {
      throw new Error(`${ADAPTER_KEY}: icrc7_balance_of on ${swapConfigs[index]!.canisterId} returned no reply`);
    }
    return parseBalance(decodeCandidReply(query.reply));
  });

  return adaptIcpGldtState(
    {
      swapConfigs,
      balances,
      supplyBaseUnits,
      certifiedTimeNanos: swapQuery.certifiedTimeNanos,
    },
    params,
  );
}
