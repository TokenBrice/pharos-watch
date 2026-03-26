import {
  BINANCE_MARKETS,
  BITSTAMP_MARKETS,
  COINBASE_PRODUCTS,
  CEX_PROVIDER_AUDIT_CONFIG,
  KRAKEN_MARKETS,
  REDSTONE_PROVIDER_AUDIT_CONFIG,
  REDSTONE_SYMBOL_CONFIG,
} from "../shared/lib/pricing-provider-config";

interface AuditSection {
  provider: string;
  ok: boolean;
  checked: number;
  missing: string[];
  notes: string[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function auditBinance(): Promise<AuditSection> {
  const payload = await fetchJson<{ symbols?: Array<{ symbol?: string; status?: string }> }>(
    CEX_PROVIDER_AUDIT_CONFIG.binance.metadataUrl,
  );
  const tradablePairs = new Set(
    (payload.symbols ?? [])
      .filter((entry) => entry.symbol && (entry.status == null || entry.status === "TRADING"))
      .map((entry) => entry.symbol as string),
  );
  const missing = BINANCE_MARKETS
    .filter((market) => !tradablePairs.has(market.pair))
    .map((market) => market.pair);
  return {
    provider: "binance",
    ok: missing.length === 0,
    checked: BINANCE_MARKETS.length,
    missing,
    notes: [],
  };
}

async function auditKraken(): Promise<AuditSection> {
  const requestedPairs = KRAKEN_MARKETS.map((market) => market.requestPair);
  const payload = await fetchJson<{
    error?: string[];
    result?: Record<string, { altname?: string; wsname?: string; status?: string }>;
  }>(`${CEX_PROVIDER_AUDIT_CONFIG.kraken.metadataUrl}?pair=${requestedPairs.join(",")}`);

  if (Array.isArray(payload.error) && payload.error.length > 0) {
    throw new Error(payload.error.join(", "));
  }

  const entries = Object.entries(payload.result ?? {});
  const missing = KRAKEN_MARKETS
    .filter((market) => !entries.some(([key, value]) => {
      const responseKeys = market.responseKeys as readonly string[];
      return (
      responseKeys.includes(key) ||
      value.altname === market.requestPair ||
      value.wsname === `${market.symbol}/USD`
      );
    }))
    .map((market) => market.requestPair);

  return {
    provider: "kraken",
    ok: missing.length === 0,
    checked: KRAKEN_MARKETS.length,
    missing,
    notes: [],
  };
}

async function auditBitstamp(): Promise<AuditSection> {
  const payload = await fetchJson<Array<{ name?: string; trading?: string }>>(
    CEX_PROVIDER_AUDIT_CONFIG.bitstamp.metadataUrl,
  );
  const activePairs = new Set(
    payload
      .filter((entry) => entry.name && (entry.trading == null || entry.trading === "Enabled"))
      .map((entry) => entry.name as string),
  );
  const missing = BITSTAMP_MARKETS
    .filter((market) => !activePairs.has(market.pair))
    .map((market) => market.pair);
  return {
    provider: "bitstamp",
    ok: missing.length === 0,
    checked: BITSTAMP_MARKETS.length,
    missing,
    notes: [],
  };
}

async function auditCoinbase(): Promise<AuditSection> {
  const payload = await fetchJson<Array<{ id?: string; status?: string; trading_disabled?: boolean }>>(
    CEX_PROVIDER_AUDIT_CONFIG.coinbase.metadataUrl,
  );
  const activeProducts = new Set(
    payload
      .filter((entry) => (
        entry.id &&
        entry.trading_disabled !== true &&
        (entry.status == null || entry.status === "online" || entry.status === "internal")
      ))
      .map((entry) => entry.id as string),
  );
  const missing = COINBASE_PRODUCTS
    .filter((product) => !activeProducts.has(product.productId))
    .map((product) => product.productId);
  return {
    provider: "coinbase",
    ok: missing.length === 0,
    checked: COINBASE_PRODUCTS.length,
    missing,
    notes: [],
  };
}

async function auditRedstone(): Promise<AuditSection> {
  const missing: string[] = [];
  const notes: string[] = [];
  const batchSize = 12;

  for (let i = 0; i < REDSTONE_SYMBOL_CONFIG.length; i += batchSize) {
    const batch = REDSTONE_SYMBOL_CONFIG.slice(i, i + batchSize);
    const symbolsParam = batch.map((config) => config.apiSymbol).join(",");
    const payload = await fetchJson<Record<string, unknown>>(
      `${REDSTONE_PROVIDER_AUDIT_CONFIG.metadataUrl}?symbols=${encodeURIComponent(symbolsParam)}&provider=redstone-primary-prod`,
    );
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

async function main(): Promise<void> {
  const sections = await Promise.all([
    auditBinance(),
    auditKraken(),
    auditBitstamp(),
    auditCoinbase(),
    auditRedstone(),
  ]);

  sections.forEach(printSection);

  const failed = sections.filter((section) => !section.ok);
  if (failed.length > 0) {
    throw new Error(`provider config drift detected: ${failed.map((section) => section.provider).join(", ")}`);
  }
}

main().catch((error) => {
  console.error("[pricing-provider-audit] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
