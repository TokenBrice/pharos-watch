import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { RESOLVE_MAX_CONTRACTS } from "@shared/lib/api-endpoints/queries";
import {
  normalizeAddressForChainlessLookup,
  normalizeDeploymentAddress,
  parseContractTuple,
  resolveDeploymentChainId,
} from "@shared/lib/deployment-resolver";
import {
  WORKER_TRACKED_STABLECOINS,
  type WorkerRuntimeStablecoinMeta,
} from "@shared/lib/stablecoins/worker-runtime-registry";
import { CHAIN_META } from "@shared/types/chain-identity";
import type {
  ResolveAddressResponse,
  ResolveBatchResponse,
  ResolveBatchResultItem,
  ResolveCoinIdentity,
  ResolveCoinResponse,
  ResolveDeployment,
  ResolveLinks,
  ResolveSingleDeploymentResponse,
} from "@shared/types/resolve";
import { jsonResponse } from "../lib/api-response";

interface DeploymentEntry {
  coin: ResolveCoinIdentity;
  deployment: ResolveDeployment;
  links: ResolveLinks;
}

interface CoinRecord {
  coin: ResolveCoinIdentity;
  deployments: ResolveDeployment[];
  links: ResolveLinks;
}

interface ResolverIndex {
  byChainAndAddress: Map<string, DeploymentEntry>;
  byAddress: Map<string, DeploymentEntry[]>;
  byId: Map<string, CoinRecord>;
  byGeckoId: Map<string, CoinRecord>;
}

let cachedIndex: ResolverIndex | null = null;

function buildCoinIdentity(meta: WorkerRuntimeStablecoinMeta): ResolveCoinIdentity {
  return {
    id: meta.id,
    symbol: meta.symbol,
    name: meta.name,
    geckoId: meta.geckoId ?? null,
    status: meta.status ?? "active",
    pegCurrency: meta.pegCurrency,
    governance: meta.governance,
    navToken: meta.flags.navToken === true,
  };
}

function buildLinks(id: string): ResolveLinks {
  return {
    compliance: API_PATHS.complianceCoin(id),
    riskCheck: API_PATHS.riskCheck({ ids: [id] }),
    detail: API_PATHS.stablecoinDetail(id),
    summary: API_PATHS.stablecoinSummary(id),
  };
}

function buildDeployment(
  rawChain: string,
  rawAddress: string,
  decimals: number | null | undefined,
  role: "canonical" | "traded",
): ResolveDeployment {
  const canonicalChain = resolveDeploymentChainId(rawChain) ?? rawChain.trim().toLowerCase();
  const chainMeta = CHAIN_META[canonicalChain];
  return {
    chain: canonicalChain,
    chainName: chainMeta?.name ?? canonicalChain,
    evmChainId: chainMeta?.evmChainId ?? null,
    address: rawAddress,
    normalizedAddress: normalizeDeploymentAddress(canonicalChain, rawAddress),
    decimals: typeof decimals === "number" ? decimals : null,
    role,
  };
}

function getResolverIndex(): ResolverIndex {
  if (cachedIndex) return cachedIndex;

  const byChainAndAddress = new Map<string, DeploymentEntry>();
  const byAddress = new Map<string, DeploymentEntry[]>();
  const byId = new Map<string, CoinRecord>();
  const byGeckoId = new Map<string, CoinRecord>();

  for (const meta of WORKER_TRACKED_STABLECOINS) {
    const coin = buildCoinIdentity(meta);
    const links = buildLinks(meta.id);
    const deployments: ResolveDeployment[] = [];

    const addDeployment = (rawChain: string, rawAddress: string, decimals: number | null | undefined, role: "canonical" | "traded") => {
      const deployment = buildDeployment(rawChain, rawAddress, decimals, role);
      deployments.push(deployment);
      const entry: DeploymentEntry = { coin, deployment, links };
      const compositeKey = `${deployment.chain}:${deployment.normalizedAddress}`;
      if (!byChainAndAddress.has(compositeKey)) {
        byChainAndAddress.set(compositeKey, entry);
      }
      const existing = byAddress.get(deployment.normalizedAddress);
      if (existing) {
        existing.push(entry);
      } else {
        byAddress.set(deployment.normalizedAddress, [entry]);
      }
    };

    for (const contract of meta.contracts ?? []) {
      addDeployment(contract.chain, contract.address, contract.decimals, "canonical");
    }
    for (const contract of meta.tradedContracts ?? []) {
      addDeployment(contract.chain, contract.address, contract.decimals, "traded");
    }

    const record: CoinRecord = { coin, deployments, links };
    byId.set(meta.id, record);
    if (meta.geckoId) {
      byGeckoId.set(meta.geckoId.toLowerCase(), record);
    }
  }

  cachedIndex = { byChainAndAddress, byAddress, byId, byGeckoId };
  return cachedIndex;
}

