import { fetchErc4626SingleAssetReserves } from "../erc4626-single-asset";
import { toFunctionSelector } from "viem/utils";
import type { AdapterContext, AdapterResult } from "../types";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import { computeLiveReserveConfigFingerprint, parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { evaluateLiveReserveAdmission } from "../../../lib/live-reserves/store-snapshot-state";
import {
  installAdapterNetwork,
  type AdapterNetwork,
  type AdapterNetworkSpec,
  type AdapterRpcCall,
  type AdapterBlockHeader,
  type AdapterRpcValue,
  type AdapterRpcWord,
} from "./reserve-adapter.test-support";

type Erc4626Call = { to?: string; data: string };

type Erc4626RpcContext = {
  url: string;
  call?: Erc4626Call;
  body: Record<string, unknown>;
};

type Erc4626RpcHandler = (context: Erc4626RpcContext) => Response | null | undefined;

export type Erc4626RpcFixture = {
  chain?: string;
  vault?: string;
  asset?: string | null;
  totalAssets?: bigint | number | null;
  totalSupply?: bigint | number | null;
  convertedAssets?: bigint | number | null;
  idleBalance?: bigint | number | null;
  decimals?: bigint | number | null;
  paused?: bigint | number;
  shutdown?: bigint | number;
  liquidityAdapter?: bigint | number | null;
  blockTimestamp?: number | null;
  json?: AdapterNetworkSpec["json"];
  extraHandlers?: Erc4626RpcHandler[];
};

export interface MorphoReadMockOptions {
  version?: "v1" | "v2";
  chainId?: number;
  vault?: string;
  asset?: string;
  listed?: boolean;
  dirAsset?: string;
  withdrawable?: string | null;
  stateAddress?: string;
  stateChainId?: number;
  lastIndexedBlock?: string | null;
  lastAccrualTimestamp?: number | null;
  penalties?: string[];
  price?: number | null;
  priceStatus?: number;
  priceTimestamp?: number | string | null;
  omitPriceTimestamp?: boolean;
  overrides?: AdapterNetworkSpec["json"];
}

export function morphoReadJson({
  version = "v2",
  chainId = 1,
  vault = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
  asset = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  listed = true,
  dirAsset = asset,
  withdrawable = "90000000",
  stateAddress = vault,
  stateChainId = chainId,
  lastIndexedBlock = "26500000",
  lastAccrualTimestamp = Math.floor(Date.now() / 1000) - 60,
  penalties = [],
  price = 1,
  priceStatus = 200,
  priceTimestamp = String(Math.floor(Date.now() / 1000) - 60),
  omitPriceTimestamp = false,
  overrides = {},
}: MorphoReadMockOptions = {}): NonNullable<AdapterNetworkSpec["json"]> {
  const v = vault.toLowerCase();
  const a = asset.toLowerCase();
  const sel = `${chainId}:${v}`;
  const base = "https://api.morpho.org";
  return {
    [`${base}/v0/vaults-${version}?limit=1000`]: {
      data: listed ? [{ chain_id: chainId, vault_address: vault, asset_address: dirAsset }] : [],
      cursor: null,
    },
    [`${base}/${version === "v1" ? "v0/vaults-v1" : "v1/vaults-v2"}/${sel}/state`]: {
      data: {
        chain_id: stateChainId,
        address: stateAddress,
        withdrawable_assets: withdrawable,
        ...(lastIndexedBlock !== null ? { last_indexed_block: lastIndexedBlock } : {}),
        ...(version === "v2" && lastAccrualTimestamp !== null ? { last_accrual_timestamp: lastAccrualTimestamp } : {}),
      },
    },
    ...(version === "v2"
      ? {
          [`${base}/v0/vaults-v2/${sel}/withdrawal-options`]: {
            data: {
              chain_id: chainId,
              vault_address: vault,
              adapter_penalties: penalties.map((p) => ({ force_deallocatable_assets: p })),
            },
          },
        }
      : {}),
    [`${base}/v0/tokens/${chainId}:${a}/price`]: {
      status: priceStatus,
      json: {
        data: {
          chain_id: chainId,
          address: asset,
          price,
          ...(!omitPriceTimestamp ? { timestamp: priceTimestamp } : {}),
        },
      },
    },
    ...overrides,
  };
}

async function responseValue(response: Response | null): Promise<string | null> {
  const payload = response == null ? null : await response.json() as { result?: string } | null;
  // An empty success word ("0x") is not representable as a harness rpc word
  // (short hex is right-aligned into a zero word); surface it as a failed
  // call instead, which adapters read identically (unreadable result).
  const result = payload?.result;
  return result != null && result.length > 2 ? result : null;
}

let activeNetwork: AdapterNetwork | undefined;

export function installErc4626Network({
  chain = "ethereum",
  vault = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b",
  asset = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  totalAssets = 100_000_000n,
  totalSupply = 100_000_000n,
  convertedAssets = 100_000_000n,
  idleBalance = 25_000_000n,
  decimals = 6,
  paused,
  shutdown,
  liquidityAdapter,
  blockTimestamp,
  json,
  extraHandlers = [],
}: Erc4626RpcFixture = {}): AdapterNetwork {
  const vaultAddress = vault.toLowerCase();
  const underlying = asset?.toLowerCase();
  const invokeExtra = async (call: AdapterRpcCall | undefined, url: string, body: Record<string, unknown>) => {
    for (const handler of extraHandlers) {
      const response = handler({
        url,
        call: call ? { to: call.contract, data: call.data } : undefined,
        body,
      });
      if (response !== undefined) return response;
    }
    return undefined;
  };
  const rpcHandlerBody = (call: AdapterRpcCall) => ({
    jsonrpc: "2.0",
    method: call.method,
    params: [{ to: call.contract, data: call.data }, call.block],
  });
  const withHandlers = (fallback: AdapterRpcValue) =>
    async (call: AdapterRpcCall): Promise<AdapterRpcWord | AdapterBlockHeader> => {
      const response = await invokeExtra(call, call.url, rpcHandlerBody(call));
      if (response === undefined) return typeof fallback === "function" ? fallback(call) : fallback;
      return responseValue(response);
    };
  const rpc: AdapterNetworkSpec["rpc"] = {
    eth_getBlockByNumber: () =>
      blockTimestamp === null ? null : { timestamp: blockTimestamp ?? Math.floor(Date.now() / 1000) - 30 },
    [`${vault}:asset()`]: withHandlers(asset == null ? null : asset),
    [`${vault}:totalAssets()`]: withHandlers(totalAssets),
    [`${vault}:totalSupply()`]: withHandlers(totalSupply),
    ...(paused === undefined ? {} : { [`${vault}:paused()`]: withHandlers(paused) }),
    ...(shutdown === undefined ? {} : { [`${vault}:isShutdown()`]: withHandlers(shutdown) }),
    ...(liquidityAdapter === undefined ? {} : { [`${vault}:0xad468d11`]: withHandlers(liquidityAdapter) }),
    [`${vault}:convertToAssets(uint256)`]: withHandlers(convertedAssets),
    ...(underlying
      ? {
          [`${underlying}:decimals()`]: withHandlers(decimals),
          [`${underlying}:balanceOf(address)`]: withHandlers((call: AdapterRpcCall) =>
            call.data === `0x70a08231${vaultAddress.slice(2).padStart(64, "0")}` ? idleBalance ?? null : null),
        }
      : {}),
    ...Object.fromEntries(
      [
        "0x9aa7df94",
        "0xa9bbf1cc",
        "0x39ebf823",
        "0xce96cb77",
        "0x160b71df",
        "0xbf2428e6",
        "0x35269315",
        "0x90b9f9e4",
        "0xb249b35d",
        "0x1d30e266",
        "0x9e65741e",
        "0xe7c2a608",
        "0x5c975abb",
        "0x18160ddd",
        "0x70a08231",
        "0xad468d11",
        "0x7bfef9fa",
        // stUSDS unused-funds probe: vat(), jug(), clip(), ilk(), ilks(bytes32),
        // Due() and Multicall3 getCurrentBlockTimestamp().
        "0x36569e77",
        "0x84718d89",
        "0x39b00e41",
        "0xc5ce281e",
        "0xd9638d36",
        "0x08bf162f",
        "0x0f28c97d",
      ]
        .map((selector) => [selector, async (call: AdapterRpcCall) => {
          const response = await invokeExtra(call, call.url, rpcHandlerBody(call));
          if (response == null) return null;
          return responseValue(response);
        }]),
    ),
  };
  activeNetwork = installAdapterNetwork({
    chains: { [chain]: "https://rpc.example" },
    rpc,
    ...(json ? { json } : {}),
  });
  return activeNetwork;
}
export function getErc4626Network(): AdapterNetwork | undefined {
  return activeNetwork;
}

/** Restore the default network between files that share one module cache, so a
 * test omitting `installErc4626Network()` cannot inherit the previous file's
 * chain in the non-isolated `worker-shared` project. */
export function resetErc4626NetworkForTests(): void {
  activeNetwork = undefined;
}

export async function runTrackedVault(
  id: string,
  configTransform?: (config: LiveReservesConfig) => LiveReservesConfig,
  ctx?: Partial<AdapterContext>,
): Promise<Awaited<ReturnType<typeof fetchErc4626SingleAssetReserves>>> {
  const coin = TRACKED_META_BY_ID.get(id);
  if (!coin?.liveReservesConfig) throw new Error(`Missing live reserve config for ${id}`);
  const config = configTransform ? configTransform(coin.liveReservesConfig) : coin.liveReservesConfig;
  const network = activeNetwork ?? installErc4626Network();
  return fetchErc4626SingleAssetReserves(
    coin,
    config,
    new AbortController().signal,
    { chainRpcs: network.chainRpcs, ...ctx },
  );
}

// Generic underlying-token fixture; not Maple's reviewed pooled claim.
export function asUnderlyingFixture(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config);
  delete cloned.params!.pooledClaim;
  cloned.params!.slice = {
    ...(cloned.params!.slice as object),
    coinId: "usdc-circle",
    depType: "wrapper",
  };
  return cloned;
}

