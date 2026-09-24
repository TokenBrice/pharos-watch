import { describe, expect, it } from "vitest";
import { CHAIN_META } from "@shared/lib/chains";
import {
  DWELLIR_CHAINS,
  buildAlchemyRpcUrl,
  buildChainRpcs,
  dwellirRpcUrl,
  getRpcAuthHeaders,
  hasRegistryRpc,
  logScanRpcEndpoints,
  primaryRpcUrl,
  registerRpcAuth,
  registryRpcEndpoints,
  registryRpcUrls,
  supplementalRpcEndpoints,
} from "../chain-registry";

const ALCHEMY_KEY = "alchemy-test-key";
const DRPC_KEY = "drpc-test-key";
const DWELLIR_KEY = "dwellir-test-key";

/** Today's [rpcUrl, fallbackRpcUrl] lists, captured before the endpoint refactor. */
const KEY_COMBINATIONS = [
  {
    label: "no key",
    alchemyApiKey: undefined,
    drpcApiKey: undefined,
    urls: {
      ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
      base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
      gnosis: ["https://rpc.gnosischain.com"],
      fantom: ["https://fantom.drpc.org"],
      tempo: ["https://rpc.tempo.xyz"],
      monad: ["https://rpc.monad.xyz"],
      solana: [],
      tron: ["https://api.trongrid.io"],
    },
  },
  {
    label: "alchemy only",
    alchemyApiKey: ALCHEMY_KEY,
    drpcApiKey: undefined,
    urls: {
      ethereum: ["https://eth-mainnet.g.alchemy.com/v2/", "https://ethereum-rpc.publicnode.com"],
      base: ["https://base-mainnet.g.alchemy.com/v2/", "https://mainnet.base.org"],
      gnosis: ["https://rpc.gnosischain.com"],
      fantom: ["https://fantom.drpc.org"],
      tempo: ["https://rpc.tempo.xyz"],
      monad: ["https://rpc.monad.xyz"],
      solana: ["https://solana-mainnet.g.alchemy.com/v2/"],
      tron: ["https://tron-mainnet.g.alchemy.com/v2/", "https://api.trongrid.io"],
    },
  },
  {
    label: "drpc only",
    alchemyApiKey: undefined,
    drpcApiKey: DRPC_KEY,
    urls: {
      ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
      base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
      gnosis: [`https://lb.drpc.org/ogrpc?network=gnosis&dkey=${DRPC_KEY}`, "https://rpc.gnosischain.com"],
      fantom: [`https://lb.drpc.org/ogrpc?network=fantom&dkey=${DRPC_KEY}`, "https://fantom.drpc.org"],
      tempo: ["https://rpc.tempo.xyz"],
      monad: ["https://rpc.monad.xyz"],
      solana: [`https://lb.drpc.org/ogrpc?network=solana&dkey=${DRPC_KEY}`],
      tron: ["https://api.trongrid.io"],
    },
  },
  {
    label: "both keys",
    alchemyApiKey: ALCHEMY_KEY,
    drpcApiKey: DRPC_KEY,
    urls: {
      ethereum: ["https://eth-mainnet.g.alchemy.com/v2/", "https://ethereum-rpc.publicnode.com"],
      base: ["https://base-mainnet.g.alchemy.com/v2/", "https://mainnet.base.org"],
      gnosis: [`https://lb.drpc.org/ogrpc?network=gnosis&dkey=${DRPC_KEY}`, "https://rpc.gnosischain.com"],
      fantom: [`https://lb.drpc.org/ogrpc?network=fantom&dkey=${DRPC_KEY}`, "https://fantom.drpc.org"],
      tempo: ["https://rpc.tempo.xyz"],
      monad: ["https://rpc.monad.xyz"],
      solana: ["https://solana-mainnet.g.alchemy.com/v2/", `https://lb.drpc.org/ogrpc?network=solana&dkey=${DRPC_KEY}`],
      tron: ["https://tron-mainnet.g.alchemy.com/v2/", "https://api.trongrid.io"],
    },
  },
] satisfies readonly {
  label: string;
  alchemyApiKey: string | undefined;
  drpcApiKey: string | undefined;
  urls: Record<string, string[]>;
}[];

function dwellirEntry(chainId: string) {
  const entry = DWELLIR_CHAINS.find((candidate) => candidate.chainId === chainId);
  if (!entry) throw new Error(`No DWELLIR_CHAINS entry for ${chainId}`);
  return entry;
}