export type ContractDeploymentResolution =
  | { ok: true; canonicalChain: string; normalizedAddress: string; entry: DeploymentEntry }
  | { ok: false; reason: "unknown-chain" | "deployment-not-found"; canonicalChain: string | null; normalizedAddress: string | null };

export function resolveContractDeployment(rawChain: string, rawAddress: string): ContractDeploymentResolution {
  const canonicalChain = resolveDeploymentChainId(rawChain);
  if (!canonicalChain) {
    return { ok: false, reason: "unknown-chain", canonicalChain: null, normalizedAddress: null };
  }
  const normalizedAddress = normalizeDeploymentAddress(canonicalChain, rawAddress);
  if (!normalizedAddress) {
    return { ok: false, reason: "deployment-not-found", canonicalChain, normalizedAddress: null };
  }
  const entry = getResolverIndex().byChainAndAddress.get(`${canonicalChain}:${normalizedAddress}`);
  if (!entry) {
    return { ok: false, reason: "deployment-not-found", canonicalChain, normalizedAddress };
  }
  return { ok: true, canonicalChain, normalizedAddress, entry };
}

function invalidQueryResponse(error: string, reason = "invalid-query", extra?: Record<string, unknown>): Response {
  return jsonResponse({ error, reason, ...(extra ?? {}) }, { status: 400 });
}

