import type { ReserveSlice } from "@shared/types/reserves";
import type { ReserveAdapterCoin } from "@shared/types/stablecoin-meta-schemas";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { CHAIN_META, resolveChainId } from "@shared/types/chain-identity";
import { SUPPLY_RPC_DEFAULTS } from "@shared/lib/chain-rpc-registry";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { sha256Hex } from "@shared/lib/sha256";
import { throwIfAborted } from "../../lib/abort";
import { DECIMALS_SELECTOR, encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import { fetchEvmMulticall3Aggregate3AtBlock, fetchEvmUint256AtBlock, parseUint256Hex } from "../../lib/evm-rpc";
import type { AdapterContext, AdapterResult } from "./types";
import { runAdapterIo } from "./concurrency";
import {
  buildRedemptionSnapshotMetadata,
  buildUnknownExposureWarning,
  catchAndWarn,
  computeUnknownExposurePct,
  decimalNumberFromBigInt,
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  normalizeSlices,
  parseTimestampLikeToUnixSeconds,
  reconcileRowsWithSourceTotal,
  reserveDegradedWarning,
  reserveFatalWarning,
  reserveInfoWarning,
  SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT,
} from "./helpers";

interface BalanceSheetAsset {
  tokenSymbol: string;
  totalValueUsd: number;
  tokenQuantity?: number;
  tokenQuantityE18?: string;
  description?: string;
  category?: string;
  chain?: string;
  address?: string;
  contractAddress?: string;
  tokenAddress?: string;
}

export interface FraxBalanceSheetResponse {
  asOfBlock?: Record<string, number>;
  asOfTimestamp?: string;
  tokenPriceUsd?: Partial<Record<string, number>>;
  totalAssets?: number;
  assets?: BalanceSheetAsset[];
}

interface TokenDisplayConfig {
  label: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
}

const TOKEN_DISPLAY: Record<string, TokenDisplayConfig> = {
  AUSD: { label: "AUSD (Agora Dollar)", risk: getCanonicalReserveAssetRisk("AUSD") ?? "low" },
  AVAX: { label: "AVAX", risk: getCanonicalReserveAssetRisk("AVAX") ?? "high" },
  WTGXX: {
    label: "WTGXX (WisdomTree Government Money Market)",
    risk: "low",
    coinId: "wtgxx-wisdomtree",
  },
  USTB: {
    label: "USTB (Superstate tokenized T-bills)",
    risk: getCanonicalReserveAssetRisk("USTB") ?? "low",
    coinId: "ustb-superstate",
  },
  BUIDL: {
    label: "BUIDL (BlackRock tokenized T-bills)",
    risk: getCanonicalReserveAssetRisk("BUIDL") ?? "low",
    coinId: "buidl-blackrock",
  },
  CVX: { label: "CVX", risk: "very-high" },
  CRV: { label: "CRV", risk: getCanonicalReserveAssetRisk("CRV") ?? "very-high" },
  CHR: { label: "CHR", risk: "very-high" },
  DAI: { label: "DAI", risk: getCanonicalReserveAssetRisk("DAI") ?? "low", coinId: "dai-makerdao" },
  EREBOR_USD: {
    label: "EREBOR_USD (Erebor Bank frxUSD reserve account)",
    risk: "very-low",
  },
  ETH: { label: "ETH", risk: getCanonicalReserveAssetRisk("ETH") ?? "very-low" },
  FPI: { label: "FPI", risk: "medium" },
  FRAX: { label: "FRAX", risk: getCanonicalReserveAssetRisk("FRAX") ?? "low", coinId: "frax-frax" },
  FXS: { label: "FXS", risk: "high" },
  LFRAX: { label: "LFRAX", risk: "medium" },
  MULTI: { label: "MULTI", risk: "very-high" },
  MATIC: { label: "MATIC", risk: "high" },
  OP: { label: "OP", risk: "high" },
  PYUSD: { label: "PYUSD", risk: getCanonicalReserveAssetRisk("PYUSD") ?? "low", coinId: "pyusd-paypal" },
  RAM: { label: "RAM", risk: "very-high" },
  SDT: { label: "SDT", risk: "very-high" },
  THE: { label: "THE", risk: "very-high" },
  USDB: { label: "USDB (Bridge)", risk: "low" },
  USDC: { label: "USDC (Circle)", risk: "low", coinId: "usdc-circle" },
  USCC: { label: "USCC (Superstate crypto arbitrage)", risk: "medium" },
  USDS: { label: "USDS", risk: getCanonicalReserveAssetRisk("USDS") ?? "low", coinId: "usds-sky" },
  USDT: { label: "USDT", risk: getCanonicalReserveAssetRisk("USDT") ?? "low", coinId: "usdt-tether" },
  USDe: { label: "USDe", risk: "high", coinId: "usde-ethena" },
  WAVAX: { label: "WAVAX", risk: "high" },
  VELO: { label: "VELO (locked veNFT #4976)", risk: "very-high" },
  BNB: { label: "BNB", risk: "high" },
  WBNB: { label: "WBNB", risk: "high" },
  WETH: { label: "WETH", risk: getCanonicalReserveAssetRisk("WETH") ?? "very-low" },
  WPOL: { label: "WPOL", risk: "high" },
  ZK: { label: "ZK", risk: "high" },
  axlUSDC: { label: "axlUSDC", risk: "medium", coinId: "usdc-circle" },
  axlfrxETH: { label: "axlfrxETH", risk: "medium" },
  cvxCRV: { label: "cvxCRV", risk: "very-high" },
  // The source labels this row crvUSD, but its own description identifies an
  // unstaked Curve sfrxUSD/scrvUSD LP. Keep it unlinked instead of fabricating
  // a pure crvUSD dependency or hiding its partial Frax self-exposure.
  crvUSD: { label: "sfrxUSD/scrvUSD Curve LP", risk: "medium" },
  frxETH: { label: "frxETH", risk: "low" },
  frxUSD: { label: "frxUSD", risk: getCanonicalReserveAssetRisk("FRXUSD") ?? "low", coinId: "frxusd-frax" },
  lzfrxETH: { label: "lzfrxETH", risk: "medium" },
  lzsfrxETH: { label: "lzsfrxETH", risk: "medium" },
  // Resupply reUSD: the balance sheet reports token 0x57aB1E0003F623289CD798B1824Be09a793e4Bec
  // (Convex sfrxUSD/reUSD), not Re Protocol's same-symbol reUSD.
  reUSD: { label: "reUSD", risk: "medium", coinId: "reusd-resupply" },
  sDAI: { label: "sDAI", risk: "low", coinId: "dai-makerdao" },
  sFRAX: { label: "sFRAX", risk: "medium", coinId: "frax-frax" },
  sfrxETH: { label: "sfrxETH", risk: getCanonicalReserveAssetRisk("SFRXETH") ?? "low" },
  sfrxUSD: { label: "sfrxUSD", risk: "low", coinId: "sfrxusd-frax" },
  stkAAVE: { label: "stkAAVE", risk: "very-high" },
  // Staked Convex wrapper of the Curve FPI/FRAX LP; no governance-token leg,
  // so it inherits FPI's own risk rating rather than FXS's.
  stkcvxFPIFRAX: { label: "stkcvxFPIFRAX (staked Convex FPI/FRAX LP)", risk: "medium" },
  wfrxETH: { label: "wfrxETH", risk: "medium" },
  ZZ: { label: "ZZ", risk: "very-high" },
};

const ETHEREUM_FRAX = "0x853d955acef822db058eb8505911ed77f175b99e";

// Positions reconciled against the issuer balance sheet and pinned on-chain balances.
const REVIEWED_FRAX_FERRY_POSITIONS = [
  ["arbitrum", "0x5a9bef8cea603aac78a523fb245c1a9264d50706", "0x17fc002b466eec40dae837fc4be5c67993ddbd6f"],
  ["avalanche", "0x5dff474cea8a1fa929ac9a3ce2550376af11d2a8", "0xd24c2ad096400b6fbcd2ad8b24e7acbc21a1da64"],
  ["boba", "0x5cba95f0c97cf281c37ca7a24d68578ea60d0dd0", "0x7562f525106f5d54e891e005867bf489b5988cd9"],
  ["bsc", "0x10ef54f944639764d2d5efa272262f06cfaf09ae", "0x90c97f71e18723b0cf0dfa30ee176ab653e89f40"],
  ["ethereum", "0x06fa869caa1160754c6a0b744da6454c5ea325d4", ETHEREUM_FRAX],
  ["ethereum", "0x32ddf80508cfd8fed8abe375582fc7cfd20372c4", ETHEREUM_FRAX],
  ["ethereum", "0x3ef1d856ea62a2292b8690855042095a7ac48b4b", ETHEREUM_FRAX],
  ["ethereum", "0x43959a388603dcb6b02ca084a55d4c7f3b442c57", ETHEREUM_FRAX],
  ["ethereum", "0x6ac96f65156281a9383455d704b58a74ea9c9ec4", ETHEREUM_FRAX],
  ["ethereum", "0x85c5f05ae4cb68190c695a22b292c3ba90696128", ETHEREUM_FRAX],
  ["ethereum", "0x86e71075e55f0aad27d700017e0783458310c98a", ETHEREUM_FRAX],
  ["ethereum", "0xa381d58e96ec3818c825e1fb264099448945cf8b", ETHEREUM_FRAX],
  ["ethereum", "0xdae210bfb0cf8c81edb4b459e2e0ba14d553e2d9", ETHEREUM_FRAX],
  ["ethereum", "0xfb788f9e20ef426a32a67986654750172a6c1788", ETHEREUM_FRAX],
  ["fantom", "0x088be716eca24b143fcc9ed06c6ae9977a469cce", "0xdc301622e621166bd8e82f2ca0a26c13ad0be355"],
  ["optimism", "0xb781fcac4b8ef06891f9bad7db9c178b1ce67967", "0x2e3d870790dc77a83dd1d18184acc7439a53f475"],
  ["polygon", "0x6f7f18c15b97dc9fac48ae7f986989f97d25dbc7", "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89"],
  ["polygon-zkevm", "0xeabd7625056bbd2c260f90d0b08759c69d971a5b", "0xff8544fed5379d9ffa8d47a74ce6b91e632ac44d"],
  ["zksync", "0x31cda619b96c96bd7ed8463418e0f65c1ffc8d0a", "0xb4c1544cb4163f4c2eca1ae9ce999f63892d912a"],
] as const;

// Pinned Ferry token contracts are verified FRAX identities even where the
// registry carries no deployment for that chain.
const REVIEWED_FRAX_FERRY_TOKENS = new Set(
  REVIEWED_FRAX_FERRY_POSITIONS.map(([chain, , token]) => `${chain}:${token}`),
);

// Supplemental RPC endpoints for reviewed Ferry chains absent from PUBLIC_RPC_URLS.
// Polygon zkEVM halted at block 33391890 on 2026-07-03; Frax's balance-sheet
// indexer frequently errors on that Ferry pair when its zkEVM node fails.
const REVIEWED_FRAX_FERRY_FALLBACK_RPCS: Readonly<Record<string, { rpcUrl: string; fallbackRpcUrl?: string }>> = {
  "polygon-zkevm": { rpcUrl: "https://zkevm-rpc.com", fallbackRpcUrl: "https://polygon-zkevm.drpc.org" },
  zksync: SUPPLY_RPC_DEFAULTS.zksync,
  boba: { rpcUrl: "https://mainnet.boba.network" },
};

// Polygon zkEVM Mainnet Beta permanently halted at block 33391890 on
// 2026-07-03T15:55:44Z (hash 0x070c57f81880e78cc8a1bee37c927dd44487e6c42d0c6a475bddc76818224b97).
// Its Ferry bridged-FRAX balance at that terminal block is immutable on-chain
// state (5,603.41599996 FRAX, verified on-chain 2026-11-20 and 2026-11-23),
// an own-liability row earning zero Backing credit. Reviewed ADR-29 exception:
// used only if live zkEVM RPCs are unavailable AND the issuer payload confirms
// asOfBlock.polygon_zkevm === 33391890. A live read that contradicts this
// terminal balance fails closed.
const HALTED_POLYGON_ZKEVM_FERRY_PIN = {
  chain: "polygon-zkevm",
  holder: "0xeabd7625056bbd2c260f90d0b08759c69d971a5b",
  token: "0xff8544fed5379d9ffa8d47a74ce6b91e632ac44d",
  terminalBlock: 33_391_890,
  decimals: 18,
  rawBalance: 5_603_415_999_960_000_000_000n,
  quantity: 5_603.41599996,
  verifiedAt: "2026-11-23",
} as const;

interface ReviewedFraxLpPosition {
  readonly chain: "optimism";
  readonly holder: string;
  readonly pair: string;
  readonly token0: string;
  readonly token1: string;
  readonly symbol0: string;
  readonly symbol1: string;
}

// Reviewed Optimism Fraxswap V2 LP positions verified against Frax's healthy
// 2026-11-23T23:03:47Z balance sheet (block 159938125) and pinned on-chain
// pair state at block 159938725.
const REVIEWED_FRAX_LP_POSITIONS: readonly ReviewedFraxLpPosition[] = [
  {
    chain: "optimism",
    holder: "0x0df840dcbf1229262a4125c1fc559bd338ec9491",
    pair: "0x9456c020d3a05b159dab4557535083fba836c49a",
    token0: "0x2e3d870790dc77a83dd1d18184acc7439a53f475",
    token1: "0x67ccea5bb16181e7b4109c9c2143c24a1c2205be",
    symbol0: "FRAX",
    symbol1: "FXS",
  },
  {
    chain: "optimism",
    holder: "0x0df840dcbf1229262a4125c1fc559bd338ec9491",
    pair: "0xcc4dd8bc7967d46060ba3faaa8e525a35625f8b4",
    token0: "0x2e3d870790dc77a83dd1d18184acc7439a53f475",
    token1: "0x4200000000000000000000000000000000000006",
    symbol0: "FRAX",
    symbol1: "WETH",
  },
] as const;

const TOKEN0_SELECTOR = "0x0dfe1681";
const TOKEN1_SELECTOR = "0xd21220a7";
const GET_RESERVES_SELECTOR = "0x0902f1ac";

// Bounded combined immateriality ceiling for Pharos on-chain recovery (% of
// reconciled total assets). Any material balance-sheet failure still fails closed.
const MAX_RECOVERED_EXPOSURE_PCT = 1;
const RECOVERY_DEADLINE_MARGIN_MS = 1_500;
const RECOVERY_MIN_CALL_TIMEOUT_MS = 500;
const RECOVERY_LIVE_CHAIN_TIMEOUT_MS = 4_000;
const RECOVERY_HALTED_CHAIN_TIMEOUT_MS = 2_500;
const RECOVERY_HALTED_CHAIN_BUDGET_MS = 5_500;

export interface RecoveredFraxBalance {
  kind: "ferry" | "lp";
  chain: string;
  holder: string;
  token: string;
  symbol: string;
  pair?: string;
  quantity: number;
  source: "onchain-rpc" | "halted-chain-pin";
  blockNumber?: number;
  pinnedBlock?: number;
  verifiedAt?: string;
}

class FraxRecoveryError extends Error {
  constructor(readonly failureClass: string, detail: string) {
    super(`${failureClass}: ${detail}`);
  }
}

function isIssuerAssetReadError(asset: BalanceSheetAsset): boolean {
  return (typeof asset.description === "string" && /^ERROR:/i.test(asset.description.trimStart())) ||
    (asset.tokenQuantity === -0.0001 && asset.totalValueUsd === 0) ||
    (asset.tokenQuantity === -0.001 && asset.category !== "asset:contra" && asset.totalValueUsd <= 0);
}

function decodeAbiAddressWord(hex: string): string | null {
  if (!/^0x[0-9a-f]{64}$/i.test(hex)) return null;
  return canonicalEvmAddress(`0x${hex.slice(26)}`, { allowZero: false });
}

function decodePairReserves(hex: string): { reserve0: bigint; reserve1: bigint } | null {
  if (!/^0x[0-9a-f]{192}$/i.test(hex)) return null;
  return {
    reserve0: BigInt(`0x${hex.slice(2, 66)}`),
    reserve1: BigInt(`0x${hex.slice(66, 130)}`),
  };
}

function findRecoverableReviewedFerryRows(
  assets: readonly BalanceSheetAsset[],
): Array<{ row: BalanceSheetAsset; chain: string; holder: string; token: string }> {
  const recoverable: Array<{ row: BalanceSheetAsset; chain: string; holder: string; token: string }> = [];
  for (const [chain, holder, token] of REVIEWED_FRAX_FERRY_POSITIONS) {
    const rows = assets.filter((asset) =>
      asset.category?.startsWith("asset:") &&
      asset.chain?.replaceAll("_", "-") === chain &&
      canonicalEvmAddress(asset.address) === holder &&
      canonicalEvmAddress(asset.tokenAddress) === token,
    );
    if (rows.length !== 1) continue;
    const row = rows[0]!;
    if (
      row.category !== "asset:contra" &&
      row.tokenSymbol === "FRAX" &&
      row.totalValueUsd === 0 &&
      isIssuerAssetReadError(row)
    ) {
      recoverable.push({ row, chain, holder, token });
    }
  }
  return recoverable;
}

interface RecoverableReviewedLpGroup {
  position: ReviewedFraxLpPosition;
  row0?: BalanceSheetAsset;
  row1?: BalanceSheetAsset;
  rows: BalanceSheetAsset[];
}

function findRecoverableReviewedLpGroups(assets: readonly BalanceSheetAsset[]): RecoverableReviewedLpGroup[] {
  const groups: RecoverableReviewedLpGroup[] = [];
  for (const position of REVIEWED_FRAX_LP_POSITIONS) {
    const matched = assets.filter((asset) =>
      asset.category?.startsWith("asset:") &&
      asset.chain?.replaceAll("_", "-") === position.chain &&
      canonicalEvmAddress(asset.address) === position.holder &&
      canonicalEvmAddress(asset.contractAddress) === position.pair,
    );
    if (matched.length === 0) continue;

    let row0: BalanceSheetAsset | undefined;
    let row1: BalanceSheetAsset | undefined;
    let valid = true;
    for (const row of matched) {
      const token = canonicalEvmAddress(row.tokenAddress, { allowZero: false });
      if (
        row.category === "asset:contra" ||
        typeof row.totalValueUsd !== "number" ||
        !Number.isFinite(row.totalValueUsd) ||
        row.totalValueUsd > 0 ||
        !isIssuerAssetReadError(row)
      ) {
        valid = false;
        break;
      }
      if (token === position.token0 && row.tokenSymbol === position.symbol0 && !row0) {
        row0 = row;
      } else if (token === position.token1 && row.tokenSymbol === position.symbol1 && !row1) {
        row1 = row;
      } else {
        valid = false;
        break;
      }
    }
    if (valid && (row0 || row1)) {
      groups.push({ position, row0, row1, rows: matched });
    }
  }
  return groups;
}

function computeRecoveryCallBudget(
  recoveryDeadlineMs: number | undefined,
  maxCallTimeoutMs: number,
  legBudgetMs?: number,
): { timeoutMs: number; deadlineMs: number | undefined } {
  const remaining = recoveryDeadlineMs == null ? Infinity : Math.floor(recoveryDeadlineMs - Date.now());
  if (remaining < RECOVERY_MIN_CALL_TIMEOUT_MS) {
    throw new FraxRecoveryError("deadline-exceeded", `remaining budget ${Math.max(0, remaining)}ms below ${RECOVERY_MIN_CALL_TIMEOUT_MS}ms`);
  }
  const legDeadlineMs = legBudgetMs == null ? Infinity : Date.now() + legBudgetMs;
  const boundedDeadlineMs = Math.min(recoveryDeadlineMs ?? Infinity, legDeadlineMs);
  return {
    timeoutMs: Math.min(maxCallTimeoutMs, remaining),
    deadlineMs: Number.isFinite(boundedDeadlineMs) ? boundedDeadlineMs : undefined,
  };
}

/**
 * Bounded sequential on-chain recovery for issuer-errored reviewed Legacy FRAX
 * rows (reviewed Ferry rows and reviewed Optimism Fraxswap V2 LP pairs).
 * Runs one RPC call at a time and respects ctx.attemptDeadlineMs. Skips all
 * RPC work if any unrecoverable issuer error row makes the attempt fatal.
 */
async function recoverErroredReviewedRows(
  payload: FraxBalanceSheetResponse,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<{ recovered: Map<BalanceSheetAsset, RecoveredFraxBalance>; warnings: LiveReserveWarning[] }> {
  const assets = payload.assets;
  const recovered = new Map<BalanceSheetAsset, RecoveredFraxBalance>();
  const warnings: LiveReserveWarning[] = [];
  if (!assets?.length) return { recovered, warnings };

  const ferryCandidates = findRecoverableReviewedFerryRows(assets);
  const lpGroups = findRecoverableReviewedLpGroups(assets);
  if (ferryCandidates.length === 0 && lpGroups.length === 0) return { recovered, warnings };

  const recoverableRows = new Set<BalanceSheetAsset>([
    ...ferryCandidates.map((entry) => entry.row),
    ...lpGroups.flatMap((group) => group.rows),
  ]);
  const hasUnrecoverableError = assets.some((asset) =>
    asset.category?.startsWith("asset:") && isIssuerAssetReadError(asset) && !recoverableRows.has(asset),
  );
  if (hasUnrecoverableError) return { recovered, warnings };

  const recoveryDeadlineMs = ctx?.attemptDeadlineMs != null
    ? ctx.attemptDeadlineMs - RECOVERY_DEADLINE_MARGIN_MS
    : undefined;

  for (const { row, chain, holder, token } of ferryCandidates) {
    const isHaltedZkevmPinRow =
      chain === HALTED_POLYGON_ZKEVM_FERRY_PIN.chain &&
      holder === HALTED_POLYGON_ZKEVM_FERRY_PIN.holder &&
      token === HALTED_POLYGON_ZKEVM_FERRY_PIN.token;
    const confirmsTerminalBlock =
      isHaltedZkevmPinRow &&
      payload.asOfBlock?.polygon_zkevm === HALTED_POLYGON_ZKEVM_FERRY_PIN.terminalBlock;

    let failureClass: string | null = null;
    const live = await catchAndWarn(
      (async () => {
        const rpc = REVIEWED_FRAX_FERRY_FALLBACK_RPCS[chain];
        const extraRpcUrls = [rpc?.rpcUrl, rpc?.fallbackRpcUrl].filter(
          (url): url is string => typeof url === "string" && url.length > 0,
        );
        const maxCallTimeoutMs = confirmsTerminalBlock
          ? RECOVERY_HALTED_CHAIN_TIMEOUT_MS
          : RECOVERY_LIVE_CHAIN_TIMEOUT_MS;
        const maxRetries = confirmsTerminalBlock ? 0 : 1;
        const legBudgetMs = confirmsTerminalBlock ? RECOVERY_HALTED_CHAIN_BUDGET_MS : undefined;

        const balBudget = computeRecoveryCallBudget(recoveryDeadlineMs, maxCallTimeoutMs, legBudgetMs);
        const balanceRaw = await runAdapterIo(
          ctx,
          `frax-ferry-balance:${chain}:${token}`,
          () => fetchEvmUint256AtBlock(chain, token, encodeBalanceOfCallData(holder), "latest", {
            extraRpcUrls,
            signal,
            chainRpcs: ctx?.chainRpcs,
            timeoutMs: balBudget.timeoutMs,
            deadlineMs: balBudget.deadlineMs,
            maxRetries,
          }),
          { signal },
        );
        if (balanceRaw == null) {
          throw new FraxRecoveryError("rpc-unavailable", `balanceOf(${holder}) unavailable`);
        }

        const decBudget = computeRecoveryCallBudget(recoveryDeadlineMs, maxCallTimeoutMs, legBudgetMs);
        const decimals = await runAdapterIo(
          ctx,
          `frax-ferry-decimals:${chain}:${token}`,
          () => fetchEvmUint256AtBlock(chain, token, DECIMALS_SELECTOR, "latest", {
            extraRpcUrls,
            signal,
            chainRpcs: ctx?.chainRpcs,
            timeoutMs: decBudget.timeoutMs,
            deadlineMs: decBudget.deadlineMs,
            maxRetries,
          }),
          { signal },
        );
        if (decimals == null) {
          throw new FraxRecoveryError("rpc-unavailable", "decimals() unavailable");
        }
        if (decimals > 36n) {
          throw new FraxRecoveryError("invalid-decimals", `decimals ${decimals.toString()} exceeds 36`);
        }
        const quantity = decimalNumberFromBigInt(balanceRaw, Number(decimals));
        if (!Number.isFinite(quantity) || quantity < 0) {
          throw new FraxRecoveryError("invalid-quantity", "computed quantity is invalid");
        }
        if (
          confirmsTerminalBlock &&
          (balanceRaw !== HALTED_POLYGON_ZKEVM_FERRY_PIN.rawBalance ||
            Number(decimals) !== HALTED_POLYGON_ZKEVM_FERRY_PIN.decimals)
        ) {
          throw new FraxRecoveryError(
            "terminal-pin-mismatch",
            `live balance ${quantity} contradicts pinned terminal block ${HALTED_POLYGON_ZKEVM_FERRY_PIN.terminalBlock} balance ${HALTED_POLYGON_ZKEVM_FERRY_PIN.quantity}`,
          );
        }
        return quantity;
      })().catch((error) => {
        if (error instanceof FraxRecoveryError) failureClass = error.failureClass;
        throw error;
      }),
      "ferry-balance-onchain-recovery-failed",
      `Frax Ferry on-chain recovery failed on ${chain} (${holder})`,
      warnings,
    );
    throwIfAborted(signal);

    if (live != null) {
      recovered.set(row, {
        kind: "ferry",
        chain,
        holder,
        token,
        symbol: "FRAX",
        quantity: live,
        source: "onchain-rpc",
      });
    } else if (
      confirmsTerminalBlock &&
      failureClass !== "terminal-pin-mismatch" &&
      failureClass !== "deadline-exceeded" &&
      failureClass !== "invalid-decimals" &&
      failureClass !== "invalid-quantity" &&
      (recoveryDeadlineMs == null || Date.now() < recoveryDeadlineMs)
    ) {
      recovered.set(row, {
        kind: "ferry",
        chain,
        holder,
        token,
        symbol: "FRAX",
        quantity: HALTED_POLYGON_ZKEVM_FERRY_PIN.quantity,
        source: "halted-chain-pin",
        pinnedBlock: HALTED_POLYGON_ZKEVM_FERRY_PIN.terminalBlock,
        verifiedAt: HALTED_POLYGON_ZKEVM_FERRY_PIN.verifiedAt,
      });
    }
  }

  for (const { position, row0, row1 } of lpGroups) {
    const recoveredLegs = await catchAndWarn(
      (async () => {
        const blockNumber = payload.asOfBlock?.optimism;
        if (typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
          throw new FraxRecoveryError("missing-as-of-block", "asOfBlock.optimism is missing or invalid");
        }
        const budget = computeRecoveryCallBudget(recoveryDeadlineMs, RECOVERY_LIVE_CHAIN_TIMEOUT_MS);
        const results = await runAdapterIo(
          ctx,
          `frax-lp-multicall:${position.chain}:${position.pair}`,
          () => fetchEvmMulticall3Aggregate3AtBlock(
            position.chain,
            [
              { label: "balanceOf", target: position.pair, callData: encodeBalanceOfCallData(position.holder), allowFailure: false },
              { label: "totalSupply", target: position.pair, callData: TOTAL_SUPPLY_SELECTOR, allowFailure: false },
              { label: "token0", target: position.pair, callData: TOKEN0_SELECTOR, allowFailure: false },
              { label: "token1", target: position.pair, callData: TOKEN1_SELECTOR, allowFailure: false },
              { label: "getReserves", target: position.pair, callData: GET_RESERVES_SELECTOR, allowFailure: false },
              { label: "decimals0", target: position.token0, callData: DECIMALS_SELECTOR, allowFailure: false },
              { label: "decimals1", target: position.token1, callData: DECIMALS_SELECTOR, allowFailure: false },
            ],
            blockNumber,
            {
              signal,
              chainRpcs: ctx?.chainRpcs,
              timeoutMs: budget.timeoutMs,
              deadlineMs: budget.deadlineMs,
              maxRetries: 0,
            },
          ),
          { signal },
        );
        if (!results || results.length !== 7 || results.some((entry) => !entry.success)) {
          throw new FraxRecoveryError("rpc-unavailable", `Multicall3 pair read failed at block ${blockNumber}`);
        }
        const observedToken0 = decodeAbiAddressWord(results[2]!.returnData);
        const observedToken1 = decodeAbiAddressWord(results[3]!.returnData);
        if (observedToken0 !== position.token0 || observedToken1 !== position.token1) {
          throw new FraxRecoveryError("pair-token-mismatch", `pair tokens do not match reviewed ${position.symbol0}/${position.symbol1} contracts`);
        }
        const balanceRaw = parseUint256Hex(results[0]!.returnData);
        const totalSupplyRaw = parseUint256Hex(results[1]!.returnData);
        const reserves = decodePairReserves(results[4]!.returnData);
        const decimals0 = parseUint256Hex(results[5]!.returnData);
        const decimals1 = parseUint256Hex(results[6]!.returnData);
        if (balanceRaw == null || totalSupplyRaw == null || reserves == null) {
          throw new FraxRecoveryError("invalid-reserves", "pair balance, supply, or reserves decode failed");
        }
        if (decimals0 == null || decimals1 == null || decimals0 > 36n || decimals1 > 36n) {
          throw new FraxRecoveryError("invalid-decimals", "pair token decimals invalid");
        }

        const out: Array<{ row: BalanceSheetAsset; entry: RecoveredFraxBalance }> = [];
        if (balanceRaw === 0n) {
          if (row0) {
            out.push({
              row: row0,
              entry: {
                kind: "lp",
                chain: position.chain,
                holder: position.holder,
                pair: position.pair,
                token: position.token0,
                symbol: position.symbol0,
                quantity: 0,
                source: "onchain-rpc",
                blockNumber,
              },
            });
          }
          if (row1) {
            out.push({
              row: row1,
              entry: {
                kind: "lp",
                chain: position.chain,
                holder: position.holder,
                pair: position.pair,
                token: position.token1,
                symbol: position.symbol1,
                quantity: 0,
                source: "onchain-rpc",
                blockNumber,
              },
            });
          }
          return out;
        }

        if (totalSupplyRaw <= 0n || balanceRaw > totalSupplyRaw) {
          throw new FraxRecoveryError("invalid-reserves", "LP balance exceeds totalSupply or supply is zero");
        }
        if (!row0 || !row1) {
          throw new FraxRecoveryError("missing-partner-leg", "positive LP balance requires both pair token rows in payload");
        }
        const quantity0 = decimalNumberFromBigInt((balanceRaw * reserves.reserve0) / totalSupplyRaw, Number(decimals0));
        const quantity1 = decimalNumberFromBigInt((balanceRaw * reserves.reserve1) / totalSupplyRaw, Number(decimals1));
        if (!Number.isFinite(quantity0) || quantity0 < 0 || !Number.isFinite(quantity1) || quantity1 < 0) {
          throw new FraxRecoveryError("invalid-reserves", "computed LP token quantities are invalid");
        }
        out.push(
          {
            row: row0,
            entry: {
              kind: "lp",
              chain: position.chain,
              holder: position.holder,
              pair: position.pair,
              token: position.token0,
              symbol: position.symbol0,
              quantity: quantity0,
              source: "onchain-rpc",
              blockNumber,
            },
          },
          {
            row: row1,
            entry: {
              kind: "lp",
              chain: position.chain,
              holder: position.holder,
              pair: position.pair,
              token: position.token1,
              symbol: position.symbol1,
              quantity: quantity1,
              source: "onchain-rpc",
              blockNumber,
            },
          },
        );
        return out;
      })(),
      "fraxswap-lp-onchain-recovery-failed",
      `Fraxswap V2 LP on-chain recovery failed on ${position.chain} (${position.pair})`,
      warnings,
    );
    throwIfAborted(signal);

    if (recoveredLegs) {
      for (const { row, entry } of recoveredLegs) {
        recovered.set(row, entry);
      }
    }
  }

  return { recovered, warnings };
}

const FRAX_SIBLING_ASSET_IDS = {
  frxUSD: "frxusd-frax",
  sfrxUSD: "sfrxusd-frax",
  FPI: "fpi-frax",
} as const;
type FraxSiblingSymbol = keyof typeof FRAX_SIBLING_ASSET_IDS;
export type FraxSiblingDeployments = Partial<Record<FraxSiblingSymbol, ReserveAdapterCoin["contracts"]>>;

function getDefaultFraxSiblingDeployments(): FraxSiblingDeployments {
  return {
    frxUSD: WORKER_TRACKED_META_BY_ID.get(FRAX_SIBLING_ASSET_IDS.frxUSD)?.contracts,
    sfrxUSD: WORKER_TRACKED_META_BY_ID.get(FRAX_SIBLING_ASSET_IDS.sfrxUSD)?.contracts,
    FPI: WORKER_TRACKED_META_BY_ID.get(FRAX_SIBLING_ASSET_IDS.FPI)?.contracts,
  };
}

function matchesDeployment(
  deployments: ReserveAdapterCoin["contracts"] | undefined,
  chain: string,
  token: string,
  isEvm: boolean,
): boolean {
  return deployments?.some((row) =>
    row.chain === chain
    && (isEvm ? canonicalEvmAddress(row.address, { allowZero: false }) : row.address) === token,
  ) ?? false;
}

function hasReconciledFraxQuantity(row: BalanceSheetAsset, reportedPrice: number | undefined): boolean {
  const sign = row.category === "asset:contra" ? -1 : 1;
  const quantity = typeof row.tokenQuantity === "number" ? nonnegativeFinite(sign * row.tokenQuantity) : undefined;
  const exactQuantity = typeof row.tokenQuantityE18 === "string" && /^-?\d{1,78}$/.test(row.tokenQuantityE18)
    ? nonnegativeFinite(sign * Number(`${row.tokenQuantityE18}e-18`)) : undefined;
  const usd = typeof row.totalValueUsd === "number" ? nonnegativeFinite(sign * row.totalValueUsd) : undefined;
  const price = nonnegativeFinite(reportedPrice);
  // The displayed float may differ from the raw amount by a rounding step.
  // The issuer rounds the published Legacy FRAX price to eight decimals.
  return quantity != null && exactQuantity != null && usd != null &&
    Math.abs(quantity - exactQuantity) <= Number.EPSILON * exactQuantity &&
    (exactQuantity === 0 ? usd === 0 : usd > 0 && price != null && price > 0 &&
      Math.abs(usd / exactQuantity - price) <= 5e-9 + Number.EPSILON * price);
}

export function adaptFraxBalanceSheet(
  payload: FraxBalanceSheetResponse,
  subjectId?: string,
  deployments?: ReserveAdapterCoin["contracts"],
  siblingDeployments: FraxSiblingDeployments = getDefaultFraxSiblingDeployments(),
  recoveredBalances: ReadonlyMap<BalanceSheetAsset, RecoveredFraxBalance> = new Map(),
): AdapterResult {
  const assets = payload.assets;
  if (!assets?.length || !payload.totalAssets || payload.totalAssets <= 0) {
    throw new Error("Frax balance-sheet response missing or empty assets array");
  }
  const sourceTotal = Number(payload.totalAssets);
  if (!Number.isFinite(sourceTotal) || sourceTotal <= 0) {
    throw new Error("Frax balance-sheet totalAssets is invalid or zero");
  }

  const admittedRecoveredRows = new Map<BalanceSheetAsset, RecoveredFraxBalance & { usd: number }>();
  let admittedRecoveredUsd = 0;
  let admittedRecoveredSentinelOffsetUsd = 0;
  if (subjectId === "frax-frax" && recoveredBalances.size > 0) {
    const fraxPrice = nonnegativeFinite(payload.tokenPriceUsd?.FRAX);
    const recoverableFerryByRow = new Map(findRecoverableReviewedFerryRows(assets).map((entry) => [entry.row, entry]));
    const candidateRecovered = new Map<BalanceSheetAsset, RecoveredFraxBalance & { usd: number }>();
    let candidateRecoveredUsd = 0;
    let candidateSentinelOffsetUsd = 0;

    for (const [row, balance] of recoveredBalances) {
      if (balance.kind !== "ferry") continue;
      const expected = recoverableFerryByRow.get(row);
      if (!expected || balance.chain !== expected.chain || balance.holder !== expected.holder || balance.token !== expected.token) {
        continue;
      }
      const quantity = nonnegativeFinite(balance.quantity);
      if (quantity == null) continue;
      if (quantity === 0) {
        candidateRecovered.set(row, { ...balance, quantity: 0, usd: 0 });
        candidateSentinelOffsetUsd += row.totalValueUsd;
        continue;
      }
      if (fraxPrice == null || fraxPrice <= 0) continue;
      const usd = quantity * fraxPrice;
      if (!Number.isFinite(usd) || usd < 0) continue;
      candidateRecovered.set(row, { ...balance, quantity, usd });
      candidateRecoveredUsd += usd;
      candidateSentinelOffsetUsd += row.totalValueUsd;
    }

    for (const group of findRecoverableReviewedLpGroups(assets)) {
      const staged: Array<{ row: BalanceSheetAsset; entry: RecoveredFraxBalance & { usd: number } }> = [];
      let groupValid = true;
      for (const row of group.rows) {
        const balance = recoveredBalances.get(row);
        const expectedToken = row === group.row0 ? group.position.token0 : group.position.token1;
        const expectedSymbol = row === group.row0 ? group.position.symbol0 : group.position.symbol1;
        if (
          !balance ||
          balance.kind !== "lp" ||
          balance.chain !== group.position.chain ||
          balance.holder !== group.position.holder ||
          balance.pair !== group.position.pair ||
          balance.token !== expectedToken ||
          balance.symbol !== expectedSymbol
        ) {
          groupValid = false;
          break;
        }
        const quantity = nonnegativeFinite(balance.quantity);
        if (quantity == null) {
          groupValid = false;
          break;
        }
        if (quantity === 0) {
          staged.push({ row, entry: { ...balance, quantity: 0, usd: 0 } });
          continue;
        }
        const price = nonnegativeFinite(payload.tokenPriceUsd?.[expectedSymbol]);
        if (price == null || price <= 0) {
          groupValid = false;
          break;
        }
        const usd = quantity * price;
        if (!Number.isFinite(usd) || usd < 0) {
          groupValid = false;
          break;
        }
        staged.push({ row, entry: { ...balance, quantity, usd } });
      }
      if (groupValid && staged.length === group.rows.length) {
        for (const { row, entry } of staged) {
          candidateRecovered.set(row, entry);
          candidateRecoveredUsd += entry.usd;
          candidateSentinelOffsetUsd += row.totalValueUsd;
        }
      }
    }

    const candidateReconciledTotal = sourceTotal + candidateRecoveredUsd - candidateSentinelOffsetUsd;
    const candidatePct = computeUnknownExposurePct(candidateRecoveredUsd, candidateReconciledTotal);
    if (
      candidateRecovered.size > 0 &&
      candidateReconciledTotal > 0 &&
      candidatePct <= MAX_RECOVERED_EXPOSURE_PCT
    ) {
      for (const [row, entry] of candidateRecovered) admittedRecoveredRows.set(row, entry);
      admittedRecoveredUsd = candidateRecoveredUsd;
      admittedRecoveredSentinelOffsetUsd = candidateSentinelOffsetUsd;
    }
  }

  const warnings: LiveReserveWarning[] = [];
  const ferryRows = new Set<BalanceSheetAsset>();
  if (subjectId === "frax-frax") {
    for (const row of assets) {
      if (row.category?.startsWith("asset:") &&
          typeof row.description === "string" && /^\s*FraxFerry\s*-\s*FRAX\s/i.test(row.description)) ferryRows.add(row);
    }
    for (const [chain, holder, token] of REVIEWED_FRAX_FERRY_POSITIONS) {
      const rows = assets.filter(asset => asset.category?.startsWith("asset:") &&
        asset.chain?.replaceAll("_", "-") === chain &&
        canonicalEvmAddress(asset.address) === holder && canonicalEvmAddress(asset.tokenAddress) === token);
      if (rows.length === 1) {
        ferryRows.add(rows[0]);
      } else {
        warnings.push(reserveFatalWarning("asset-coverage-incomplete",
          `Frax balance-sheet expected one reviewed Ferry asset row on ${chain.replaceAll("-", "_")} (${holder}, ${token}), found ${rows.length}`));
      }
    }
    for (const row of ferryRows) {
      if (admittedRecoveredRows.has(row)) continue;
      if (!hasReconciledFraxQuantity(row, payload.tokenPriceUsd?.FRAX)) {
        warnings.push(reserveFatalWarning("asset-coverage-incomplete",
          `Frax balance-sheet Ferry quantity and USD value are unavailable or inconsistent on ${row.chain ?? "unknown chain"}`));
      }
    }
  }

  const ownLiabilityKeys = new Map<string, string>();
  const byAsset = new Map<string, number>();
  for (const asset of assets) {
    if (!asset.category?.startsWith("asset:")) continue;
    const recoveredRow = admittedRecoveredRows.get(asset);
    if (!recoveredRow && isIssuerAssetReadError(asset)) {
      warnings.push(reserveFatalWarning("asset-coverage-incomplete",
        `Frax balance-sheet asset read failed on ${asset.chain ?? "unknown chain"}`));
      continue;
    }
    const usd = recoveredRow ? recoveredRow.usd : asset.totalValueUsd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || !asset.tokenSymbol?.trim()) {
      throw new Error("Frax balance-sheet asset amount or identity is unavailable");
    }
    let symbol = asset.tokenSymbol;
    let contractKey: string | undefined;
    if (subjectId === "frax-frax") {
      const chain = typeof asset.chain === "string" ? resolveChainId(asset.chain.replaceAll("_", "-")) : null;
      const isEvm = chain !== null && CHAIN_META[chain]?.type === "evm";
      const token = isEvm ? canonicalEvmAddress(asset.tokenAddress, { allowZero: false })
        : typeof asset.tokenAddress === "string" ? asset.tokenAddress : null;
      const registered = !!chain && !!token && matchesDeployment(deployments, chain, token, isEvm);
      const siblingSymbol: FraxSiblingSymbol | null =
        symbol === "frxUSD" || symbol === "sfrxUSD" || symbol === "FPI" ? symbol : null;
      const matchesSibling = !!chain && !!token && siblingSymbol !== null
        && matchesDeployment(siblingDeployments[siblingSymbol], chain, token, isEvm);
      const usableToken = token && (isEvm || registered || matchesSibling ||
        (chain === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)));
      if ((!chain || !usableToken) && /^(?:[sL]?FRAX|s?frxUSD|FPI)$/.test(symbol)) {
        warnings.push(reserveFatalWarning("asset-coverage-incomplete",
          `Frax balance-sheet ${symbol} asset chain or token address is unavailable on ${chain ?? "unknown chain"}`));
        continue;
      }
      const ownClaim = chain === "ethereum" && token === "0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32" ? "sFRAX"
        : chain === "fraxtal" && token === "0xff000000000000000000000000000000000001fd" ? "LFRAX"
        : registered ? `Legacy FRAX (${chain})`
        : null;
      if (chain === "fraxtal" && token === "0xfc00000000000000000000000000000000000001") {
        symbol = "frxUSD";
      } else if (token && ownClaim) {
        const priceSymbol = ownClaim === "sFRAX" || ownClaim === "LFRAX" ? ownClaim : "FRAX";
        if (!ferryRows.has(asset) && !recoveredRow && !hasReconciledFraxQuantity(asset, payload.tokenPriceUsd?.[priceSymbol])) {
          warnings.push(reserveFatalWarning("asset-coverage-incomplete",
            `Frax balance-sheet own-liability quantity and USD value are unavailable or inconsistent on ${asset.chain} (${token})`));
        }
        // The slice key must be lowercase, even when the contract identity is case-sensitive.
        contractKey = `contract:${chain}:${isEvm ? token : sha256Hex(token)}`;
        ownLiabilityKeys.set(contractKey, ownClaim);
      } else if (symbol === "FRAX" && token && !REVIEWED_FRAX_FERRY_TOKENS.has(`${chain}:${token}`)) {
        // A FRAX-denominated row whose contract matches no pinned FRAX
        // identity is not ordinary low-risk FRAX collateral; publishing it
        // would turn an unverified identity into a positive claim. Withhold.
        warnings.push(reserveFatalWarning("asset-coverage-incomplete",
          `Frax balance-sheet FRAX asset token ${token} on ${chain} matches no verified FRAX deployment`));
        continue;
      }
      if (!ownClaim && (symbol === "frxUSD" || symbol === "sfrxUSD" || symbol === "FPI")) {
        if (!chain || !token || !matchesDeployment(siblingDeployments[symbol], chain, token, isEvm)) {
          warnings.push(reserveFatalWarning("asset-coverage-incomplete",
            `Frax balance-sheet ${symbol} asset token ${token} on ${chain} matches no verified ${symbol} deployment`));
          continue;
        }
      }
    }
    if (!contractKey && subjectId === "frax-frax" && (symbol === "sFRAX" || symbol === "LFRAX")) {
      symbol += ":unverified";
    }
    const key = contractKey ?? `ticker:${symbol}`;
    byAsset.set(key, (byAsset.get(key) ?? 0) + usd);
  }
  // Contra entries offset their own asset, never an unrelated reserve bucket.
  for (const [key, usd] of byAsset) {
    if (usd < 0) throw new Error(`Frax balance-sheet net asset is negative: ${key}`);
    if (usd === 0) byAsset.delete(key);
  }

  const categorizedAssetTotal = [...byAsset.values()].reduce((a, b) => a + b, 0);
  if (categorizedAssetTotal <= 0) throw new Error("Frax balance-sheet total asset value is zero");
  const total = sourceTotal + admittedRecoveredUsd - admittedRecoveredSentinelOffsetUsd;
  const reconciliation = reconcileRowsWithSourceTotal({
    rowTotalUsd: categorizedAssetTotal,
    sourceTotalUsd: total,
    exceedsMessage: "Frax balance-sheet asset rows exceed totalAssets",
  });
  if (reconciliation.rowsExceedTotalWarning) warnings.push(reconciliation.rowsExceedTotalWarning);
  // The sync core rejects malformed slices before it reads fatal warnings, so a
  // withheld attempt still shares its rows over their own sum; they never publish.
  const shareBasisUsd = reconciliation.rowsExceedTotalWarning ? categorizedAssetTotal : total;
  // Only another stablecoin can be exit capacity for the subject coin: its own
  // balance-sheet rows are issuer/protocol-owned inventory (FraxFerry bridges,
  // Curve/Convex LPs) that offsets its own supply, so redeeming FRAX with FRAX
  // is circular. The subject row stays visible in the composition.
  const stableRedeemableUsd = ["USDC", "USDS", "PYUSD", "DAI", "FRAX"]
    .filter((symbol) => TOKEN_DISPLAY[symbol]?.coinId !== subjectId)
    .reduce((sum, symbol) => sum + (byAsset.get(`ticker:${symbol}`) ?? 0), 0);
  if (stableRedeemableUsd > total) {
    warnings.push(reserveDegradedWarning("redeemable-capacity-exceeds-total",
      "Frax redeemable asset rows exceed totalAssets; capacity is unavailable"));
  }
  const sourceTimestamp = parseTimestampLikeToUnixSeconds(payload.asOfTimestamp);

  const slices: ReserveSlice[] = [];
  const unknownSymbols: string[] = [];
  let unknownUsd = 0;
  for (const [key, usd] of byAsset) {
    const symbol = key.slice(key.indexOf(":") + 1);
    const ownLiability = ownLiabilityKeys.get(key);
    const config = ownLiability ? { label: `Self-referential claim (${ownLiability})`, risk: "very-high" as const } : TOKEN_DISPLAY[symbol];
    if (!config) {
      unknownSymbols.push(symbol);
      unknownUsd += usd;
    }
    if (config) {
      slices.push({
        sourceKey: `frax-balance-sheet:${symbol.toLowerCase()}`,
        name: config.label,
        pct: (usd / shareBasisUsd) * 100,
        risk: config.risk,
        ...(ownLiability ? { selfReferential: true as const } : {}),
        ...(config.coinId && config.coinId !== subjectId ? { coinId: config.coinId, depType: "collateral" as const } : {}),
      });
    }
  }

  if (unknownUsd > 0) {
    slices.push({
      sourceKey: "frax-balance-sheet:unknown",
      name: "Unmapped Frax balance-sheet assets",
      pct: (unknownUsd / shareBasisUsd) * 100,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        adapterKey: "frax-balance-sheet",
        code: "unknown-token",
        message: `Frax balance-sheet unknown token(s): ${unknownSymbols.sort().join(", ")}`,
        unknownExposurePct: (unknownUsd / shareBasisUsd) * 100,
      }),
    );
  }

  if (reconciliation.gapPct > SOURCE_TOTAL_RECONCILIATION_THRESHOLD_PCT) {
    slices.push({
      sourceKey: "frax-balance-sheet:source-total-gap",
      name: "Unmapped Frax balance-sheet total-assets gap",
      pct: reconciliation.gapPct,
      risk: "high",
    });
    warnings.push(
      buildUnknownExposureWarning({
        adapterKey: "frax-balance-sheet",
        code: "source-total-gap",
        message: "Frax balance-sheet totalAssets exceeds mapped asset-category rows",
        unknownExposurePct: reconciliation.gapPct,
      }),
    );
  }

  const admittedFerries = [...admittedRecoveredRows.values()].filter((entry) => entry.kind === "ferry");
  const recoveredFerryPositions = admittedFerries
    .map((entry) => `${entry.chain}:${entry.holder}`)
    .sort();
  const admittedRecoveredFerryUsd = admittedFerries.reduce((sum, entry) => sum + entry.usd, 0);
  const admittedRecoveredFerryPct = computeUnknownExposurePct(admittedRecoveredFerryUsd, total);
  const pinnedHaltedChainFerryEntries = admittedFerries.filter((entry) => entry.source === "halted-chain-pin");
  const pinnedHaltedChainFerryPositions = pinnedHaltedChainFerryEntries
    .map((entry) => `${entry.chain}:${entry.holder}@${entry.pinnedBlock ?? "terminal"}`)
    .sort();
  const pinnedHaltedChainFerryVerifiedAt = pinnedHaltedChainFerryEntries[0]?.verifiedAt;
  if (recoveredFerryPositions.length > 0) {
    const pinDetail = pinnedHaltedChainFerryPositions.length > 0
      ? `; halted-chain terminal pin: ${pinnedHaltedChainFerryPositions.join(", ")}`
      : "";
    warnings.push(
      reserveInfoWarning(
        "ferry-balance-onchain-recovery",
        `Recovered ${recoveredFerryPositions.length} issuer-errored reviewed Ferry row(s) (${recoveredFerryPositions.join(", ")}; ${admittedRecoveredFerryPct.toFixed(4)}% of total assets${pinDetail})`,
      ),
    );
  }

  const admittedLps = [...admittedRecoveredRows.values()].filter((entry) => entry.kind === "lp");
  const recoveredLpPositions = admittedLps
    .map((entry) => `${entry.chain}:${entry.pair}@${entry.blockNumber ?? "pinned"}:${entry.symbol}`)
    .sort();
  const admittedRecoveredLpUsd = admittedLps.reduce((sum, entry) => sum + entry.usd, 0);
  const admittedRecoveredLpPct = computeUnknownExposurePct(admittedRecoveredLpUsd, total);
  if (recoveredLpPositions.length > 0) {
    warnings.push(
      reserveInfoWarning(
        "fraxswap-lp-onchain-recovery",
        `Recovered ${recoveredLpPositions.length} issuer-errored reviewed Fraxswap V2 LP row(s) (${recoveredLpPositions.join(", ")}; ${admittedRecoveredLpPct.toFixed(4)}% of total assets)`,
      ),
    );
  }

  return {
    slices: normalizeSlices(slices, null),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      totalCollateralUsd: total,
      categorizedAssetTotalUsd: categorizedAssetTotal,
      sourceTotalAssetsUsd: sourceTotal,
      ...(reconciliation.gapPct > 0 ? { sourceTotalGapPct: reconciliation.gapPct } : {}),
      ...(recoveredFerryPositions.length > 0
        ? {
            recoveredFerryRowCount: recoveredFerryPositions.length,
            recoveredFerryCollateralUsd: admittedRecoveredFerryUsd,
            recoveredFerryPositions,
            ...(pinnedHaltedChainFerryPositions.length > 0
              ? {
                  pinnedHaltedChainFerryPositions,
                  ...(pinnedHaltedChainFerryVerifiedAt ? { pinnedHaltedChainFerryVerifiedAt } : {}),
                }
              : {}),
          }
        : {}),
      ...(recoveredLpPositions.length > 0
        ? {
            recoveredLpRowCount: recoveredLpPositions.length,
            recoveredLpCollateralUsd: admittedRecoveredLpUsd,
            recoveredLpPositions,
          }
        : {}),
      assetCount: byAsset.size,
      ...freshnessMetadataFromTimestamp(
        sourceTimestamp,
        "frax-balance-sheet-api",
        "Frax balance-sheet response did not include asOfTimestamp",
      ),
      ...buildRedemptionSnapshotMetadata({
        ...(stableRedeemableUsd <= total ? { capacityUsd: stableRedeemableUsd } : {}),
        capacityKind: "live-proxy-validated",
        freshnessKind: sourceTimestamp != null ? "verified-source-timestamp" : "unverified",
        ...(sourceTimestamp != null ? { sourceTimestamp } : {}),
        routeStatus: "unknown",
        sourceUrls: ["https://frax.com/transparency"],
      }),
    },
  };
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isBalanceSheetResponse(payload: unknown): payload is FraxBalanceSheetResponse {
  return Array.isArray((payload as FraxBalanceSheetResponse)?.assets);
}

/**
 * Dedicated balance-sheet adapter entrypoint for coins using the Frax v2
 * balance-sheet API with independent evidence class (e.g. frxUSD).
 */
export async function fetchFraxBalanceSheetReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<FraxBalanceSheetResponse>(config, "frax-balance-sheet", signal, 12_000, ctx);

  if (!isBalanceSheetResponse(payload)) {
    throw new Error("frax-balance-sheet adapter requires a v2 balance-sheet API response");
  }
  const recovery = coin.id === "frax-frax"
    ? await recoverErroredReviewedRows(payload, signal, ctx)
    : undefined;
  const result = adaptFraxBalanceSheet(payload, coin.id, coin.contracts, undefined, recovery?.recovered);
  if (!recovery || recovery.warnings.length === 0) return result;
  return {
    ...result,
    warnings: [...(result.warnings ?? []), ...recovery.warnings],
  };
}
