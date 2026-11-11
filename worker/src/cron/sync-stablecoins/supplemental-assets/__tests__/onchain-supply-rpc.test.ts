import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { PUBLIC_RPC_URLS, SUPPLY_RPC_DEFAULTS } from "@shared/lib/chain-rpc-registry";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { buildChainRpcs, type ChainRpcConfig } from "../../../../lib/chain-registry";
import { fetchCuratedAggregateOnChainMcap, fetchOnChainMcap, fetchOnChainSupplyPartition } from "../onchain-supply";
import { createDwellirNativeCapability } from "../../../../lib/dwellir-native";
import { DWELLIR_NATIVE_ENDPOINTS } from "@shared/lib/dwellir-native-endpoints";
import { CURATED_ONCHAIN_SUPPLY_EXCLUSIONS } from "../../../../lib/onchain-supply-exclusions";
import { TOTAL_SUPPLY_SELECTOR } from "../../../../lib/evm-selectors";
import { fetchXrplSupply } from "../xrpl-supply";
import xrplFixture from "./fixtures/ousg-xrpl.json";

const DWELLIR_TEST_KEY = "supply-rpc-test-key";
const ROBINHOOD_DWELLIR = "https://api-robinhood-mainnet-archive.n.dwellir.com";
const REGISTRY_PRIMARY = "https://supply-primary.example";
const REGISTRY_FALLBACK = "https://supply-fallback.example";

function supplyResponse(shares: bigint): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: `0x${(shares * 10n ** 18n).toString(16).padStart(64, "0")}`,
  });
}

