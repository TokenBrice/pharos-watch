import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, keccak256, toFunctionSelector } from "viem/utils";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchErc4626SingleAssetReserves } from "../erc4626-single-asset";
import { LenderBookObservationSchema } from "@shared/types/safety-score-v9-lender-book";
import { lenderBookAdmissionReason } from "@shared/lib/safety-score-v9/lender-book-registry";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { MULTICALL3_ADDRESS } from "../../../lib/evm-rpc";
import { encodeUint256 } from "../../../lib/evm-selectors";
import { createAdapterIoLimiter } from "../concurrency";
import { accruedMorphoLenderAssets, observeMorphoLenderBook } from "../morpho-lender-book";
import { createReserveAdapterRunner } from "../../reserve-adapter-runner";
import { createAdapterLatencyCollector } from "../../sync-live-reserves-core";
import { CONFIGURED_COINS } from "../../sync-live-reserves-shared";
import { getReserveAdapter } from "../index";
import { installAdapterNetwork, resolveAdapterCoin, type AdapterNetworkSpec, type AdapterRpcValue } from "./reserve-adapter.test-support";

const ZERO = "0x0000000000000000000000000000000000000000";
const LOAN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const CORE = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";
const IRM = "0x870ac11d48b15db9a138cf899d20f13f79ba00bc";
const ADAPTER = "0x1d511811aca9d8817a3e50f29cadff6243a02902";
const INNER = "0x1111111111111111111111111111111111111111";
const PIN = { number: 26191269, timestamp: 1791987287, hash: "0xc492993fd90ab9821b6b1124f9f844a8f2230cfc74f45c76767a773359bb2db7" };
const SMOKE_PIN = { number: 26192161, timestamp: 1791997991, hash: "0x27fcd55ab33c6575b688fa27e4da4f5fb67127946805cb9ec532876c8c319540" };
const WAD = 10n ** 18n;
function packed(values: (bigint | string)[]): `0x${string}` {
  return `0x${values.map(value => typeof value === "bigint" ? encodeUint256(value) : value.slice(2).padStart(64, "0")).join("")}`;
}
function data(signature: string, args = "") { return `${toFunctionSelector(signature)}${args}`; }
interface MarketFixture {
  params: `0x${string}`; id: string; state: `0x${string}`; position: `0x${string}`; assets: bigint;
}
function market(assets: bigint, index = 1, overrides: Partial<MarketFixture> = {}): MarketFixture {
  const params = packed([LOAN, `0x${index.toString(16).padStart(40, "0")}`, INNER, IRM, 860000000000000000n]);
  const shares = assets * 1_000_000n;
  return { params, id: keccak256(params), state: packed([assets, shares, 0n, 0n, BigInt(PIN.timestamp), 0n]),
    position: packed([shares, 0n, 0n]), assets, ...overrides };
}
function fixture(rows = [market(100n)], assetId = "kpkusdcprime-kpk", mode: "direct" | "meta" | "nested" = "direct"): {
  spec: AdapterNetworkSpec; coin: StablecoinMeta; config: LiveReservesConfig;
  vault: string; rpc: Record<string, AdapterRpcValue>;
} {
  const { coin, config } = resolveAdapterCoin("erc4626-single-asset", assetId);
  const vault = coin.contracts!.find(row => row.chain === "ethereum")!.address.toLowerCase();
  const total = rows.reduce((sum, row) => sum + row.assets, 0n);
  const metaVault = mode === "nested" ? INNER : vault;
  const account = mode === "direct" ? ADAPTER : metaVault;
  const rpc: Record<string, AdapterRpcValue> = {
    "asset()": LOAN, "totalAssets()": total, "totalSupply()": total * 1_000_000n,
    "decimals()": 6n, "balanceOf(address)": 0n,
    [`${vault}:adaptersLength()`]: 1n, [`${vault}:adapters(uint256)`]: ADAPTER,
    [`${ADAPTER}:parentVault()`]: vault, [`${ADAPTER}:realAssets()`]: total,
    [`${ADAPTER}:asset()`]: mode === "direct" ? LOAN : null,
    [`${ADAPTER}:morpho()`]: mode === "direct" ? CORE : null,
    [`${ADAPTER}:marketIdsLength()`]: mode === "direct" ? BigInt(rows.length) : null,
    [`${ADAPTER}:morphoVaultV1()`]: mode === "nested" ? INNER : null,
    "MORPHO()": CORE, "withdrawQueueLength()": BigInt(rows.length), "supplyQueueLength()": BigInt(rows.length),
    "_totalAssets()": () => {
      const value = rpc[`${vault}:totalAssets()`] ?? rpc["totalAssets()"];
      if (typeof value !== "bigint") throw new Error("Fixture total must be a raw bigint");
      return value;
    },
    "lastUpdate()": BigInt(PIN.timestamp), "maxRate()": 0n,
    "borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))": 0n,
  };
  for (const [index, row] of rows.entries()) {
    rpc[`${ADAPTER}:${data("marketIds(uint256)", encodeUint256(index))}`] = row.id;
    rpc[`${metaVault}:${data("withdrawQueue(uint256)", encodeUint256(index))}`] = row.id;
    rpc[`${metaVault}:${data("supplyQueue(uint256)", encodeUint256(index))}`] = row.id;
    rpc[`${CORE}:${data("idToMarketParams(bytes32)", row.id.slice(2))}`] = row.params;
    rpc[`${CORE}:${data("market(bytes32)", row.id.slice(2))}`] = row.state;
    rpc[`${CORE}:${data("position(bytes32,address)", `${row.id.slice(2)}${account.slice(2).padStart(64, "0")}`)}`] = row.position;
    rpc[`${ADAPTER}:${data("expectedSupplyAssets(bytes32)", row.id.slice(2))}`] = row.assets;
    rpc[`${ADAPTER}:${data("supplyShares(bytes32)", row.id.slice(2))}`] = `0x${row.position.slice(2, 66)}`;
  }
  const code = Object.fromEntries([vault, ADAPTER, INNER, LOAN, CORE, IRM, MULTICALL3_ADDRESS.toLowerCase()].map(address => [address, "0x60006000"]));
  return { spec: { rpc, code, block: PIN }, coin, config, vault, rpc };
}
async function observe(f = fixture(), signal = new AbortController().signal) {
  const network = installAdapterNetwork(f.spec);
  const ctx = { chainRpcs: network.chainRpcs, requestCache: new Map<string, Promise<unknown>>(),
    ioLimiter: createAdapterIoLimiter(), nowSec: PIN.timestamp + 60 };
  const result = await observeMorphoLenderBook(f.coin, f.config, signal, ctx);
  return { result, network, ctx };
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue((PIN.timestamp + 60) * 1000); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

// Exact source tuples and expected claims at block 26191269, census-prime.md
// §1C. The state/position fixture below uses the PIN's stored balances, not a
// naive conversion of those balances into current claims.
const primeRows: MarketFixture[] = [
  ["0xae78736cd615f374d3085123a210448e74fc6393", "0x36cb058364a811636685ef15a71e8ea99043f815", 860000000000000000n, 3129335529826n, 3138811475719n, 3076320092711625883n, 2823771989077n, 2760616124948291325n, 1791958979n, 3066922906134260971n],
  ["0x856c4efb76c1d1ae02e20ceb03a2a6a08b0b8dc3", "0xe8adff9117151fb5ad7313873780b87cc56eedb0", 860000000000000000n, 2401512502632n, 10626063365428n, 10162106120573574188n, 9581226161315n, 9115567832980333907n, 1791979535n, 2296618323023697461n],
  ["0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", "0xa6d6950c9f177f1de7f7757fb33539e3ec60182a", 860000000000000000n, 12834378526082n, 347064698097519n, 316687320304768046031n, 304754459014801n, 274649020456573067459n, 1791986855n, 11711023056322378946n],
  ["0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "0xdddd770badd886df3864029e4b377b5f6a2b6b83", 860000000000000000n, 7564078214138n, 131548642331009n, 114698179027116352318n, 116334291815925n, 99495924581515042953n, 1791986963n, 6595169747712917158n],
  ["0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", "0x48f7e36eb6b826b2df4b2e630b62cd25e89e40e2", 860000000000000000n, 3026509767996n, 33334688626717n, 29052109308932359229n, 29263866346628n, 25011039154534638703n, 1791986963n, 2637686432234552355n],
  ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0x0f948cba8231db7898ef36a4212581ad7b1b4580", 860000000000000000n, 539585442002n, 9563368273263n, 9261286182528389277n, 8269236861647n, 7973399879233838516n, 1791987131n, 522541227297906298n],
  ["0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", "0xa3a7a3cefee206f9d7fe00ec3c83324ed4228411", 770000000000000000n, 1n, 45466790643n, 44641388733984167n, 13691612928n, 13410777029027298n, 1791974135n, 1701250n],
  ["0x8c1bed5b9a0928467c9b1341da1d7bd5e10b6549", "0x377f722043bb5d021f4366127d49c772e1c01c7b", 860000000000000000n, 292316170957n, 292191496129n, 289355572133680476n, 242508261496n, 239866946444296060n, 1791474395n, 289354572133680476n],
].map(row => {
  const [collateral, oracle, lltv, assets, sa, ss, ba, bs, last, position] = row as [string, string, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const params = packed([LOAN, collateral, oracle, IRM, lltv]);
  return { params, id: keccak256(params), assets, state: packed([sa, ss, ba, bs, last, 0n]), position: packed([position, 0n, 0n]) };
});

describe("Morpho NAV-accounted lender-book producer", () => {
  it("emits the PIN Prime eight-market exact total and preserves one-unit dust", async () => {
    const { result, network } = await observe(fixture(primeRows));
    expect(result.status).toBe("ok");
    expect(LenderBookObservationSchema.safeParse(result).success).toBe(true);
    expect(lenderBookAdmissionReason(result, "kpkusdcprime-kpk", PIN.timestamp + 60, V9_CANDIDATE_POLICY_V1.policy.semantic.backing.lenderCollateralBook)).toBeNull();
    if (result.status !== "ok") return;
    expect(result.deployments[0]).toMatchObject({ totalAssetsRaw: "29787716153634", idleAssetsRaw: "0", reconciliationResidualRaw: "0" });
    expect(result.deployments[0].markets).toHaveLength(8);
    expect(result.deployments[0].markets.some(row => row.includedAssetsRaw === "1")).toBe(true);
    expect(network.requests.every(row => !row.url.includes("graphql"))).toBe(true);
    expect(network.rpcCalls.some(row => row.data.startsWith(toFunctionSelector("allocation(bytes32)")))).toBe(false);
  });
  it("batches complete market tuples and reuses block-bound reads/code within a slice", async () => {
    const f = fixture(primeRows);
    const network = installAdapterNetwork(f.spec);
    const ioLimiter = createAdapterIoLimiter();
    const io = vi.spyOn(ioLimiter, "run");
    const requestCache = new Map<string, Promise<unknown>>();
    const ctx = { chainRpcs: network.chainRpcs, requestCache, ioLimiter };
    const signal = new AbortController().signal;
    const first = await observeMorphoLenderBook(f.coin, f.config, signal, ctx);
    expect(first.status).toBe("ok");
    // Forty exact tuple/position/accounting calls fit two <=32-call waves,
    // rather than eight independent per-market requests.
    expect(io.mock.calls.filter(([label]) => label === "lender-book-batch:ethereum")).toHaveLength(7);
    expect(io.mock.calls.filter(([label]) => label === `lender-book-code:ethereum:${MULTICALL3_ADDRESS}`)).toHaveLength(1);
    const firstRequests = network.requests.length;
    io.mockClear();
    const second = await observeMorphoLenderBook(f.coin, f.config, signal, ctx);
    expect(second).toEqual(first);
    // Re-reading the same immutable book still rechecks its header; it cannot
    // reuse the final canonicality check merely because the payload is cached.
    expect(network.requests.length - firstRequests).toBe(1);
    expect(io.mock.calls.map(([label]) => label)).toEqual(["lender-book-recheck:ethereum"]);
    requestCache.clear();
    io.mockClear();
    expect((await observeMorphoLenderBook(f.coin, f.config, signal, ctx)).status).toBe("ok");
    expect(io.mock.calls.some(([label]) => label.startsWith("lender-book-code:"))).toBe(true);
  });

  it("does not reuse code or state across different finalized block hashes", async () => {
    const f = fixture(primeRows);
    const firstNetwork = installAdapterNetwork(f.spec);
    const requestCache = new Map<string, Promise<unknown>>();
    const signal = new AbortController().signal;
    expect((await observeMorphoLenderBook(f.coin, f.config, signal, {
      chainRpcs: firstNetwork.chainRpcs, requestCache,
    })).status).toBe("ok");
    const changedPin = { ...PIN, hash: `0x${"ab".repeat(32)}` };
    requestCache.set("morpho-book:finalized:ethereum", Promise.resolve(changedPin));
    f.spec.block = changedPin;
    f.spec.code![f.vault] = "0x";
    const nextNetwork = installAdapterNetwork(f.spec);
    expect(await observeMorphoLenderBook(f.coin, f.config, signal, {
      chainRpcs: nextNetwork.chainRpcs, requestCache,
    })).toMatchObject({ status: "unavailable", reason: "identity-mismatch" });
    expect(nextNetwork.requests.length).toBeGreaterThan(0);
  });

  it("does not add four off-NAV one-unit Yield residuals to its seven current claims", async () => {
    // Exact claim amounts from census-yield.md §2.2; synthetic immutable market
    // tuples intentionally isolate current enumeration from historical positions.
    const amounts = [55489558n, 455553278361n, 6198058117175n, 900750407987n, 1312328375771n, 3387753291335n, 1000607668589n];
    const f = fixture(amounts.map((amount, index) => market(amount, index + 1)), "kpkusdcyield-kpk");
    for (let i = 20; i < 24; i++) {
      const row = market(1n, i);
      f.rpc[`${ADAPTER}:${data("expectedSupplyAssets(bytes32)", row.id.slice(2))}`] = 1n;
    }
    const { result, network } = await observe(f);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.deployments[0].totalAssetsRaw).toBe("13255106628776");
    expect(result.deployments[0].markets).toHaveLength(7);
    expect(network.rpcCalls.filter(row => row.selector === toFunctionSelector("expectedSupplyAssets(bytes32)"))).toHaveLength(7);
  });
  it.each([
    ["wrong parent", "parentVault()", LOAN, "identity-mismatch"],
    ["wrong underlying", "asset()", CORE, "identity-mismatch"],
    ["unsupported replacement adapter", "marketIdsLength()", null, "unsupported-adapter"],
    ["adapter cap", "marketIdsLength()", 129n, "census-limit"],
    ["one-unit reconciliation residual", "realAssets()", 101n, "unreconciled"],
  ] as const)("fails closed: %s", async (_label, selector, value, reason) => {
    const f = fixture(); f.rpc[`${ADAPTER}:${selector}`] = value;
    const { result } = await observe(f);
    expect(result).toMatchObject({ status: "unavailable", reason, deployments: null });
  });
  it.each(["0x", "invalid-bytecode"])("distinguishes absent code from unavailable RPC: %s", async code => {
    const f = fixture(); f.spec.code![f.vault] = code;
    expect((await observe(f)).result).toMatchObject({
      status: "unavailable", reason: code === "0x" ? "identity-mismatch" : "rpc-unavailable",
    });
  });
  it.each(["decimals()", "DECIMALS_OFFSET()"])("labels out-of-range %s as malformed", async signature => {
    const f = fixture([market(100n)], "kpkusdcprime-kpk", signature === "decimals()" ? "direct" : "nested");
    f.rpc[signature] = 37n;
    if (signature === "DECIMALS_OFFSET()") {
      f.rpc["fee()"] = 0n; f.rpc["lastTotalAssets()"] = 100n; f.rpc[`${ADAPTER}:allocation()`] = 100n;
    }
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "malformed" });
  });
  it("reports zero NAV as unavailable, not an all-idle success", async () => {
    expect((await observe(fixture([]))).result).toMatchObject({ status: "unavailable", reason: "zero-nav", deployments: null });
  });
  it("rejects non-lender positions and duplicate claims", async () => {
    const row = market(100n, 1, { position: packed([100_000_000n, 1n, 0n]) });
    expect((await observe(fixture([row]))).result).toMatchObject({ status: "unavailable", reason: "position-not-lender-only" });
    const postedCollateral = market(100n, 1, { position: packed([100_000_000n, 0n, 1n]) });
    expect((await observe(fixture([postedCollateral]))).result).toMatchObject({ status: "unavailable", reason: "position-not-lender-only" });
    expect((await observe(fixture([market(100n), market(100n)]))).result).toMatchObject({ status: "unavailable", reason: "incomplete-census" });
  });
  it("requires every market tuple and position; failed reads cannot become zero", async () => {
    const f = fixture(); const row = market(100n);
    f.rpc[`${CORE}:${data("market(bytes32)", row.id.slice(2))}`] = null;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "incomplete-census" });
  });
  it("rejects a tuple/core identity whose hash does not match its enumerated ID", async () => {
    const row = market(100n); const f = fixture([row]);
    f.rpc[`${CORE}:${data("idToMarketParams(bytes32)", row.id.slice(2))}`] = market(100n, 2).params;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "identity-mismatch" });
  });
  it("observes changed/new adapter enumeration rather than an authored allowlist", async () => {
    const f = fixture(); const replacement = "0x2222222222222222222222222222222222222222";
    f.spec.code![replacement] = "0x60016001";
    f.rpc[`${f.vault}:adapters(uint256)`] = replacement;
    for (const [key, value] of Object.entries(f.rpc)) if (key.startsWith(`${ADAPTER}:`)) f.rpc[key.replace(ADAPTER, replacement)] = value;
    const oldPosition = `${CORE}:${data("position(bytes32,address)", `${market(100n).id.slice(2)}${ADAPTER.slice(2).padStart(64, "0")}`)}`;
    f.rpc[oldPosition.replace(ADAPTER.slice(2), replacement.slice(2))] = packed([100_000_000n, 0n, 0n]);
    const { result } = await observe(f);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.deployments[0].markets[0].account).toBe(replacement);
  });
  it("enforces the adapter count and global included-market cap", async () => {
    const f = fixture(); f.rpc[`${f.vault}:adaptersLength()`] = 17n;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "census-limit" });
    expect((await observe(fixture(Array.from({ length: 129 }, (_, i) => market(1n, i + 1))))).result)
      .toMatchObject({ status: "unavailable", reason: "census-limit" });
  });
  it("accepts the inclusive 128-market bound and splits queue reads into at most 32-call requests", async () => {
    const { result, network } = await observe(fixture(Array.from({ length: 128 }, (_, index) => market(1n, index + 1))));
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.deployments[0].markets).toHaveLength(128);
    expect(network.rpcCalls.filter(row => row.selector === toFunctionSelector("marketIds(uint256)"))).toHaveLength(128);
  });
  it("accepts exactly sixteen empty adapters only after complete successful reads", async () => {
    const f = fixture([]);
    f.rpc["totalAssets()"] = 100n; f.rpc["balanceOf(address)"] = 100n;
    f.rpc[`${f.vault}:adaptersLength()`] = 16n;
    for (let index = 0; index < 16; index++) {
      const adapter = `0x${(1000 + index).toString(16).padStart(40, "0")}`;
      f.spec.code![adapter] = "0x60006000";
      f.rpc[`${f.vault}:${data("adapters(uint256)", encodeUint256(index))}`] = adapter;
      for (const [key, value] of Object.entries(f.rpc)) if (key.startsWith(`${ADAPTER}:`)) f.rpc[key.replace(ADAPTER, adapter)] = value;
    }
    expect((await observe(f)).result.status).toBe("ok");
  });
  it.each(["partial", "reordered"] as const)("fails closed on %s Multicall return slots", async mode => {
    const f = fixture();
    const network = installAdapterNetwork(f.spec);
    const fetch = globalThis.fetch;
    let changed = false;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const request = new Request(...args);
      const body = await request.clone().json() as { method: string; params: { data?: string }[] };
      const response = await fetch(request);
      if (!changed && body.method === "eth_call" && body.params[0]?.data?.startsWith("0x82ad56cb")) {
        changed = true;
        const payload = await response.json() as { result: `0x${string}` };
        const abi = [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }] as const;
        const [slots] = decodeAbiParameters(abi, payload.result);
        const corrupt = mode === "partial" ? slots.slice(1) : [...slots].reverse();
        return Response.json({ ...payload, result: encodeAbiParameters(abi, [corrupt]) });
      }
      return response;
    });
    const result = await observeMorphoLenderBook(f.coin, f.config, new AbortController().signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map(), ioLimiter: createAdapterIoLimiter() });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(["rpc-unavailable", "identity-mismatch", "malformed"]).toContain(result.reason);
  });
  it("rechecks the hash before admitting state", async () => {
    const f = fixture(); f.rpc[`eth_getBlockByNumber:0x${PIN.number.toString(16)}`] = { hash: `0x${"f".repeat(64)}` };
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "block-changed" });
  });
  it("returns explicit cancellation and unsupported-chain outcomes", async () => {
    const control = new AbortController(); control.abort();
    expect((await observe(fixture(), control.signal)).result).toMatchObject({ status: "unavailable", reason: "aborted" });
    const f = fixture();
    expect(await observeMorphoLenderBook(f.coin, f.config, new AbortController().signal, { chainRpcs: new Map() }))
      .toMatchObject({ status: "unavailable", reason: "unsupported-chain" });
  });
  it("accepts an exhaustive all-idle root, never an unread queue", async () => {
    const f = fixture([]); f.rpc["totalAssets()"] = 100n; f.rpc["balanceOf(address)"] = 100n;
    const { result } = await observe(f);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.deployments[0]).toMatchObject({ idleAssetsRaw: "100", markets: [] });
    f.rpc[`${f.vault}:adaptersLength()`] = null;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "incomplete-census" });
  });
  it("bounds the subphase deadline and keeps ordinary denomination/redemption metadata", async () => {
    const f = fixture();
    f.rpc[`${ADAPTER}:marketIdsLength()`] = null;
    f.rpc["paused()"] = false;
    f.rpc["convertToAssets(uint256)"] = 100n;
    const network = installAdapterNetwork(f.spec);
    const params = { ...f.config.params };
    delete params.redemptionLiquidity;
    const reserve = await fetchErc4626SingleAssetReserves(f.coin, { ...f.config, params }, new AbortController().signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map(), nowSec: PIN.timestamp + 60 });
    expect(reserve.slices).toHaveLength(1);
    expect(reserve.metadata).toMatchObject({
      totalAssetsRaw: "100", assetAddress: LOAN,
      lenderBookObservation: { status: "unavailable", reason: "unsupported-adapter" },
      idleUnderlyingBalanceRaw: "0",
      redemptionCapacityRaw: "0",
      redemptionCapacitySource: "erc4626-idle-underlying",
      redemption: {
        capacityKind: "live-direct",
        capacityUsd: 0,
        capacityRatioOfSupply: 0,
        freshnessKind: "same-run-onchain",
      },
    });
    expect(reserve.warnings?.some(row => row.code.includes("lender-book"))).not.toBe(true);
    // Advance the wall clock while the finalized-header RPC settles; the
    // reader must reject before opening a state request under the expired pin.
    const start = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => start);
    const expired = fixture();
    const expiredPin = vi.fn(() => {
      vi.spyOn(Date, "now").mockReturnValue(start + 20_001);
      return PIN;
    });
    expired.rpc["eth_getBlockByNumber"] = expiredPin;
    const deadlineObservation = await observe(expired);
    expect(expiredPin).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ block: "finalized" }));
    expect(deadlineObservation.result).toMatchObject({ status: "unavailable", reason: "deadline" });
    expect(deadlineObservation.network.rpcCalls).toHaveLength(0);
  });
  it("skips the optional census when only the attempt return margin remains", async () => {
    const f = fixture();
    const network = installAdapterNetwork(f.spec);
    const result = await observeMorphoLenderBook(f.coin, f.config, new AbortController().signal, {
      chainRpcs: network.chainRpcs, attemptDeadlineMs: Date.now() + 250,
    });
    expect(result).toMatchObject({ status: "unavailable", reason: "deadline", deployments: null });
    expect(network.fetchSpy).not.toHaveBeenCalled();
  });
  it("bounds a shared pending finalized pin by this attempt's shorter phase allowance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((PIN.timestamp + 60) * 1000);
    const f = fixture();
    const network = installAdapterNetwork(f.spec);
    const requestCache = new Map<string, Promise<unknown>>();
    let resolvePin!: (pin: typeof PIN) => void;
    const sharedPin = new Promise<typeof PIN>(resolve => { resolvePin = resolve; });
    requestCache.set("morpho-book:finalized:ethereum", sharedPin);
    const pending = observeMorphoLenderBook(f.coin, f.config, new AbortController().signal, {
      chainRpcs: network.chainRpcs, requestCache, attemptDeadlineMs: Date.now() + 1_000,
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toMatchObject({ status: "unavailable", reason: "deadline", deployments: null });
    expect(network.fetchSpy).not.toHaveBeenCalled();
    resolvePin(PIN);
  });
  it.each(["attempt", "run"] as const)("preserves slow ordinary success when the book exceeds the runner %s deadline", async limit => {
    vi.useFakeTimers();
    vi.setSystemTime((PIN.timestamp + 60) * 1000);
    const start = Date.now();
    const f = fixture();
    f.rpc["paused()"] = false;
    f.rpc["convertToAssets(uint256)"] = 100n;
    let ordinaryStarted = false;
    f.rpc["totalAssets()"] = async () => {
      if (!ordinaryStarted) {
        ordinaryStarted = true;
        await new Promise<void>(resolve => { setTimeout(resolve, 8_000); });
      }
      return 100n;
    };
    const network = installAdapterNetwork(f.spec);
    const fetch = globalThis.fetch;
    let bookStarted = false;
    let bookAborted = false;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const request = new Request(...args);
      const body = await request.clone().json() as { method: string; params: unknown[] };
      if (body.method !== "eth_getBlockByNumber" || body.params[0] !== "finalized") return fetch(request);
      bookStarted = true;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          request.signal.removeEventListener("abort", abort);
          void fetch(request).then(resolve, reject);
        }, 15_000);
        const abort = () => {
          bookAborted = true;
          clearTimeout(timer);
          reject(request.signal.reason);
        };
        request.signal.addEventListener("abort", abort, { once: true });
      });
    });
    const params = { ...f.config.params };
    delete params.redemptionLiquidity;
    const config = { ...f.config, params };
    const coin = CONFIGURED_COINS.find(row => row.id === f.coin.id)!;
    const runner = createReserveAdapterRunner({
      signal: new AbortController().signal,
      adapterCtx: { chainRpcs: network.chainRpcs, requestCache: new Map() },
      adapterTimeoutMs: limit === "attempt" ? 20_000 : 30_000,
      telemetry: createAdapterLatencyCollector(),
    });
    const pending = runner(coin, config, getReserveAdapter("erc4626-single-asset")!,
      limit === "run" ? start + 20_000 : undefined);
    const resolved = vi.fn();
    void pending.then(resolved);
    await vi.advanceTimersByTimeAsync(19_749);
    expect(bookStarted).toBe(true);
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const reserve = await pending;
    expect(Date.now()).toBe(start + 19_750);
    expect(bookAborted).toBe(true);
    expect(reserve.slices).toMatchObject([{ pct: 100, coinId: "usdc-circle" }]);
    expect(reserve.metadata).toMatchObject({
      totalAssetsRaw: "100", assetAddress: LOAN, idleUnderlyingBalanceRaw: "0",
      lenderBookObservation: { status: "unavailable", reason: "deadline" },
      redemptionCapacityRaw: "0", redemptionCapacitySource: "erc4626-idle-underlying",
      redemption: { capacityKind: "live-direct", capacityUsd: 0, freshnessKind: "same-run-onchain" },
    });
    expect(reserve.warnings?.some(row => row.code === "primary-fallback-used" || row.code.includes("lender-book"))).not.toBe(true);
  });
  it.each(["multicall", "direct-fallback", "provider-fallback"] as const)("consumes bodies before next request: %s", async mode => {
    const f = fixture(primeRows);
    if (mode === "direct-fallback") f.spec.code![MULTICALL3_ADDRESS.toLowerCase()] = "0x";
    if (mode === "provider-fallback") {
      f.config = { ...f.config, params: { ...f.config.params, fallbackRpcUrl: "https://fallback.example" } };
    }
    const network = installAdapterNetwork(f.spec);
    const fetch = globalThis.fetch;
    let active = 0; let peak = 0;
    let failedProvider = false;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      active++; peak = Math.max(peak, active);
      const response = mode === "provider-fallback" && !failedProvider
        ? (failedProvider = true, new Response("bounded upstream failure", { status: 503 }))
        : await fetch(...args);
      const reader = response.body!.getReader();
      let finished = false;
      const finish = () => { if (!finished) { finished = true; active--; } };
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          const row = await reader.read();
          if (row.done) { finish(); controller.close(); } else controller.enqueue(row.value);
        },
        async cancel(reason) { finish(); await reader.cancel(reason); },
      }), { status: response.status, headers: response.headers });
    });
    const result = await observeMorphoLenderBook(f.coin, f.config, new AbortController().signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map(), ioLimiter: createAdapterIoLimiter(), nowSec: PIN.timestamp + 60 });
    expect(result.status).toBe("ok");
    expect(peak).toBe(1); expect(active).toBe(0);
    if (mode === "direct-fallback") expect(network.rpcCalls.some(row => !row.viaMulticall && row.selector === toFunctionSelector("expectedSupplyAssets(bytes32)"))).toBe(true);
    if (mode === "provider-fallback") expect(failedProvider).toBe(true);
  });
  it("reconciles the pinned Steakhouse capped NAV against its exact real investment book", async () => {
    // Ethereum block 26192161: steakcusdc root / adapter 0x17bc9aa135cef1a5c3a91925e0f865d526318718.
    // The market tuple, internal shares, expected claims and cap inputs are actual RPC values.
    const rows = [
      ["0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", "0xa6d6950c9f177f1de7f7757fb33539e3ec60182a", 25092893655745n, 344214427267714n, 314082067076566866071n, 304759326555915n, 274648994248516240791n, 1791997763n, 22896267374265512414n],
      ["0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", "0x48f7e36eb6b826b2df4b2e630b62cd25e89e40e2", 9931384445734n, 33053056301420n, 28806268009575331386n, 29264315979406n, 25011039153070054698n, 1791997391n, 8655353838659231622n],
      ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0x0f948cba8231db7898ef36a4212581ad7b1b4580", 296311103960n, 9483320034964n, 9183641714817653454n, 8269365966704n, 7973399879233838516n, 1791997571n, 286947346756493373n],
    ].map(row => {
      const [collateral, oracle, assets, sa, ss, ba, bs, last, shares] = row as [string, string, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
      const params = packed([LOAN, collateral, oracle, IRM, 860000000000000000n]);
      return { params, id: keccak256(params), assets, state: packed([sa, ss, ba, bs, last, 0n]), position: packed([shares, 0n, 0n]) };
    });
    const f = fixture(rows, "steakcusdc-steakhouse");
    f.spec.block = SMOKE_PIN;
    vi.spyOn(Date, "now").mockReturnValue((SMOKE_PIN.timestamp + 60) * 1000);
    f.rpc[`${f.vault}:totalAssets()`] = 35313917080660n;
    f.rpc["_totalAssets()"] = 35313828326103n;
    f.rpc["lastUpdate()"] = 1791996851n;
    f.rpc["maxRate()"] = 2204656901n;
    f.rpc[`${LOAN}:${data("balanceOf(address)", f.vault.slice(2).padStart(64, "0"))}`] = 135557964n;
    const { result } = await observe(f);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected exact pinned capped book");
    expect(result.deployments[0]).toMatchObject({
      totalAssetsRaw: "35313917080660", realAssetsRaw: "35320724763403", undistributedAssetsRaw: "6807682743",
      idleAssetsRaw: "135557964", reconciledAssetsRaw: "35320724763403", reconciliationResidualRaw: "0",
    });
    expect(result.deployments[0].markets.map(row => row.includedAssetsRaw).sort())
      .toEqual(rows.map(row => row.assets.toString()).sort());
    expect(LenderBookObservationSchema.safeParse(result).success).toBe(true);
    f.rpc[`${f.vault}:totalAssets()`] = 35313917080661n;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "unreconciled" });
    f.rpc[`${f.vault}:totalAssets()`] = 35320724763404n;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "unreconciled" });
    f.rpc[`${f.vault}:totalAssets()`] = 35313917080660n;
    f.rpc[`${ADAPTER}:realAssets()`] = 35320589205440n;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "unreconciled" });
  });
});

