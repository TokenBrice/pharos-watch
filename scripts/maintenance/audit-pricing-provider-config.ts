import { isRecord } from "@shared/lib/type-guards";
import {
  BINANCE_MARKETS,
  BITSTAMP_MARKETS,
  COINBASE_PRODUCTS,
  CEX_PROVIDER_AUDIT_CONFIG,
  KRAKEN_MARKETS,
  REDSTONE_PROVIDER_AUDIT_CONFIG,
  REDSTONE_SYMBOL_CONFIG,
} from "@shared/lib/pricing-provider-config";

export interface AuditSection {
  provider: string;
  ok: boolean;
  checked: number;
  missing: string[];
  notes: string[];
}

type FetchLike = typeof fetch;

class HttpFetchError extends Error {
  status: number;
  url: string;

  constructor(url: string, status: number) {
    super(`${url} returned ${status}`);
    this.name = "HttpFetchError";
    this.status = status;
    this.url = url;
  }
}

class NetworkFetchError extends Error {
  url: string;

  constructor(url: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${url} fetch failed: ${message}`);
    this.name = "NetworkFetchError";
    this.url = url;
  }
}

async function fetchJson<T>(url: string, fetchImpl: FetchLike = fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new NetworkFetchError(url, error);
  }
  if (!response.ok) {
    throw new HttpFetchError(url, response.status);
  }
  return response.json() as Promise<T>;
}

function assertArray(value: unknown, provider: string, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${provider} metadata shape drift: expected ${path} to be an array`);
  }
}

export async function auditBinance(fetchImpl: FetchLike = fetch): Promise<AuditSection> {
  let payload: { symbols?: Array<{ symbol?: string; status?: string }> };
  try {
    payload = await fetchJson<{ symbols?: Array<{ symbol?: string; status?: string }> }>(
      CEX_PROVIDER_AUDIT_CONFIG.binance.metadataUrl,
      fetchImpl,
    );
  } catch (error) {
    if (
      error instanceof HttpFetchError &&
      error.url === CEX_PROVIDER_AUDIT_CONFIG.binance.metadataUrl &&
      (error.status === 403 || error.status === 451)
    ) {
      return {
        provider: "binance",
        ok: true,
        checked: BINANCE_MARKETS.length,
        missing: [],
        notes: [`Skipped live metadata audit because Binance returned ${error.status} for this runner region`],
      };
    }
    throw error;
  }
  assertArray(payload.symbols, "binance", "symbols");

  const tradablePairs = new Set(
    (payload.symbols ?? [])
      .filter((entry) => entry.symbol && (entry.status == null || entry.status === "TRADING"))
      .map((entry) => entry.symbol as string),
  );
  const missing = BINANCE_MARKETS.filter((market) => !tradablePairs.has(market.pair)).map((market) => market.pair);
  return {
    provider: "binance",
    ok: missing.length === 0,
    checked: BINANCE_MARKETS.length,
    missing,
    notes: [],
  };
}

export async function auditKraken(fetchImpl: FetchLike = fetch): Promise<AuditSection> {
  const requestedPairs = KRAKEN_MARKETS.map((market) => market.requestPair);
  const payload = await fetchJson<{
    error?: string[];
    result?: Record<string, { altname?: string; wsname?: string; status?: string }>;
  }>(`${CEX_PROVIDER_AUDIT_CONFIG.kraken.metadataUrl}?pair=${requestedPairs.join(",")}`, fetchImpl);

  if (Array.isArray(payload.error) && payload.error.length > 0) {
    throw new Error(payload.error.join(", "));
  }
  if (!isRecord(payload.result)) {
    throw new Error("kraken metadata shape drift: expected result object");
  }

  const entries = Object.entries(payload.result ?? {});
  const missing = KRAKEN_MARKETS.filter(
    (market) =>
      !entries.some(([key, value]) => {
        const responseKeys = market.responseKeys as readonly string[];
        return (
          responseKeys.includes(key) || value.altname === market.requestPair || value.wsname === `${market.symbol}/USD`
        );
      }),
  ).map((market) => market.requestPair);

  return {
    provider: "kraken",
    ok: missing.length === 0,
    checked: KRAKEN_MARKETS.length,
    missing,
    notes: [],
  };
}

export async function auditBitstamp(fetchImpl: FetchLike = fetch): Promise<AuditSection> {
  let payload: Array<{ name?: string; trading?: string }>;
  try {
    payload = await fetchJson<Array<{ name?: string; trading?: string }>>(
      CEX_PROVIDER_AUDIT_CONFIG.bitstamp.metadataUrl,
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof NetworkFetchError && error.url === CEX_PROVIDER_AUDIT_CONFIG.bitstamp.metadataUrl) {
      return {
        provider: "bitstamp",
        ok: true,
        checked: BITSTAMP_MARKETS.length,
        missing: [],
        notes: [`Skipped live metadata audit because Bitstamp metadata fetch failed from this runner: ${error.message}`],
      };
    }
    throw error;
  }
  assertArray(payload, "bitstamp", "root");
  const activePairs = new Set(
    payload
      .filter((entry) => entry.name && (entry.trading == null || entry.trading === "Enabled"))
      .map((entry) => entry.name as string),
  );
  const missing = BITSTAMP_MARKETS.filter((market) => !activePairs.has(market.pair)).map((market) => market.pair);
  return {
    provider: "bitstamp",
    ok: missing.length === 0,
    checked: BITSTAMP_MARKETS.length,
    missing,
    notes: [],
  };
}