function registryEndpoint(url: string): ChainRpcConfig["endpoints"][number] {
  return { url, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" };
}

function keyedChainRpcs(): Map<string, ChainRpcConfig> {
  return buildChainRpcs(undefined, undefined, { dwellirApiKey: DWELLIR_TEST_KEY });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("supplemental on-chain supply RPC routing", () => {
  it.each(["admitted", "disabled", "unadmitted"] as const)("uses %s EVM routing for a partition leg", async (admission) => {
    const chainRpcs = buildChainRpcs(undefined, undefined, admission === "unadmitted" ? undefined : {
      dwellirApiKey: DWELLIR_TEST_KEY,
      dwellirRoutingDisabledChains: admission === "disabled" ? new Set(["ethereum"]) : undefined,
    });
    const ethereum = chainRpcs.get("ethereum")!;
    const expectedUrl = admission === "admitted"
      ? ethereum.endpoints.find((endpoint) => endpoint.operator === "dwellir")!.url
      : ethereum.endpoints.find((endpoint) => endpoint.operator !== "dwellir")!.url;
    const fetchMock = vi.fn(async () => supplyResponse(100n));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOnChainSupplyPartition(TRACKED_META_BY_ID.get("aa-falconx-mev-capital")!,
      100, 1, undefined, chainRpcs)).resolves.toMatchObject({ chainPartition: { admission: "entered" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([expectedUrl, expect.anything()]);
  });

  it.each(["admitted", "disabled", "unadmitted"] as const)("uses %s native routing for a partition leg", async (admission) => {
    const meta: StablecoinMeta = {
      ...TRACKED_META_BY_ID.get("aa-falconx-mev-capital")!, id: "native-partition-fixture",
      contracts: [{ chain: "starknet", address: "0x1", decimals: 18 }],
    };
    const dwellirNative = admission === "unadmitted" ? undefined : createDwellirNativeCapability(
      DWELLIR_TEST_KEY, admission === "disabled" ? new Set(["starknet"]) : undefined,
    );
    const fetchMock = vi.fn(async () => Response.json({
      jsonrpc: "2.0", id: 1, result: [`0x${(100n * 10n ** 18n).toString(16)}`, "0x0"],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOnChainSupplyPartition(meta, 100, 1, undefined, undefined, undefined, dwellirNative))
      .resolves.toMatchObject({ chainPartition: { admission: "entered" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      admission === "admitted" ? DWELLIR_NATIVE_ENDPOINTS.find((endpoint) => endpoint.network === "starknet")!.baseUrl
        : "https://starknet-rpc.publicnode.com",
      expect.anything(),
    ]);
  });

  it("routes CDP through the reviewed latest-only Flare supply endpoint", async () => {
    const fetchMock = vi.fn(async () => supplyResponse(100n));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCuratedAggregateOnChainMcap(TRACKED_META_BY_ID.get("cdp-enosys")!, 1.25, keyedChainRpcs()))
      .resolves.toMatchObject({
        mcap: 125,
        supplySource: "onchain-total-supply",
        chainCirculating: { Flare: { current: 125, chainId: "flare" } },
      });
    expect(SUPPLY_RPC_DEFAULTS).toHaveProperty("flare.rpcUrl", "https://flare-api.flare.network/ext/C/rpc");
    expect(PUBLIC_RPC_URLS.flare).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://flare-api.flare.network/ext/C/rpc",
      expect.objectContaining({
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: "0x6cd3a5ba46fa254d4d2e3c2b37350ae337e94a0f", data: TOTAL_SUPPLY_SELECTOR }, "latest"],
        }),
      }),
    ]);
  });

  it("keeps every joined supply/exclusion RPC on one requireCanonical hash through inventory movement", async () => {
    const meta = TRACKED_META_BY_ID.get("usg-tangent")!;
    const holders = CURATED_ONCHAIN_SUPPLY_EXCLUSIONS[meta.id].holderAddresses;
    const hash = `0x${"1".repeat(64)}`;
    const observedAt = Math.floor(Date.now() / 1000) - 30;
    const calls: { method: string; params: unknown[] }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request);
      let result: unknown;
      if (request.method === "eth_blockNumber") result = "0x7b";
      else if (request.method === "eth_getBlockByNumber") result = {
        number: "0x7b", hash, timestamp: `0x${observedAt.toString(16)}`,
      };
      else if (request.method === "eth_call") {
        const [call, pin] = request.params;
        const pinned = pin?.blockHash === hash && pin?.requireCanonical === true;
        // At the pin holder A has 100 and B has zero. Sequential latest
        // reads would see the same 100 after it moves from A to B.
        const units = call.data === TOTAL_SUPPLY_SELECTOR ? 1000n
          : pinned && !call.data.toLowerCase().endsWith(holders[0].slice(2).toLowerCase()) ? 0n : 100n;
        result = `0x${(units * 10n ** 18n).toString(16).padStart(64, "0")}`;
      } else throw new Error(`unexpected supply RPC method ${request.method}`);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    }));
    const result = await fetchOnChainMcap(meta, 1, keyedChainRpcs());
    expect(result).toMatchObject({ mcap: 900, observedAt });
    const stateReads = calls.filter((call) => call.method === "eth_call");
    expect(stateReads).toHaveLength(1 + holders.length);
    for (const call of stateReads) expect(call.params[1]).toEqual({ blockHash: hash, requireCanonical: true });
  });

  it("admits a supply row from a keyed supplemental-only chain", async () => {
    const chainRpcs = keyedChainRpcs();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== ROBINHOOD_DWELLIR || new Headers(init?.headers).get("X-Api-Key") !== DWELLIR_TEST_KEY) {
        return new Response("RPC authentication required", { status: 401 });
      }
      return supplyResponse(100n);
    }));

    await expect(fetchOnChainMcap(TRACKED_META_BY_ID.get("steakusdg-steakhouse")!, 1.25, chainRpcs))
      .resolves.toMatchObject({
        mcap: 125,
        supplySource: "onchain-total-supply",
        chain: "robinhood",
        chainCirculating: { "Robinhood Chain": { current: 125, chainId: "robinhood" } },
      });
  });

  it.each([false, true])("keeps registry prices ahead of supplemental RPCs (primary unavailable: %s)", async (primaryUnavailable) => {
    const chainRpcs = keyedChainRpcs();
    const ethereum = chainRpcs.get("ethereum")!;
    ethereum.endpoints = [
      registryEndpoint(REGISTRY_PRIMARY),
      registryEndpoint(REGISTRY_FALLBACK),
      ...ethereum.endpoints.filter((endpoint) => endpoint.position === "supplemental"),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === REGISTRY_PRIMARY && primaryUnavailable) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      }
      return supplyResponse(url === REGISTRY_PRIMARY ? 100n : url === REGISTRY_FALLBACK ? 200n : 999n);
    }));
    const meta: StablecoinMeta = {
      ...TRACKED_META_BY_ID.get("steakusdg-steakhouse")!,
      contracts: [{ chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 }],
    };

    await expect(fetchOnChainMcap(meta, 1.25, chainRpcs)).resolves.toMatchObject({
      mcap: primaryUnavailable ? 250 : 125,
      chain: "ethereum",
    });
  });

  it("preserves the reviewed curated supply pin ahead of unrelated registry endpoints", async () => {
    const chainRpcs = keyedChainRpcs();
    const hyperevm = chainRpcs.get("hyperevm")!;
    hyperevm.endpoints = [registryEndpoint(REGISTRY_PRIMARY), ...hyperevm.endpoints];
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      supplyResponse(url === "https://rpc.hyperliquid.xyz/evm" ? 300n : 999n),
    ));

    await expect(fetchCuratedAggregateOnChainMcap(TRACKED_META_BY_ID.get("hbusdt-hyperbeat")!, 1.25, chainRpcs))
      .resolves.toMatchObject({
        mcap: 375,
        chainCirculating: { HyperEVM: { current: 375, chainId: "hyperevm" } },
      });
  });
});