describe("MetaMorpho source-defined integer accrual", () => {
  it("excludes synthetic donated wallet cash while preserving a real pinned accrued claim", async () => {
    // Actual bbqusdc tuple/position/rate at block 26192161. The one-market
    // projection injects 4,601 raw USDC of synthetic donated cash (not that
    // block's wallet balance) to isolate wallet cash from the queue NAV.
    const params = packed([LOAN, "0xecfafdc7741323a945a163ed068b5a3c43483957",
      "0x217d6ddcdb95112c51657f6270e8c079cfdb51f0", IRM, 915000000000000000n]);
    const row = { params, id: keccak256(params), assets: 3150377586784n,
      state: packed([128001982152857n, 124843925244899297170n, 114707618852120n, 111549710444795364723n, 1791997967n, 0n]),
      position: packed([3072651498462326435n, 0n, 0n]) };
    const f = fixture([row], "bbqusdc-steakhouse", "meta");
    f.spec.block = SMOKE_PIN;
    vi.spyOn(Date, "now").mockReturnValue((SMOKE_PIN.timestamp + 60) * 1000);
    f.rpc["balanceOf(address)"] = 4601n;
    f.rpc["borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))"] = 2561732276n;
    const { result } = await observe(f);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected donation-excluded book");
    expect(result.deployments[0]).toMatchObject({ totalAssetsRaw: "3150377586784",
      idleAssetsRaw: "0", reconciledAssetsRaw: "3150377586784", reconciliationResidualRaw: "0" });
    f.rpc["balanceOf(address)"] = null;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "incomplete-census" });
  });
  it("uses the pinned borrowRateView and fee shares through the real mocked RPC path", async () => {
    const feeShares = 2_103_333n * 200_000_001_000_000n / 208_413_334n;
    const expected = 100_000_000_000_000n * 210_516_667n / (200_000_000_000_000n + feeShares + 1_000_000n);
    const row = market(expected, 1, {
      state: packed([200_000_000n, 200_000_000_000_000n, 100_000_000n, 100_000_000_000_000n, BigInt(PIN.timestamp - 100), WAD / 5n]),
      position: packed([100_000_000_000_000n, 0n, 0n]),
    });
    const f = fixture([row], "bbqusdc-steakhouse", "meta");
    f.rpc["borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))"] = 1_000_000_000_000_000n;
    const { result, network } = await observe(f);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.deployments[0].markets[0].includedAssetsRaw).toBe(expected.toString());
    expect(network.rpcCalls.some(call => call.contract === IRM && call.selector === toFunctionSelector("borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))"))).toBe(true);
  });
  it("batches eligible IRM probes only after the complete pinned market-state wave", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => market(100n, index + 1, {
      state: packed([100n, 100_000_000n, 50n, 50_000_000n, BigInt(PIN.timestamp - 100), 0n]),
    }));
    const f = fixture(rows, "bbqusdc-steakhouse", "meta");
    const network = installAdapterNetwork(f.spec);
    const ioLimiter = createAdapterIoLimiter();
    const io = vi.spyOn(ioLimiter, "run");
    const result = await observeMorphoLenderBook(f.coin, f.config, new AbortController().signal, {
      chainRpcs: network.chainRpcs, requestCache: new Map(), ioLimiter,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.deployments[0].markets).toHaveLength(8);
      expect(result.deployments[0].reconciliationResidualRaw).toBe("0");
    }
    expect(io.mock.calls.filter(([label]) => label === "lender-book-batch:ethereum")).toHaveLength(5);
    const rateSelector = toFunctionSelector("borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))");
    const rates = network.rpcCalls.filter(call => call.selector === rateSelector);
    expect(rates).toHaveLength(8);
    const firstRate = network.rpcCalls.findIndex(call => call.selector === rateSelector);
    expect(network.rpcCalls.slice(0, firstRate).filter(call => call.selector === toFunctionSelector("market(bytes32)"))).toHaveLength(8);
  });
  it("retains virtual assets/shares and floor rounding, including tiny positions", () => {
    expect(accruedMorphoLenderAssets({ supplyAssets: 10n, supplyShares: 10n, borrowAssets: 0n, fee: 0n,
      lastUpdateSec: PIN.timestamp, timestampSec: PIN.timestamp, borrowRate: 0n, positionShares: 1n })).toBe(0n);
    expect(accruedMorphoLenderAssets({ supplyAssets: 100n, supplyShares: 100_000_000n, borrowAssets: 0n, fee: 0n,
      lastUpdateSec: 0, timestampSec: 100, borrowRate: 0n, positionShares: 100_000_000n })).toBe(100n);
  });
  it("reads actual MetaMorpho-owned positions and reconciles the queue union", async () => {
    const f = fixture([market(100n)], "bbqusdc-steakhouse", "meta");
    const { result } = await observe(f);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.deployments[0].markets[0]).toMatchObject({ account: f.vault, adapter: null, accruedMethod: "morpho-blue-expected-balances" });
  });
  it("distinguishes a proven nonborrowable idle market from debt-bearing unsecured supply", async () => {
    const params = packed([LOAN, ZERO, ZERO, ZERO, 0n]);
    const idleRow = market(100n, 1, { params, id: keccak256(params) });
    const idle = await observe(fixture([idleRow], "bbqusdc-steakhouse", "meta"));
    expect(idle.result.status).toBe("ok");
    if (idle.result.status === "ok") expect(idle.result.deployments[0]).toMatchObject({ idleAssetsRaw: "100", markets: [] });
    const debt = { ...idleRow, state: packed([100n, 100_000_000n, 50n, 50_000_000n, BigInt(PIN.timestamp), 0n]) };
    const unsecured = await observe(fixture([debt], "bbqusdc-steakhouse", "meta"));
    expect(unsecured.result.status).toBe("ok");
    if (unsecured.result.status === "ok") expect(unsecured.result.deployments[0].markets[0].collateralMode).toBe("unsecured");
  });
  it("does not substitute zero rate for an unsupported IRM", async () => {
    const row = market(100n, 1, { state: packed([100n, 100_000_000n, 50n, 50_000_000n, BigInt(PIN.timestamp - 100), 0n]) });
    const f = fixture([row], "bbqusdc-steakhouse", "meta");
    f.rpc["borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))"] = null;
    expect((await observe(f)).result).toMatchObject({ status: "unavailable", reason: "unsupported-irm" });
  });
  it("includes only a nested adapter's partial inner ownership with actual virtual-share conversion", async () => {
    const f = fixture([market(100n)], "kpkusdcprime-kpk", "nested");
    f.rpc[`${ADAPTER}:realAssets()`] = 50n;
    f.rpc[`${f.vault}:totalAssets()`] = 50n;
    f.rpc[`${INNER}:balanceOf(address)`] = 500_000n;
    f.rpc[`${INNER}:totalSupply()`] = 1_000_000n;
    f.rpc["DECIMALS_OFFSET()"] = 0n; f.rpc["fee()"] = 0n; f.rpc["lastTotalAssets()"] = 100n;
    f.rpc[`${ADAPTER}:allocation()`] = 50n; f.rpc["previewRedeem(uint256)"] = 50n;
    const { result } = await observe(f);
    // Exact per-claim rounding yields 49 versus adapter's 50, so the book is
    // unavailable rather than assigning a one-unit residual to invented idle.
    expect(result).toMatchObject({ status: "unavailable", reason: "unreconciled" });
    f.rpc[`${INNER}:totalSupply()`] = 999_999n;
    const exact = await observe(f);
    expect(exact.result.status).toBe("ok");
    if (exact.result.status === "ok") expect(exact.result.deployments[0].markets[0]).toMatchObject({ includedAssetsRaw: "50", account: INNER, adapter: ADAPTER });
  });
  it("preserves the nested source's zero-allocation accounting gate despite residual shares", async () => {
    const f = fixture([market(100n)], "kpkusdcprime-kpk", "nested");
    f.rpc[`${ADAPTER}:realAssets()`] = 0n;
    f.rpc[`${INNER}:balanceOf(address)`] = 500_000n;
    f.rpc[`${INNER}:totalSupply()`] = 999_999n;
    f.rpc[`${LOAN}:${data("balanceOf(address)", f.vault.slice(2).padStart(64, "0"))}`] = 100n;
    f.rpc["DECIMALS_OFFSET()"] = 0n; f.rpc["fee()"] = 0n; f.rpc["lastTotalAssets()"] = 100n;
    f.rpc[`${ADAPTER}:allocation()`] = 0n; f.rpc["previewRedeem(uint256)"] = 50n;
    const { result } = await observe(f);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.deployments[0].idleAssetsRaw).toBe("100");
      expect(result.deployments[0].markets[0].includedAssetsRaw).toBe("0");
      expect(result.deployments[0].markets[0].supplySharesRaw).toBe("100000000");
    }
  });
});