export async function auditCoinbase(fetchImpl: FetchLike = fetch): Promise<AuditSection> {
  const payload = await fetchJson<Array<{ id?: string; status?: string; trading_disabled?: boolean }>>(
    CEX_PROVIDER_AUDIT_CONFIG.coinbase.metadataUrl,
    fetchImpl,
  );
  assertArray(payload, "coinbase", "root");
  const activeProducts = new Set(
    payload
      .filter(
        (entry) =>
          entry.id &&
          entry.trading_disabled !== true &&
          (entry.status == null || entry.status === "online" || entry.status === "internal"),
      )
      .map((entry) => entry.id as string),
  );
  const missing = COINBASE_PRODUCTS.filter((product) => !activeProducts.has(product.productId)).map(
    (product) => product.productId,
  );
  return {
    provider: "coinbase",
    ok: missing.length === 0,
    checked: COINBASE_PRODUCTS.length,
    missing,
    notes: [],
  };
}

export async function auditRedstone(fetchImpl: FetchLike = fetch): Promise<AuditSection> {
  const missing: string[] = [];
  const notes: string[] = [];
  const batchSize = 12;

  for (let i = 0; i < REDSTONE_SYMBOL_CONFIG.length; i += batchSize) {
    const batch = REDSTONE_SYMBOL_CONFIG.slice(i, i + batchSize);
    const symbolsParam = batch.map((config) => config.apiSymbol).join(",");
    const payload = await fetchJson<Record<string, unknown>>(
      `${REDSTONE_PROVIDER_AUDIT_CONFIG.metadataUrl}?symbols=${encodeURIComponent(symbolsParam)}&provider=redstone-primary-prod`,
      fetchImpl,
    );
    if (!isRecord(payload)) {
      throw new Error("redstone metadata shape drift: expected root object");
    }
    for (const config of batch) {
      if (!(config.apiSymbol in payload)) {
        missing.push(config.metaSymbol);
      }
    }
  }

  if (missing.length > 0) {
    notes.push("Missing symbols were absent from the live RedStone snapshot payload");
  }

  return {
    provider: "redstone",
    ok: missing.length === 0,
    checked: REDSTONE_SYMBOL_CONFIG.length,
    missing,
    notes,
  };
}

export async function auditOptionalSourceShapes(
  input: {
    fetchImpl?: FetchLike;
    cmcApiKey?: string;
  } = {},
): Promise<AuditSection[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sections: AuditSection[] = [];

  const jupiterPayload = await fetchJson<Record<string, unknown>>(
    "https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112",
    fetchImpl,
  );
  const jupiterRows = Object.values(jupiterPayload).filter(isRecord);
  sections.push({
    provider: "jupiter-shape",
    ok: jupiterRows.length > 0 && jupiterRows.some((row) => typeof row.usdPrice === "number"),
    checked: 1,
    missing: jupiterRows.some((row) => typeof row.usdPrice === "number") ? [] : ["usdPrice"],
    notes: ["Optional live source-shape check; not part of the default audit:pricing-providers run"],
  });

  if (input.cmcApiKey) {
    const cmcPayload = await fetchJson<unknown>(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/category?id=604f2753ebccdd50cd175fc1&limit=1&convert=USD",
      async (url, init) =>
        fetchImpl(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            "X-CMC_PRO_API_KEY": input.cmcApiKey!,
          },
        }),
    );
    const coins = isRecord(cmcPayload) && isRecord(cmcPayload.data) ? (cmcPayload.data.coins as unknown) : undefined;
    sections.push({
      provider: "coinmarketcap-shape",
      ok: Array.isArray(coins),
      checked: 1,
      missing: Array.isArray(coins) ? [] : ["data.coins"],
      notes: ["Optional live source-shape check; requires CMC_API_KEY"],
    });
  }

  return sections;
}

function printSection(section: AuditSection): void {
  const status = section.ok ? "OK" : "DRIFT";
  console.log(`[pricing-provider-audit] ${section.provider}: ${status} (${section.checked} checked)`);
  if (section.missing.length > 0) {
    console.log(`  missing: ${section.missing.join(", ")}`);
  }
  for (const note of section.notes) {
    console.log(`  note: ${note}`);
  }
}

export async function runPricingProviderAudit(
  options: {
    fetchImpl?: FetchLike;
    liveSourceShapes?: boolean;
    cmcApiKey?: string;
  } = {},
): Promise<AuditSection[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sections: AuditSection[] = [];
  for (const audit of [auditBinance, auditKraken, auditBitstamp, auditCoinbase, auditRedstone]) {
    sections.push(await audit(fetchImpl));
  }
  if (options.liveSourceShapes) {
    sections.push(
      ...(await auditOptionalSourceShapes({
        fetchImpl,
        cmcApiKey: options.cmcApiKey,
      })),
    );
  }

  const failed = sections.filter((section) => !section.ok);
  if (failed.length > 0) {
    throw new Error(`provider config drift detected: ${failed.map((section) => section.provider).join(", ")}`);
  }
  return sections;
}

async function main(): Promise<void> {
  const liveSourceShapes = process.argv.includes("--live-source-shapes");
  const sections = await runPricingProviderAudit({
    liveSourceShapes,
    cmcApiKey: process.env.CMC_API_KEY,
  });
  sections.forEach(printSection);
}

if (process.argv[1]?.endsWith("audit-pricing-provider-config.ts")) {
  main().catch((error) => {
    console.error("[pricing-provider-audit] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