export function uint256Result(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

export function addressWord(address: string): string {
  return address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
}

export function addressArrayResult(addresses: string[]): string {
  return `0x${[
    BigInt(32).toString(16).padStart(64, "0"),
    BigInt(addresses.length).toString(16).padStart(64, "0"),
    ...addresses.map(addressWord),
  ].join("")}`;
}

export function strategyParamsResult(currentDebtRaw: bigint | number): string {
  return `0x${[
    BigInt(1).toString(16).padStart(64, "0"),
    BigInt(2).toString(16).padStart(64, "0"),
    BigInt(currentDebtRaw).toString(16).padStart(64, "0"),
    BigInt(1_000_000_000_000n).toString(16).padStart(64, "0"),
  ].join("")}`;
}

export function cloneConfigWithoutExpectedAsset(config: LiveReservesConfig): LiveReservesConfig {
  const cloned = structuredClone(config) as LiveReservesConfig & {
    params: { slice?: { expectedAssetAddress?: string } };
  };
  delete cloned.params.slice?.expectedAssetAddress;
  return cloned;
}

export function nonInfoWarnings(warnings: readonly LiveReserveWarning[] | undefined): readonly LiveReserveWarning[] {
  return (warnings ?? []).filter((warning) => warning.effect !== "info");
}

export function withRedemptionLiquidity(redemptionLiquidity: {
  source: "morpho-vault-v1" | "morpho-vault-v2" | "atomic-full-backing" | "yearn-v3-withdrawable" | "sbold-sp-withdrawable" | "stusds-unused-funds";
  chainId?: number;
  settlementDelaySec?: number;
  vatAddress?: string;
  jugAddress?: string;
  clipperAddress?: string;
  ilk?: string;
}) {
  return (config: LiveReservesConfig): LiveReservesConfig => ({
    ...config, params: { ...config.params, redemptionLiquidity },
  });
}

export function calcFragmentsResult(
  boldAmountRaw: bigint | number,
  collInBoldRaw: bigint | number = 0,
): string {
  return `0x${[
    uint256Result(100_000_000n).slice(2),
    uint256Result(boldAmountRaw).slice(2),
    uint256Result(0).slice(2),
    uint256Result(collInBoldRaw).slice(2),
  ].join("")}`;
}

export function installSbold({
  paused,
  fragments = calcFragmentsResult(85_000_000n),
  maxCollateral = uint256Result(7_500_000n),
  onFragments,
}: {
  paused?: number;
  fragments?: string;
  maxCollateral?: string | null;
  onFragments?: (call: { to?: string; data: string }) => void;
} = {}) {
  return installErc4626Network({ idleBalance: 1_000_000n, paused, extraHandlers: [({ call }) => {
    if (call?.data === "0x160b71df") {
      onFragments?.(call);
      return jsonResponse({ result: fragments });
    }
    if (call?.data === "0xbf2428e6") return maxCollateral === null ? null : jsonResponse({ result: maxCollateral });
    return undefined;
  }] });
}

export const STUSDS_WIRING = {
  vatAddress: "0x35d1b3f3d7966a1dfe207aa4514c12a259a0492b",
  jugAddress: "0x19c0976f590d67707e62397c87829d896dc0f1f1",
  clipperAddress: "0x836f56750517b1528b5078cba4ac4b94fbe4a399",
  ilk: "0x4c534556322d534b592d41000000000000000000000000000000000000000000",
} as const;
export const RAY = 10n ** 27n;

export function stusdsHandlers(options: {
  art: bigint; rate: bigint; dueRad?: bigint; duty?: bigint; rhoOffsetSec?: bigint; vat?: string;
}) {
  const now = 1_800_000_000n;
  const vault = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b";
  const ilk = STUSDS_WIRING.ilk.slice(2);
  return ({ call }: { call?: { to?: string; data: string } }) => {
    if (!call) return undefined;
    const to = call.to?.toLowerCase();
    if (to === vault && call.data === "0x36569e77") return jsonResponse({ result: `0x${addressWord(options.vat ?? STUSDS_WIRING.vatAddress)}` });
    if (to === vault && call.data === "0x84718d89") return jsonResponse({ result: `0x${addressWord(STUSDS_WIRING.jugAddress)}` });
    if (to === vault && call.data === "0x39b00e41") return jsonResponse({ result: `0x${addressWord(STUSDS_WIRING.clipperAddress)}` });
    if (to === vault && call.data === "0xc5ce281e") return jsonResponse({ result: STUSDS_WIRING.ilk });
    if (to === STUSDS_WIRING.vatAddress && call.data === `0xd9638d36${ilk}`) {
      return jsonResponse({ result: `0x${[options.art, options.rate, 0n, 0n, 0n].map((word) => word.toString(16).padStart(64, "0")).join("")}` });
    }
    if (to === STUSDS_WIRING.jugAddress && call.data === `0xd9638d36${ilk}`) {
      return jsonResponse({ result: `0x${[options.duty ?? RAY, now - (options.rhoOffsetSec ?? 0n)].map((word) => word.toString(16).padStart(64, "0")).join("")}` });
    }
    if (to === STUSDS_WIRING.clipperAddress && call.data === "0x08bf162f") return jsonResponse({ result: uint256Result(options.dueRad ?? 0n) });
    if (call.data === "0x0f28c97d") return jsonResponse({ result: uint256Result(now) });
    return undefined;
  };
}

export function mockYearnV3Rpc(isShutdownRaw?: bigint | number, pausedRaw?: bigint | number) {
  const strategyA = "0x1111111111111111111111111111111111111111";
  const strategyB = "0x2222222222222222222222222222222222222222";
  const vault = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b";
  installErc4626Network({
    idleBalance: 5_000_000n,
    shutdown: isShutdownRaw,
    paused: pausedRaw,
    extraHandlers: [({ call }) => {
      if (!call) return undefined;
      const to = call.to?.toLowerCase();
      if (to === vault && call.data === "0x9aa7df94") {
        return jsonResponse({ result: uint256Result(5_000_000n) });
      }
      if (to === vault && call.data === "0xa9bbf1cc") {
        return jsonResponse({ result: addressArrayResult([strategyA, strategyB]) });
      }
      if (to === vault && call.data.startsWith("0x39ebf823")) {
        if (call.data === `0x39ebf823${addressWord(strategyA)}`) {
          return jsonResponse({ result: strategyParamsResult(60_000_000n) });
        }
        if (call.data === `0x39ebf823${addressWord(strategyB)}`) {
          return jsonResponse({ result: strategyParamsResult(35_000_000n) });
        }
      }
      if (call.data === `0xce96cb77${addressWord(vault)}` && to === strategyA) {
        return jsonResponse({ result: uint256Result(60_000_000n) });
      }
      if (call.data === `0xce96cb77${addressWord(vault)}` && to === strategyB) {
        return jsonResponse({ result: uint256Result(20_000_000n) });
      }
      return undefined;
    }],
  });
}

export function installTrackedMorphoV2(
  id: string,
  fixture: Erc4626RpcFixture = {},
  morpho: MorphoReadMockOptions = {},
) {
  const coin = TRACKED_META_BY_ID.get(id)!;
  const config = coin.liveReservesConfig!;
  const params = parseLiveReserveAdapterParams("erc4626-single-asset", config.params);
  const primary = config.inputs.primary;
  if (primary.kind !== "onchain-evm" || params.redemptionLiquidity?.source !== "morpho-vault-v2") {
    throw new Error(`Missing tracked Morpho V2 fixture for ${id}`);
  }
  const vault = coin.contracts!.find((c) => c.chain === primary.chain)!.address;
  const asset = params.slice.expectedAssetAddress!;
  const chainId = params.redemptionLiquidity.chainId;
  return installErc4626Network({
    chain: primary.chain, vault, asset, paused: 0, liquidityAdapter: 1,
    json: morphoReadJson({ version: "v2", chainId, vault, asset, ...morpho }),
    ...fixture,
  });
}

export function trackedVaultSnapshot(id: string, result: AdapterResult) {
  const coin = TRACKED_META_BY_ID.get(id)!;
  return {
    stablecoinId: id,
    slices: result.slices,
    fetchedAt: Math.floor(Date.now() / 1000),
    attemptId: "morpho-test-success",
    source: coin.liveReservesConfig!.adapter,
    metadata: result.metadata ?? {},
    warnings: result.warnings ?? [],
    warningCount: result.warnings?.length ?? 0,
    adapterSourceModel: "single-bucket" as const,
    adapterEvidenceClass: "independent" as const,
    configFingerprint: computeLiveReserveConfigFingerprint(coin.liveReservesConfig!),
  };
}

export function trackedVaultSyncState(snapshot: { fetchedAt: number; attemptId: string }) {
  return { lastSuccessAt: snapshot.fetchedAt, lastSuccessAttemptId: snapshot.attemptId };
}

export function admission(id: string, result: AdapterResult) {
  const snapshot = trackedVaultSnapshot(id, result);
  return evaluateLiveReserveAdmission(snapshot, trackedVaultSyncState(snapshot), TRACKED_META_BY_ID.get(id), snapshot.fetchedAt);
}

export function makeMorphoCacheDb() {
  const rows = new Map<string, { value: string; updated_at: number }>();
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        first: async () => rows.get(args[0] as string) ?? null,
        run: async () => {
          const [key, value, updatedAt] = args as [string, string, number];
          const prev = rows.get(key);
          if (!prev || prev.updated_at <= updatedAt) rows.set(key, { value, updated_at: updatedAt });
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;
  return { db, rows };
}

export const CATALOG_CASES = [
  { id: "syzusd-yuzu", asset: "0x6695c0f8706c5ace3bdf8995073179cca47926dc", vault: "0xc8a8df9b210243c55d31c73090f06787ad0a1bf6" },
  { id: "savusd-avant", asset: "0x24de8771bc5ddb3362db529fc3358f2df3a0e346", vault: "0x06d47f3fb376649c3a9dafe069b3d6e35572219e" },
  { id: "srusde-strata", asset: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", vault: "0x3d7d6fdf07ee548b939a80edbc9b2256d0cdc003" },
] as const;

export const COOLDOWN_SELECTOR = toFunctionSelector("cooldownDuration()");
export const WINDOW_SELECTOR = toFunctionSelector("getUnstakeWindow()");

export const withLocks = (config: LiveReservesConfig): LiveReservesConfig => ({
  ...config,
  params: { ...config.params, redemptionLock: [
    { selector: "cooldownDuration()", kind: "cooldown-seconds" },
    { selector: WINDOW_SELECTOR, kind: "unstake-window-seconds" },
    { selector: "paused()", kind: "paused-bool" },
  ] },
});

export function mockLocks(cooldown: bigint | null, paused = 0, window = 172800) {
  installErc4626Network({ idleBalance: 100_000_000n, paused, extraHandlers: [({ call }) => {
    if (call?.data !== COOLDOWN_SELECTOR && call?.data !== WINDOW_SELECTOR) return undefined;
    const value = call.data === COOLDOWN_SELECTOR ? cooldown : BigInt(window);
    return value == null ? null : jsonResponse({ result: `0x${value.toString(16).padStart(64, "0")}` });
  }] });
}

export function buildMorphoFailureCases(nowSec = Math.floor(Date.now() / 1000)) {
  return [
    { label: "unlisted V2", source: "morpho-vault-v2" as const, opts: { version: "v2" as const, listed: false }, code: "morpho-vault-v2-unlisted", callsState: false },
    { label: "unlisted V1", source: "morpho-vault-v1" as const, opts: { version: "v1" as const, listed: false }, code: "morpho-vault-v1-unlisted", callsState: false },
    { label: "asset mismatch", source: "morpho-vault-v2" as const, opts: { version: "v2" as const, dirAsset: "0x000000000000000000000000000000000000dead" }, code: "morpho-vault-v2-asset-mismatch", callsState: false },
    { label: "address mismatch", source: "morpho-vault-v2" as const, opts: { version: "v2" as const, stateAddress: "0x000000000000000000000000000000000000dead" }, code: "morpho-vault-v2-identity-mismatch", callsState: true },
    { label: "chain mismatch", source: "morpho-vault-v2" as const, opts: { version: "v2" as const, stateChainId: 8453 }, code: "morpho-vault-v2-chain-mismatch", callsState: true },
    { label: "invalid withdrawable", source: "morpho-vault-v2" as const, opts: { version: "v2" as const, withdrawable: "invalid" }, code: "morpho-vault-v2-liquidity-invalid", callsState: true },
    { label: "missing last_indexed_block", source: "morpho-vault-v2" as const, opts: { version: "v2" as const, lastIndexedBlock: null }, code: "morpho-vault-v2-liquidity-invalid", callsState: true },
    { label: "stale V1 indexed block", source: "morpho-vault-v1" as const, opts: { version: "v1" as const, lastIndexedBlock: "1" }, blockTimestamp: nowSec - 3600, code: "morpho-vault-v1-state-stale", callsState: true },
    { label: "stale V2 indexed block", source: "morpho-vault-v2" as const, opts: { version: "v2" as const }, blockTimestamp: nowSec - 3600, code: "morpho-vault-v2-state-stale", callsState: true },
    { label: "unreadable V2 indexed block", source: "morpho-vault-v2" as const, opts: { version: "v2" as const }, blockTimestamp: null as number | null, code: "morpho-vault-v2-liquidity-unavailable", callsState: true },
    { label: "future last_accrual_timestamp", source: "morpho-vault-v2" as const, opts: { version: "v2" as const, lastAccrualTimestamp: nowSec + 600 }, code: "morpho-vault-v2-state-stale", callsState: true },
    {
      label: "HTTP 206 partial directory page", source: "morpho-vault-v2" as const,
      opts: { version: "v2" as const, overrides: { "https://api.morpho.org/v0/vaults-v2?limit=1000": { status: 206, json: { data: [{ chain_id: 1, vault_address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", asset_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }], cursor: null } } } },
      code: "morpho-vault-v2-liquidity-unavailable", callsState: false,
    },
    {
      label: "missing directory cursor", source: "morpho-vault-v2" as const,
      opts: { version: "v2" as const, overrides: { "https://api.morpho.org/v0/vaults-v2?limit=1000": { data: [] } } },
      code: "morpho-vault-v2-liquidity-unavailable", callsState: false,
    },
    {
      label: "conflicting duplicate target asset", source: "morpho-vault-v2" as const,
      opts: { version: "v2" as const, overrides: { "https://api.morpho.org/v0/vaults-v2?limit=1000": { data: [
        { chain_id: 1, vault_address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", asset_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
        { chain_id: 1, vault_address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", asset_address: "0x000000000000000000000000000000000000dead" },
      ], cursor: null } } },
      code: "morpho-vault-v2-liquidity-invalid", callsState: false,
    },
    {
      label: "malformed target directory row", source: "morpho-vault-v2" as const,
      opts: { version: "v2" as const, overrides: { "https://api.morpho.org/v0/vaults-v2?limit=1000": { data: [{ chain_id: 1, vault_address: "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b", asset_address: "bad" }], cursor: null } } },
      code: "morpho-vault-v2-liquidity-invalid", callsState: false,
    },
    {
      label: "directory cursor cycle", source: "morpho-vault-v2" as const,
      opts: { version: "v2" as const, overrides: { "https://api.morpho.org/v0/vaults-v2?limit=1000": { data: [], cursor: "c1" }, "https://api.morpho.org/v0/vaults-v2?limit=1000&cursor=c1": { data: [], cursor: "c1" } } },
      code: "morpho-vault-v2-liquidity-unavailable", callsState: false,
    },
  ];
}