describe("XRPL issued-currency supply", () => {
  const { gateway: gatewayFixture, ledger: ledgerFixture, source, hotwallet } = xrplFixture;
  const gatewayWith = (patch: object) => ({ result: { ...gatewayFixture.result, ...patch } });
  const ledgerWith = (patch: object) => ({ result: { ...ledgerFixture.result, ...patch } });
  const xrplRpc = SUPPLY_RPC_DEFAULTS.xrpl;
  const meta = TRACKED_META_BY_ID.get("ousg-ondo-finance")!;
  const contract = meta.contracts!.find(entry => entry.chain === "xrpl")!;
  const currency = contract.address.split(".")[0];
  const observedAt = Date.parse(xrplFixture.ledgerClosedAt) / 1000;
  const read = (signal = new AbortController().signal) => fetchXrplSupply(
    contract.address, signal, source, source, hotwallet,
  );
  const fixtureFetcher = (gateway: unknown = gatewayFixture, ledger: unknown = ledgerFixture) =>
    vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json(JSON.parse(String(init?.body)).method === "ledger" ? ledger : gateway));
  const setClock = (age = 10) => { vi.useFakeTimers(); vi.setSystemTime((observedAt + age) * 1000); };

  beforeEach(() => setClock());

  it("reads captured obligations without a fixed scale and pins the validated close clock", async () => {
    const fetchMock = fixtureFetcher(); vi.stubGlobal("fetch", fetchMock);
    expect(await read()).toEqual({ supply: 1584220.172977231, observedAt });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      [source, { method: "gateway_balances", params: [{
        account: gatewayFixture.result.account, strict: true, ledger_index: "validated", hotwallet,
      }] }],
      [source, { method: "ledger", params: [{
        ledger_hash: gatewayFixture.result.ledger_hash, transactions: false, expand: false,
      }] }],
    ]);
    const single = { ...meta, id: "xrpl-supply-fixture", contracts: [contract] };
    expect(await fetchOnChainMcap(single, 117.14)).toMatchObject({
      mcap: 1584220.172977231 * 117.14, observedAt, chain: "xrpl",
      chainCirculating: { "XRP Ledger": { current: 1584220.172977231 * 117.14, chainId: "xrpl" } },
    });
  });

  it("preserves explicit zero, scientific notation and both freshness boundaries", async () => {
    for (const value of ["0", "1584220172977231e-9"]) {
      for (const age of [600, -60, 601, -61]) {
        setClock(age);
        const gateway = structuredClone(gatewayFixture);
        gateway.result.obligations = { ...gateway.result.obligations, [currency]: value };
        vi.stubGlobal("fetch", fixtureFetcher(gateway));
        if (age === 601 || age === -61) await expect(read()).rejects.toThrow("xrpl-ledger-stale-or-future");
        else expect(await read()).toEqual({ supply: Number(value), observedAt });
      }
    }
  });

  it("sums the full OUSG perimeter and partitions an admitted cap only after every leg succeeds", async () => {
    let xrplAvailable = true;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "gateway_balances") return Response.json(xrplAvailable
        ? gatewayFixture : { result: { status: "error", error: "actNotFound" } });
      if (request.method === "ledger") return Response.json(ledgerFixture);
      if (request.method === "getTokenSupply") return Response.json({ jsonrpc: "2.0", id: 1,
        result: { context: { slot: 465436215 }, value: { amount: "0", decimals: 6, uiAmount: 0 } },
      });
      const raw = request.params[0].to.toLowerCase() === meta.contracts!.find(entry => entry.chain === "ethereum")!.address
        ? 1121340573244524372905069n : 0n;
      return Response.json({ jsonrpc: "2.0", id: 1, result: `0x${raw.toString(16).padStart(64, "0")}` });
    });
    vi.stubGlobal("fetch", fetchMock);
    const price = 117.14;
    const total = (1121340.5732445243 + 1584220.172977231) * price;
    const aggregate = await fetchCuratedAggregateOnChainMcap(meta, price, keyedChainRpcs());
    expect(aggregate).toMatchObject({
      observedAt,
      chainCirculating: {
        Ethereum: { chainId: "ethereum" },
        Polygon: { current: 0, chainId: "polygon" }, Solana: { current: 0, chainId: "solana" },
        "XRP Ledger": { current: 1584220.172977231 * price, chainId: "xrpl" },
      },
    });
    expect(aggregate!.mcap).toBeCloseTo(total, 6);
    expect(aggregate!.chainCirculating!.Ethereum.current).toBeCloseTo(1121340.5732445243 * price, 6);
    const partition = await fetchOnChainSupplyPartition(meta, total * 1.05, price, undefined, keyedChainRpcs());
    expect(partition).toMatchObject({ chainPartition: { admission: "entered", observedAt } });
    if (!("chainCirculating" in partition)) throw new Error("expected a complete OUSG partition");
    expect(Object.values(partition.chainCirculating!).reduce((sum, row) => {
      if (typeof row.current !== "number") throw new Error("expected observed numeric chain stock");
      return sum + row.current;
    }, 0)).toBeCloseTo(total * 1.05, 6);
    xrplAvailable = false;
    expect(await fetchCuratedAggregateOnChainMcap(meta, price, keyedChainRpcs())).toBeNull();
    expect(await fetchOnChainSupplyPartition(meta, total, price, undefined, keyedChainRpcs()))
      .toEqual({ reason: "partition-invalid", ratio: null });
  });

  it("withholds malformed, unvalidated or mismatched gateway and ledger evidence", async () => {
    const badGateways = [
      null, {}, gatewayWith({ validated: false }),
      gatewayWith({ validated: undefined }),
      gatewayWith({ account: "wrong-issuer" }),
      gatewayWith({ obligations: { USD: "1" } }),
      gatewayWith({ obligations: undefined }),
      gatewayWith({ status: "error", error: "actNotFound" }),
      ...["-1", "invalid", "1e1000", "1.1234567890123456"].map(value => gatewayWith({ obligations: { [currency]: value } })),
      ...["0", "1"].flatMap(value => [
        gatewayWith({ locked: { [currency]: value } }),
        gatewayWith({ frozen_balances: { holder: [{ currency, value }] } }),
      ]),
    ];
    for (const gateway of badGateways) {
      const fetchMock = fixtureFetcher(gateway); vi.stubGlobal("fetch", fetchMock);
      await expect(read()).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    const { result } = ledgerFixture;
    for (const ledger of [
      ledgerWith({ validated: false }), ledgerWith({ validated: undefined }),
      ledgerWith({ ledger_hash: "A".repeat(64) }),
      ledgerWith({ ledger_index: result.ledger_index + 1 }),
      ...[{ closed: false }, { close_time: undefined }, { close_time: 0 }, { close_flags: 1 },
        { ledger_hash: "A".repeat(64) }, { ledger_index: "1" }].map(patch => ledgerWith({ ledger: { ...result.ledger, ...patch } })),
    ]) {
      vi.stubGlobal("fetch", fixtureFetcher(gatewayFixture, ledger));
      await expect(read()).rejects.toThrow();
    }
  });

  it("bounds both response bodies and rejects RPC/HTTP errors before fallback", async () => {
    for (const method of ["gateway_balances", "ledger"]) {
      const body = method === "ledger" ? ledgerFixture : gatewayFixture;
      for (const makeResponse of [
        () => Response.json({ ...body, padding: "x".repeat(64 * 1024) }),
        () => Response.json(body, { headers: { "Content-Length": String(64 * 1024 + 1) } }),
        () => new Response("{"),
        () => Response.json({ result: { status: "error", error: "lgrNotFound" } }),
        () => new Response("unavailable", { status: 503 }),
      ]) {
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
          JSON.parse(String(init?.body)).method === method ? makeResponse() : Response.json(gatewayFixture)));
        await expect(read()).rejects.toThrow();
      }
    }
  });

  it("restarts on the validation-capable fallback after draining primary quota or ledger failures", async () => {
    let failedBody: Response | undefined;
    let failureMethod = "gateway_balances";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const { method } = JSON.parse(String(init?.body));
      if (url === xrplRpc.rpcUrl && method === failureMethod) {
        failedBody = Response.json({ result: { status: "error", error: "slowDown", error_code: 10 } });
        return failedBody;
      }
      if (url !== xrplRpc.rpcUrl) {
        expect(url).toBe("https://rpc.ankr.com/xrp_mainnet");
        expect(failedBody?.bodyUsed).toBe(true);
      }
      return Response.json(method === "ledger" ? ledgerFixture : gatewayFixture);
    });
    vi.stubGlobal("fetch", fetchMock);
    for (failureMethod of ["gateway_balances", "ledger"]) {
      fetchMock.mockClear();
      failedBody = undefined;
      expect(await fetchXrplSupply(contract.address, new AbortController().signal, undefined, undefined, hotwallet))
        .toEqual({ supply: 1584220.172977231, observedAt });
      expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body)).method])).toEqual([
        [xrplRpc.rpcUrl, "gateway_balances"],
        ...(failureMethod === "ledger" ? [[xrplRpc.rpcUrl, "ledger"]] : []),
        [xrplRpc.fallbackRpcUrl, "gateway_balances"], [xrplRpc.fallbackRpcUrl, "ledger"],
      ]);
    }
    fetchMock.mockImplementation(async (url: string) => url === xrplRpc.rpcUrl
      ? Response.json(gatewayWith({ validated: false }))
      : new Response("unavailable", { status: 503 }));
    expect(await fetchOnChainSupplyPartition({ ...meta, id: "xrpl-supply-fixture", contracts: [contract] },
      1, 1, undefined)).toEqual({ reason: "partition-invalid", ratio: null });
  });

  it("cancels stalled bodies and does not start a pre-cancelled read", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    vi.stubGlobal("fetch", fetchMock);
    const rejected = expect(read()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001); await rejected;
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    const count = fetchMock.mock.calls.length;
    await expect(read(controller.signal)).rejects.toThrow("cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });
});