export async function handleResolve(url: URL): Promise<Response> {
  const chain = url.searchParams.get("chain")?.trim() || null;
  const address = url.searchParams.get("address")?.trim() || null;
  const id = url.searchParams.get("id")?.trim() || null;
  const geckoId = url.searchParams.get("geckoId")?.trim() || null;
  const contractsParam = url.searchParams.get("contracts");
  const hasContracts = contractsParam !== null;

  const modesUsed = [
    chain !== null || address !== null,
    id !== null,
    geckoId !== null,
    hasContracts,
  ].filter(Boolean).length;

  if (modesUsed === 0) {
    return invalidQueryResponse(
      "Specify one query mode: chain+address, address, id, geckoId, or contracts",
      "missing-query",
    );
  }
  if (modesUsed > 1) {
    return invalidQueryResponse(
      "Query modes are mutually exclusive: combine only chain with address, or pass id, geckoId, or contracts alone",
      "conflicting-query",
    );
  }

  const headers = { "Cache-Control": CACHE_PROFILES.slow };

  if (chain !== null && address === null) {
    return invalidQueryResponse("Parameter chain requires address", "missing-address");
  }

  if (chain !== null && address !== null) {
    const resolved = resolveContractDeployment(chain, address);
    if (!resolved.ok) {
      if (resolved.reason === "unknown-chain") {
        return jsonResponse(
          { error: `Unknown chain: ${chain}`, reason: "unknown-chain", query: { chain, address } },
          { status: 400 },
        );
      }
      return jsonResponse(
        {
          error: "Deployment not found",
          reason: "deployment-not-found",
          query: { chain: resolved.canonicalChain, address, normalizedAddress: resolved.normalizedAddress },
        },
        { status: 404 },
      );
    }
    const body: ResolveSingleDeploymentResponse = {
      mode: "deployment",
      matched: true,
      query: {
        chain: resolved.canonicalChain,
        address,
        normalizedAddress: resolved.normalizedAddress,
      },
      coin: resolved.entry.coin,
      deployment: resolved.entry.deployment,
      links: resolved.entry.links,
    };
    return jsonResponse(body, { headers });
  }

  if (address !== null) {
    const index = getResolverIndex();
    const candidates = normalizeAddressForChainlessLookup(address);
    const seen = new Set<string>();
    const matches: DeploymentEntry[] = [];
    for (const candidate of candidates) {
      for (const entry of index.byAddress.get(candidate) ?? []) {
        const dedupKey = `${entry.coin.id}:${entry.deployment.chain}:${entry.deployment.normalizedAddress}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        matches.push(entry);
      }
    }
    if (matches.length === 0) {
      return jsonResponse(
        { error: "Address not found", reason: "address-not-found", query: { address } },
        { status: 404 },
      );
    }
    const distinctCoins = new Set(matches.map((entry) => entry.coin.id));
    const body: ResolveAddressResponse = {
      mode: "address",
      query: { address },
      matchCount: matches.length,
      ambiguousCoin: distinctCoins.size > 1,
      matches: matches.map((entry) => ({
        coin: entry.coin,
        deployment: entry.deployment,
        links: entry.links,
      })),
    };
    return jsonResponse(body, { headers });
  }

  if (id !== null || geckoId !== null) {
    const index = getResolverIndex();
    const record = id !== null ? index.byId.get(id) : index.byGeckoId.get(geckoId!.toLowerCase());
    if (!record) {
      return jsonResponse(
        {
          error: id !== null ? `Unknown stablecoin: ${id}` : `Unknown geckoId: ${geckoId}`,
          reason: "coin-not-found",
          query: id !== null ? { id } : { geckoId },
        },
        { status: 404 },
      );
    }
    const body: ResolveCoinResponse = {
      mode: "coin",
      query: id !== null ? { id } : { geckoId: geckoId! },
      coin: record.coin,
      deployments: record.deployments,
      links: record.links,
    };
    return jsonResponse(body, { headers });
  }

  const rawItems = (contractsParam ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (rawItems.length === 0) {
    return invalidQueryResponse("Parameter contracts must contain at least one chain:address entry", "missing-contracts");
  }
  if (rawItems.length > RESOLVE_MAX_CONTRACTS) {
    return invalidQueryResponse(
      `Maximum ${RESOLVE_MAX_CONTRACTS} contracts per request`,
      "too-many-contracts",
      { max: RESOLVE_MAX_CONTRACTS },
    );
  }

  const results: ResolveBatchResultItem[] = [];
  let matchedCount = 0;
  let unresolvedCount = 0;

  for (const input of rawItems) {
    const parsed = parseContractTuple(input);
    if (!parsed) {
      unresolvedCount += 1;
      results.push({
        input,
        chain: null,
        address: null,
        normalizedAddress: null,
        matched: false,
        reason: "invalid-contract",
        coin: null,
        deployment: null,
        links: null,
      });
      continue;
    }
    const resolved = resolveContractDeployment(parsed.rawChain, parsed.rawAddress);
    if (!resolved.ok) {
      unresolvedCount += 1;
      results.push({
        input,
        chain: resolved.canonicalChain,
        address: parsed.rawAddress,
        normalizedAddress: resolved.normalizedAddress,
        matched: false,
        reason: resolved.reason,
        coin: null,
        deployment: null,
        links: null,
      });
      continue;
    }
    matchedCount += 1;
    results.push({
      input,
      chain: resolved.canonicalChain,
      address: parsed.rawAddress,
      normalizedAddress: resolved.normalizedAddress,
      matched: true,
      reason: null,
      coin: resolved.entry.coin,
      deployment: resolved.entry.deployment,
      links: resolved.entry.links,
    });
  }

  const body: ResolveBatchResponse = {
    mode: "batch",
    matchedCount,
    unresolvedCount,
    results,
  };
  return jsonResponse(body, { headers });
}