describe("buildChainRpcs", () => {
  it.each(KEY_COMBINATIONS)(
    "keeps today's registry URL lists with $label",
    ({ alchemyApiKey, drpcApiKey, urls }) => {
      const chainRpcs = buildChainRpcs(alchemyApiKey, drpcApiKey);

      for (const [chainId, expectedUrls] of Object.entries(urls)) {
        expect(registryRpcUrls(chainRpcs.get(chainId)), chainId).toEqual(expectedUrls);
      }
    },
  );

  it("emits no Dwellir endpoint at all without a Dwellir key", () => {
    for (const { alchemyApiKey, drpcApiKey } of KEY_COMBINATIONS) {
      const chainRpcs = buildChainRpcs(alchemyApiKey, drpcApiKey);
      expect(chainRpcs.size).toBeGreaterThan(0);

      for (const config of chainRpcs.values()) {
        expect(config.endpoints.some((endpoint) => endpoint.operator === "dwellir")).toBe(false);
        expect(config.endpoints.some((endpoint) => endpoint.url.includes(".n.dwellir.com"))).toBe(false);
        expect(supplementalRpcEndpoints(config)).toEqual([]);
      }
    }
  });

  it("maps registry operators to alchemy/drpc keyed and public unkeyed", () => {
    const chainRpcs = buildChainRpcs(ALCHEMY_KEY, DRPC_KEY);

    expect(chainRpcs.get("ethereum")!.endpoints).toEqual([
      {
        url: "https://eth-mainnet.g.alchemy.com/v2/",
        operator: "alchemy",
        keyed: true,
        position: "registry",
        stateHistory: "archive",
        logsHistory: "full",
      },
      {
        url: "https://ethereum-rpc.publicnode.com",
        operator: "public",
        keyed: false,
        position: "registry",
        stateHistory: "archive",
        logsHistory: "full",
      },
    ]);
    expect(chainRpcs.get("gnosis")!.endpoints[0]).toMatchObject({ operator: "drpc", keyed: true });
    // The public fantom endpoint is served by dRPC but is keyless, so it stays public/unkeyed.
    expect(buildChainRpcs().get("fantom")!.endpoints[0]).toMatchObject({
      url: "https://fantom.drpc.org",
      operator: "public",
      keyed: false,
    });
  });

  it("appends one supplemental Dwellir endpoint per chain, after every registry endpoint", () => {
    const withKey = buildChainRpcs(ALCHEMY_KEY, DRPC_KEY, { dwellirApiKey: DWELLIR_KEY });
    const withoutKey = buildChainRpcs(ALCHEMY_KEY, DRPC_KEY);

    for (const entry of DWELLIR_CHAINS) {
      const config = withKey.get(entry.chainId);
      expect(config, entry.chainId).toBeDefined();

      const endpoints = config!.endpoints;
      expect(endpoints[endpoints.length - 1], entry.chainId).toMatchObject({
        url: dwellirRpcUrl(entry),
        operator: "dwellir",
        keyed: true,
        position: "supplemental",
        stateHistory: entry.stateHistory,
        logsHistory: entry.logsHistory,
        verifiedAt: entry.verifiedAt,
      });
      expect(
        endpoints.slice(0, -1).some((endpoint) => endpoint.position === "supplemental"),
        entry.chainId,
      ).toBe(false);

      const supplemented = supplementalRpcEndpoints(config);
      expect(supplemented, entry.chainId).toHaveLength(1);
      expect(endpoints.slice(-supplemented.length), entry.chainId).toEqual(supplemented);
    }

    for (const config of withKey.values()) {
      expect(registryRpcUrls(config), config.chainId).toEqual(
        registryRpcUrls(withoutKey.get(config.chainId)),
      );
    }
  });

  it("creates supplemental-only configs for pin-only chains", () => {
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: DWELLIR_KEY });

    for (const chainId of ["hyperevm", "linea", "zksync"]) {
      const config = chainRpcs.get(chainId);
      expect(config, chainId).toBeDefined();
      expect(hasRegistryRpc(config), chainId).toBe(false);
      expect(primaryRpcUrl(config), chainId).toBeUndefined();
      expect(registryRpcUrls(config), chainId).toEqual([]);
      expect(supplementalRpcEndpoints(config), chainId).toHaveLength(1);
      expect(config, chainId).toMatchObject({
        chainName: CHAIN_META[chainId]!.name,
        explorerUrl: CHAIN_META[chainId]!.explorerUrl,
        type: "evm",
      });
    }
  });

  it("keeps Arc public-only with Dwellir appended after its registry operators", () => {
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: DWELLIR_KEY });
    const arc = chainRpcs.get("arc");

    expect(registryRpcUrls(arc)).toEqual(["https://rpc.mainnet.arc.io", "https://arc.drpc.org"]);
    expect(registryRpcEndpoints(arc).every((endpoint) => endpoint.operator === "public")).toBe(true);
    expect(hasRegistryRpc(arc)).toBe(true);
    expect(supplementalRpcEndpoints(arc).map((endpoint) => endpoint.url)).toEqual([
      "https://api-arc-mainnet.n.dwellir.com",
    ]);
  });

  it("pairs every Dwellir entry with the CHAIN_META key and EVM chain id it reads", () => {
    expect(new Set(DWELLIR_CHAINS.map((entry) => entry.chainId)).size).toBe(DWELLIR_CHAINS.length);

    for (const entry of DWELLIR_CHAINS) {
      const meta = CHAIN_META[entry.chainId];
      expect(meta, entry.chainId).toBeDefined();
      expect(meta!.evmChainId, entry.chainId).toBe(entry.evmChainId);
      expect(meta!.type, entry.chainId).toBe("evm");
    }
  });

  it("never puts the Dwellir key in a URL and serves it as an X-Api-Key header", () => {
    const chainRpcs = buildChainRpcs(ALCHEMY_KEY, DRPC_KEY, { dwellirApiKey: DWELLIR_KEY });

    for (const config of chainRpcs.values()) {
      for (const endpoint of config.endpoints) {
        expect(endpoint.url, config.chainId).not.toContain(DWELLIR_KEY);
      }
    }

    const ethereumUrl = dwellirRpcUrl(dwellirEntry("ethereum"));
    expect(getRpcAuthHeaders(ethereumUrl)).toEqual({ "X-Api-Key": DWELLIR_KEY });
    // Auth is keyed by origin, so every path on the Dwellir host resolves it.
    const avalancheUrl = new URL(dwellirRpcUrl(dwellirEntry("avalanche")));
    expect(avalancheUrl.pathname).toBe("/ext/bc/C/rpc");
    expect(getRpcAuthHeaders(`${avalancheUrl.origin}/ext/bc/C/rpc`)).toEqual({ "X-Api-Key": DWELLIR_KEY });
    expect(getRpcAuthHeaders(`${avalancheUrl.origin}/other/path`)).toEqual({ "X-Api-Key": DWELLIR_KEY });
    expect(getRpcAuthHeaders("https://ethereum-rpc.publicnode.com")).toBeUndefined();
  });

  it("rejects a second provider claiming an already-registered origin", () => {
    registerRpcAuth("alchemy", "https://auth-collision.test/v2/", { Authorization: "Bearer first" });
    expect(() =>
      registerRpcAuth("dwellir", "https://auth-collision.test/ext/bc/C/rpc", { "X-Api-Key": "other" }),
    ).toThrow(/already registered for provider alchemy/);

    // The same provider re-registers (key rotation) and keeps its origin.
    registerRpcAuth("alchemy", "https://auth-collision.test/v2/other", { Authorization: "Bearer second" });
    expect(getRpcAuthHeaders("https://auth-collision.test/anything")).toEqual({
      Authorization: "Bearer second",
    });
  });

  it("keeps Dwellir out of log-scan endpoints", () => {
    const chainRpcs = buildChainRpcs(ALCHEMY_KEY, DRPC_KEY, { dwellirApiKey: DWELLIR_KEY });

    for (const config of chainRpcs.values()) {
      expect(
        logScanRpcEndpoints(config).some((endpoint) => endpoint.operator === "dwellir"),
        config.chainId,
      ).toBe(false);
    }

    const ethereum = chainRpcs.get("ethereum")!;
    expect(logScanRpcEndpoints(ethereum).map((endpoint) => endpoint.url)).toEqual(
      registryRpcUrls(ethereum),
    );
    expect(logScanRpcEndpoints(chainRpcs.get("hyperevm"))).toEqual([]);
  });

  it("excludes near-head-only Dwellir endpoints from historical-block reads", () => {
    const chainRpcs = buildChainRpcs(undefined, undefined, { dwellirApiKey: DWELLIR_KEY });

    expect(supplementalRpcEndpoints(chainRpcs.get("bsc")).map((endpoint) => endpoint.stateHistory))
      .toEqual(["recent"]);
    expect(supplementalRpcEndpoints(chainRpcs.get("bsc"), { historicalBlock: true })).toEqual([]);
    expect(supplementalRpcEndpoints(chainRpcs.get("zksync"), { historicalBlock: true })).toEqual([]);
    expect(supplementalRpcEndpoints(chainRpcs.get("zksync"))).toHaveLength(1);
    expect(supplementalRpcEndpoints(chainRpcs.get("ethereum"), { historicalBlock: true }))
      .toEqual(supplementalRpcEndpoints(chainRpcs.get("ethereum")));
    expect(supplementalRpcEndpoints(chainRpcs.get("ethereum"), { historicalBlock: true }))
      .toHaveLength(1);
  });

  it("never clears Dwellir auth when a later build omits the key", () => {
    const ethereumUrl = dwellirRpcUrl(dwellirEntry("ethereum"));
    buildChainRpcs(undefined, undefined, { dwellirApiKey: DWELLIR_KEY });
    expect(getRpcAuthHeaders(ethereumUrl)).toEqual({ "X-Api-Key": DWELLIR_KEY });

    buildChainRpcs(undefined, undefined);
    buildAlchemyRpcUrl("eth-mainnet");

    expect(getRpcAuthHeaders(ethereumUrl)).toEqual({ "X-Api-Key": DWELLIR_KEY });
  });

  it("includes public-only Tempo RPC resolution", () => {
    const tempo = buildChainRpcs().get("tempo");

    expect(tempo).toMatchObject({
      chainId: "tempo",
      chainName: "Tempo",
      type: "evm",
      explorerUrl: "https://explorer.tempo.xyz",
    });
    expect(registryRpcUrls(tempo)).toEqual(["https://rpc.tempo.xyz"]);
    expect(registryRpcEndpoints(tempo).every((endpoint) => endpoint.operator === "public")).toBe(true);
  });

  it.each([
    ["plume", "Plume", "https://rpc.plume.org", "https://explorer.plumenetwork.xyz"],
    ["monad", "Monad", "https://rpc.monad.xyz", "https://explorer.monad.xyz"],
    ["mantle", "Mantle", "https://rpc.mantle.xyz", "https://mantlescan.xyz"],
    ["morph-l2", "Morph", "https://rpc.morphl2.io", "https://explorer.morphl2.io"],
    ["abcore", "AB Core", "https://rpc.core.ab.org", "https://explorer.core.ab.org"],
    ["xlayer", "X Layer", "https://rpc.xlayer.tech", "https://www.oklink.com/xlayer"],
  ])("includes public-only %s RPC resolution for usd1 supply aggregation", (chainId, chainName, rpcUrl, explorerUrl) => {
    const config = buildChainRpcs().get(chainId);

    expect(config).toMatchObject({
      chainId,
      chainName,
      type: "evm",
      explorerUrl,
    });
    expect(registryRpcUrls(config)).toEqual([rpcUrl]);
    expect(primaryRpcUrl(config)).toBe(rpcUrl);
    expect(registryRpcEndpoints(config).every((endpoint) => endpoint.operator === "public")).toBe(true);
  });

  it("uses the public Fantom endpoint without a key and as the keyed fallback", () => {
    expect(primaryRpcUrl(buildChainRpcs().get("fantom"))).toBe("https://fantom.drpc.org");
    expect(registryRpcUrls(buildChainRpcs(undefined, DRPC_KEY).get("fantom"))).toEqual([
      `https://lb.drpc.org/ogrpc?network=fantom&dkey=${DRPC_KEY}`,
      "https://fantom.drpc.org",
    ]);
  });

  it("keeps Alchemy API keys out of RPC URLs and serves them as a bearer header", () => {
    const chainRpcs = buildChainRpcs(ALCHEMY_KEY);
    const ethereum = chainRpcs.get("ethereum")!;

    expect(primaryRpcUrl(ethereum)).toBe("https://eth-mainnet.g.alchemy.com/v2/");
    expect(getRpcAuthHeaders(primaryRpcUrl(ethereum)!)).toEqual({ Authorization: `Bearer ${ALCHEMY_KEY}` });
  });

  it("clears a stale Alchemy bearer when its URL is built without a key", () => {
    const url = buildAlchemyRpcUrl("eth-mainnet", ALCHEMY_KEY);
    expect(getRpcAuthHeaders(url)).toEqual({ Authorization: `Bearer ${ALCHEMY_KEY}` });

    expect(buildAlchemyRpcUrl("eth-mainnet")).toBe(url);
    expect(getRpcAuthHeaders(url)).toBeUndefined();
  });

  it("prepends keyed Solana RPCs in Alchemy then dRPC order", () => {
    const solana = buildChainRpcs(ALCHEMY_KEY, DRPC_KEY).get("solana");

    expect(solana).toMatchObject({
      chainId: "solana",
      chainName: "Solana",
      type: "other",
      explorerUrl: "https://solscan.io",
    });
    expect(registryRpcUrls(solana)).toEqual([
      "https://solana-mainnet.g.alchemy.com/v2/",
      `https://lb.drpc.org/ogrpc?network=solana&dkey=${DRPC_KEY}`,
    ]);
  });

  it("keeps the Alchemy key out of the Solana RPC URL and serves it as an auth header", () => {
    const solana = buildChainRpcs(ALCHEMY_KEY, DRPC_KEY).get("solana");
    const alchemyUrl = primaryRpcUrl(solana)!;

    expect(alchemyUrl).not.toContain(ALCHEMY_KEY);
    expect(getRpcAuthHeaders(alchemyUrl)).toEqual({ Authorization: `Bearer ${ALCHEMY_KEY}` });
  });
});
