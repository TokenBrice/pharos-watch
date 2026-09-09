import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { CANONICAL_ETH_RESERVE_RISK, getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import type { AdapterContext, AdapterResult } from "./types";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  fetchJsonWithRetry,
  fetchTextWithRetry,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  reserveInfoWarning,
  sameRunRenderClockFreshnessMetadata,
  slicesFromPercentages,
  slicesFromValues,
  unverifiedFreshnessMetadata,
} from "./helpers";
import { buildBrowserHeaders, NEUTRAL_ADAPTER_HEADERS } from "./request";
import { requireJsonInput } from "./input-guards";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { extractEscapedJsonValueAfterKey } from "./html";
import { fetchMentoRedemptionMetadata } from "./mento-redemption";

type MentoCdpStablecoin = "GBPm" | "JPYm" | "CHFm";

interface MentoReserveEntry {
  symbol: string;
  percent: number;
}

interface MentoCdpTroveEntry {
  stablecoin: MentoCdpStablecoin;
  collateralToken: string;
  collateralUsd: number;
  debtUsd: number;
  ratio?: number;
}

interface MentoReserveApiAsset {
  symbol?: unknown;
  percentage?: unknown;
}

interface MentoCdpTroveApiEntry {
  stablecoin?: unknown;
  collateral_token?: unknown;
  collateral_usd?: unknown;
  debt_usd?: unknown;
  ratio?: unknown;
  status?: unknown;
}

interface MentoReserveApiResponse {
  collateral?: {
    assets?: MentoReserveApiAsset[];
  };
  cdp_troves?: {
    troves?: MentoCdpTroveApiEntry[];
  };
}

// The Mento dashboard ships its reserve payload as a React Query cache entry
// embedded in the Next.js Flight payload. The reserve-scoped timestamp appears
// near the historical `troves` array or the current `cdp_backings` array and the
// `dataUpdateCount` cache marker. Anchoring on those neighbours rules out the
// many unrelated `"timestamp":"..."` occurrences in the bundle.
const MENTO_DASHBOARD_PAYLOAD_KEYS = ["cdp_backings", "troves"] as const;
const MENTO_DASHBOARD_MAX_ESCAPE_DEPTH = 5;
const MENTO_DASHBOARD_PAYLOAD_WINDOW_CHARS = 64_000;
const MENTO_DASHBOARD_TIMESTAMP_IN_WINDOW_PATTERN =
  /\\{1,5}"timestamp\\{1,5}"\s*:\s*\\{1,5}"([^"\\]+)\\{1,5}"/;
const MENTO_DASHBOARD_DATA_UPDATE_COUNT_IN_WINDOW_PATTERN = /\\{1,5}"dataUpdateCount\\{1,5}"/;
const MENTO_DASHBOARD_DATA_UPDATED_AT_IN_WINDOW_PATTERN = /\\{1,5}"dataUpdatedAt\\{1,5}"\s*:\s*(\d{13,})/;

function hasEscapedQuoteAt(value: string, index: number): boolean {
  let slashCount = 0;
  while (
    slashCount < MENTO_DASHBOARD_MAX_ESCAPE_DEPTH &&
    value[index + slashCount] === "\\"
  ) {
    slashCount += 1;
  }

  return slashCount > 0 && value[index + slashCount] === "\"";
}

function findDashboardPayloadKeyIndex(html: string, key: string): number | null {
  let keyIndex = html.indexOf(key);
  while (keyIndex >= 0) {
    if (hasEscapedQuoteAt(html, keyIndex + key.length)) {
      return keyIndex;
    }
    keyIndex = html.indexOf(key, keyIndex + key.length);
  }

  return null;
}

function extractMentoDashboardPayloadWindow(html: string): string | null {
  for (const key of MENTO_DASHBOARD_PAYLOAD_KEYS) {
    const keyIndex = findDashboardPayloadKeyIndex(html, key);
    if (keyIndex != null) {
      return html.slice(
        keyIndex,
        Math.min(html.length, keyIndex + MENTO_DASHBOARD_PAYLOAD_WINDOW_CHARS),
      );
    }
  }

  return null;
}

interface TokenConfig {
  key: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  stableLike?: boolean;
}

const TOKEN_CONFIG: Record<string, TokenConfig> = {
  sUSDS: {
    key: "sUSDS",
    name: "sUSDS (Sky savings USDS)",
    risk: "low",
    coinId: "susds-sky",
    stableLike: true,
  },
  EURC: {
    key: "EURC",
    name: "EURC (Circle euro stablecoin)",
    risk: "low",
    coinId: "eurc-circle",
    stableLike: true,
  },
  EUROP: {
    key: "EUROP",
    name: "EUROP (Schuman euro stablecoin)",
    risk: "low",
    coinId: "europ-schuman",
    stableLike: true,
  },
  axlEUROC: {
    key: "EURC",
    name: "EURC (Circle euro stablecoin)",
    risk: "low",
    coinId: "eurc-circle",
    stableLike: true,
  },
  CELO: { key: "CELO", name: "CELO", risk: getCanonicalReserveAssetRisk("CELO") ?? "high" },
  USDGLO: {
    key: "USDGLO",
    name: "USDGLO (Glo Dollar)",
    risk: "low",
    coinId: "usdglo-glo",
    stableLike: true,
  },
  stETH: {
    key: "stETH",
    name: "stETH (Lido staked ETH)",
    risk: getCanonicalReserveAssetRisk("stETH") ?? "low",
  },
  USDT: {
    key: "USDT",
    name: "USDT",
    risk: "low",
    coinId: "usdt-tether",
    stableLike: true,
  },
  USDT0: {
    key: "USDT",
    name: "USDT",
    risk: "low",
    coinId: "usdt-tether",
    stableLike: true,
  },
  USDC: {
    key: "USDC",
    name: "USDC",
    risk: "low",
    coinId: "usdc-circle",
    stableLike: true,
  },
  axlUSDC: {
    key: "USDC",
    name: "USDC",
    risk: "low",
    coinId: "usdc-circle",
    stableLike: true,
  },
  AUSD: {
    key: "AUSD",
    name: "AUSD (Agora Dollar)",
    risk: getCanonicalReserveAssetRisk("AUSD") ?? "low",
    coinId: "ausd-agora",
    stableLike: true,
  },
  ETH: { key: "ETH", name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK },
  WETH: { key: "ETH", name: "ETH", risk: CANONICAL_ETH_RESERVE_RISK },
  WBTC: {
    key: "WBTC",
    name: "WBTC",
    risk: getCanonicalReserveAssetRisk("WBTC") ?? "medium",
  },
  USDm: {
    key: "USDm",
    name: "USDm (Mento Dollar)",
    risk: "low",
    coinId: "cusd-celo",
    stableLike: true,
  },
};

// The Mento analytics API and dashboard intermittently return HTTP 404 to
// Cloudflare Worker egress while serving 200 to browser-like clients, so both
// fetches try browser-style headers first and fall back to the neutral
// Pharos fetch identity (mirrors the reservoir adapter's fallback shape).
const MENTO_BROWSER_HEADERS = buildBrowserHeaders("https://reserve.mento.org", "https://reserve.mento.org/");

async function fetchMentoWithBrowserFallback<T>(
  signal: AbortSignal,
  fetcher: (headers: HeadersInit) => Promise<T>,
): Promise<T> {
  try {
    return await fetcher(MENTO_BROWSER_HEADERS);
  } catch (primaryError) {
    if (signal.aborted) throw primaryError;
    try {
      return await fetcher(NEUTRAL_ADAPTER_HEADERS);
    } catch (fallbackError) {
      if (signal.aborted) throw fallbackError;
      throw new Error(
        `browser fetch failed: ${toErrorMessage(primaryError)}; neutral fetch failed: ${toErrorMessage(fallbackError)}`,
      );
    }
  }
}

const CDP_COLLATERAL_CONFIG: Record<string, TokenConfig & { depType: ReserveSlice["depType"] }> = {
  USDm: {
    key: "USDm",
    name: "USDm (Mento Dollar) CDP collateral",
    risk: "low",
    coinId: "cusd-celo",
    stableLike: true,
    depType: "collateral",
  },
};

function getCollateralAssets(payload: unknown): MentoReserveApiAsset[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("mento: layout-changed: response was not an object");
  }

  const response = payload as MentoReserveApiResponse;
  const assets = response.collateral?.assets;
  if (!Array.isArray(assets)) {
    throw new Error("mento: layout-changed: missing collateral.assets");
  }

  return assets;
}

export function parseMentoReserveComposition(payload: unknown): MentoReserveEntry[] {
  const assets = getCollateralAssets(payload);
  const entries = assets.flatMap((asset) => (
    typeof asset.symbol === "string" && typeof asset.percentage === "number"
      ? [{ symbol: asset.symbol, percent: asset.percentage }]
      : []
  ));

  if (entries.length === 0) {
    throw new Error("mento: layout-changed: collateral.assets contained no usable entries");
  }

  return entries;
}

function getCdpTroves(payload: unknown): MentoCdpTroveApiEntry[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("mento: layout-changed: response was not an object");
  }

  const response = payload as MentoReserveApiResponse;
  const troves = response.cdp_troves?.troves;
  if (!Array.isArray(troves)) {
    throw new Error("mento: layout-changed: missing cdp_troves.troves");
  }

  return troves;
}

function parseFiniteUsd(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

export function parseMentoCdpComposition(payload: unknown, cdpStablecoin: MentoCdpStablecoin): MentoCdpTroveEntry[] {
  const troves = getCdpTroves(payload);
  const entries = troves.flatMap((trove) => {
    if (trove.stablecoin !== cdpStablecoin || trove.status !== "active" || typeof trove.collateral_token !== "string") {
      return [];
    }

    const collateralUsd = parseFiniteUsd(trove.collateral_usd);
    const debtUsd = parseFiniteUsd(trove.debt_usd);
    if (collateralUsd == null || collateralUsd <= 0 || debtUsd == null) {
      return [];
    }

    return [{
      stablecoin: cdpStablecoin,
      collateralToken: trove.collateral_token,
      collateralUsd,
      debtUsd,
      ...(typeof trove.ratio === "number" && Number.isFinite(trove.ratio) ? { ratio: trove.ratio } : {}),
    }];
  });

  if (entries.length === 0) {
    throw new Error(`mento: layout-changed: cdp_troves.troves contained no active ${cdpStablecoin} entries`);
  }

  return entries;
}

export function extractMentoDashboardTimestamp(html: string): number | null {
  const payloadWindow = extractMentoDashboardPayloadWindow(html);
  if (!payloadWindow) return null;

  const timestamp = payloadWindow.match(MENTO_DASHBOARD_TIMESTAMP_IN_WINDOW_PATTERN)?.[1];
  const parsedTimestamp = parseTimestampLikeToUnixSeconds(timestamp);
  if (parsedTimestamp != null && MENTO_DASHBOARD_DATA_UPDATE_COUNT_IN_WINDOW_PATTERN.test(payloadWindow)) {
    return parsedTimestamp;
  }

  const dataUpdatedAt = payloadWindow.match(MENTO_DASHBOARD_DATA_UPDATED_AT_IN_WINDOW_PATTERN)?.[1];
  return parseTimestampLikeToUnixSeconds(dataUpdatedAt);
}

const MENTO_DASHBOARD_CDP_BACKINGS_KEY = "cdp_backings";

export interface MentoCdpBackingTotals {
  collateralUsd: number;
  debtUsd: number;
}

/**
 * Parses the dashboard's escaped `cdp_backings` array from the Next.js Flight
 * payload into per-stablecoin collateral/debt totals. Returns null when the
 * dashboard payload does not carry the array or it cannot be decoded.
 */
export function parseMentoDashboardCdpBackings(html: string): Map<string, MentoCdpBackingTotals> | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      extractEscapedJsonValueAfterKey(html, MENTO_DASHBOARD_CDP_BACKINGS_KEY, "mento"),
    );
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) return null;

  const totals = new Map<string, MentoCdpBackingTotals>();
  for (const entry of decoded) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.stablecoin !== "string") continue;
    const collateralUsd = parseFiniteUsd(record.collateral_usd);
    const debtUsd = parseFiniteUsd(record.debt_usd);
    if (collateralUsd == null || debtUsd == null) continue;
    const existing = totals.get(record.stablecoin);
    if (existing) {
      existing.collateralUsd += collateralUsd;
      existing.debtUsd += debtUsd;
    } else {
      totals.set(record.stablecoin, { collateralUsd, debtUsd });
    }
  }
  return totals.size > 0 ? totals : null;
}

const MENTO_DASHBOARD_COHERENCE_MAX_DIVERGENCE = 0.01;

function mentoCdpDivergence(api: number, dashboard: number): number {
  const denominator = Math.max(Math.abs(api), Math.abs(dashboard));
  return denominator === 0 ? 0 : Math.abs(api - dashboard) / denominator;
}

/**
 * Dashboard-vs-API coherence gate for CDP coins: the dashboard's
 * per-stablecoin `cdp_backings` totals and the analytics API's summed
 * `cdp_troves` totals must agree within 1%. Returns an error naming both
 * values when they diverge — the two sources then disagree materially and
 * neither can be trusted — or null when they agree.
 */
export function mentoCdpCoherenceError(
  cdpStablecoin: string,
  dashboard: MentoCdpBackingTotals,
  apiCollateralUsd: number,
  apiDebtUsd: number,
): Error | null {
  const collateralDivergence = mentoCdpDivergence(apiCollateralUsd, dashboard.collateralUsd);
  const debtDivergence = mentoCdpDivergence(apiDebtUsd, dashboard.debtUsd);
  if (
    collateralDivergence <= MENTO_DASHBOARD_COHERENCE_MAX_DIVERGENCE
    && debtDivergence <= MENTO_DASHBOARD_COHERENCE_MAX_DIVERGENCE
  ) {
    return null;
  }
  return new Error(
    `mento dashboard-vs-API coherence failed for ${cdpStablecoin}: dashboard collateral/debt $${dashboard.collateralUsd.toFixed(2)}/$${dashboard.debtUsd.toFixed(2)} vs analytics API $${apiCollateralUsd.toFixed(2)}/$${apiDebtUsd.toFixed(2)}`,
  );
}

export function adaptMentoReserveComposition(payload: unknown, sourceTimestamp: number | null = null): AdapterResult {
  const entries = parseMentoReserveComposition(payload);
  const warnings: LiveReserveWarning[] = [];

  if (entries.length < 3) {
    warnings.push(reserveInfoWarning(
      "mento-low-entry-count",
      `Mento reserve composition has only ${entries.length} entries (expected >= 3)`,
    ));
  }

  const grouped = new Map<string, {
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    pct: number;
    stableLike: boolean;
  }>();

  let stablePct = 0;
  for (const entry of entries) {
    const config = TOKEN_CONFIG[entry.symbol];
    if (!config) {
      warnings.push(reserveDegradedWarning("unknown-asset", `Unmapped Mento reserve symbol: ${entry.symbol}`));
      const existing = grouped.get(entry.symbol);
      if (existing) {
        existing.pct += entry.percent;
      } else {
        grouped.set(entry.symbol, {
          name: entry.symbol,
          risk: "medium",
          pct: entry.percent,
          stableLike: false,
        });
      }
      continue;
    }

    const existing = grouped.get(config.key);
    if (existing) {
      existing.pct += entry.percent;
    } else {
      grouped.set(config.key, {
        name: config.name,
        risk: config.risk,
        coinId: config.coinId,
        pct: entry.percent,
        stableLike: config.stableLike ?? false,
      });
    }

    if (config.stableLike) {
      stablePct += entry.percent;
    }
  }

  const totalPct = entries.reduce((sum, entry) => sum + entry.percent, 0);
  const slices = slicesFromPercentages(
    Array.from(grouped.values(), (group) => ({
      name: group.name,
      pct: group.pct,
      risk: group.risk,
      ...(group.coinId ? { coinId: group.coinId } : {}),
    })),
    { decimals: 1, context: "Mento reserve composition" },
  );

  return {
    slices,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      diag: { rawSumDeviation: Math.abs(totalPct - 100) },
      entryCount: entries.length,
      totalPct,
      ...(sourceTimestamp != null
        ? sameRunRenderClockFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "mento-analytics-api",
            "Mento analytics API exposes reserve composition but not a trustworthy payload update timestamp",
          )),
      stableReservePct: stablePct,
    },
  };
}

export function adaptMentoCdpComposition(
  payload: unknown,
  cdpStablecoin: MentoCdpStablecoin,
  sourceTimestamp: number | null = null,
): AdapterResult {
  const entries = parseMentoCdpComposition(payload, cdpStablecoin);
  const warnings: LiveReserveWarning[] = [];

  const grouped = new Map<string, {
    name: string;
    risk: ReserveSlice["risk"];
    coinId?: string;
    depType?: ReserveSlice["depType"];
    value: number;
  }>();

  for (const entry of entries) {
    const config = CDP_COLLATERAL_CONFIG[entry.collateralToken];
    if (!config) {
      warnings.push(reserveDegradedWarning(
        "unknown-cdp-collateral",
        `Unmapped Mento CDP collateral token for ${cdpStablecoin}: ${entry.collateralToken}`,
      ));
    }

    const key = config?.key ?? entry.collateralToken;
    const existing = grouped.get(key);
    if (existing) {
      existing.value += entry.collateralUsd;
    } else {
      grouped.set(key, {
        name: config?.name ?? entry.collateralToken,
        risk: config?.risk ?? "medium",
        ...(config?.coinId ? { coinId: config.coinId } : {}),
        ...(config?.depType ? { depType: config.depType } : {}),
        value: entry.collateralUsd,
      });
    }
  }

  const totalCollateralUsd = entries.reduce((sum, entry) => sum + entry.collateralUsd, 0);
  const totalDebtUsd = entries.reduce((sum, entry) => sum + entry.debtUsd, 0);
  const collateralizationRatio = totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : undefined;

  return {
    slices: slicesFromValues(
      Array.from(grouped.values(), (group) => ({
        name: group.name,
        value: group.value,
        risk: group.risk,
        ...(group.coinId ? { coinId: group.coinId } : {}),
        ...(group.depType ? { depType: group.depType } : {}),
      })),
    ),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      cdpStablecoin,
      cdpActiveTroves: entries.length,
      totalCollateralUsd,
      totalDebtUsd,
      ...(collateralizationRatio != null ? { collateralizationRatio } : {}),
      ...(sourceTimestamp != null
        ? sameRunRenderClockFreshnessMetadata(sourceTimestamp)
        : unverifiedFreshnessMetadata(
            "mento-analytics-api",
            "Mento analytics API exposes CDP collateral and debt but not a trustworthy payload update timestamp",
          )),
    },
  };
}

interface MentoDashboardSnapshot {
  sourceTimestamp: number | null;
  cdpBackings: Map<string, MentoCdpBackingTotals> | null;
}

async function fetchMentoDashboardSnapshot(
  config: LiveReservesConfig,
  signal: AbortSignal,
  warnings: LiveReserveWarning[],
  ctx?: AdapterContext,
): Promise<MentoDashboardSnapshot | null> {
  const url = config.display?.url;
  if (!url) return null;
  try {
    const html = await fetchMentoWithBrowserFallback(
      signal,
      (headers) => fetchTextWithRetry(url, signal, 12_000, ctx, { headers }),
    );
    return {
      sourceTimestamp: extractMentoDashboardTimestamp(html),
      cdpBackings: parseMentoDashboardCdpBackings(html),
    };
  } catch (error) {
    warnings.push(reserveInfoWarning(
      "mento-dashboard-timestamp-failed",
      `Mento dashboard timestamp fetch failed (${url}): ${toErrorMessage(error)}`,
    ));
    return null;
  }
}

const MENTO_REDEMPTION_TIMEOUT_MS = 8_000;

export async function fetchMentoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, "mento");
  const dashboardWarnings: LiveReserveWarning[] = [];
  const [payload, dashboard] = await Promise.all([
    fetchMentoWithBrowserFallback(
      signal,
      (headers) => fetchJsonWithRetry<MentoReserveApiResponse>(input.url, signal, 12_000, ctx, { headers }),
    ),
    fetchMentoDashboardSnapshot(config, signal, dashboardWarnings, ctx),
  ]);
  const params = parseLiveReserveAdapterParams("mento", config.params);
  const result = params.cdpStablecoin
    ? adaptMentoCdpComposition(payload, params.cdpStablecoin, dashboard?.sourceTimestamp ?? null)
    : adaptMentoReserveComposition(payload, dashboard?.sourceTimestamp ?? null);

  // Dashboard-vs-API coherence gate: when the dashboard carries per-stablecoin
  // CDP totals for this coin and the analytics API trove sums materially
  // disagree, neither source can be trusted and the attempt fails closed.
  if (params.cdpStablecoin) {
    const dashboardTotals = dashboard?.cdpBackings?.get(params.cdpStablecoin);
    const apiCollateralUsd = result.metadata?.totalCollateralUsd;
    const apiDebtUsd = result.metadata?.totalDebtUsd;
    if (dashboardTotals && typeof apiCollateralUsd === "number" && typeof apiDebtUsd === "number") {
      const coherenceError = mentoCdpCoherenceError(
        params.cdpStablecoin,
        dashboardTotals,
        apiCollateralUsd,
        apiDebtUsd,
      );
      if (coherenceError) throw coherenceError;
    } else if (dashboard && !dashboard.cdpBackings?.has(params.cdpStablecoin)) {
      // The dashboard was fetched but no longer carries per-stablecoin totals
      // for this coin (renamed/dropped `cdp_backings` row): the coherence gate
      // cannot run, and skipping it silently would hide exactly the upstream
      // drift the gate exists to catch.
      dashboardWarnings.push(reserveDegradedWarning(
        "mento-cdp-coherence-unavailable",
        `Mento dashboard carried no cdp_backings totals for ${params.cdpStablecoin}; dashboard-vs-API coherence gate skipped`,
      ));
    }
  }

  const warnings = [...(result.warnings ?? []), ...dashboardWarnings];

  if (!params.redemption) {
    return warnings.length > 0 ? { ...result, warnings } : result;
  }

  try {
    const redemptionTimeout = createTimeoutSignal({
      timeoutMs: MENTO_REDEMPTION_TIMEOUT_MS,
      timeoutReason: new Error("mento-redemption-timeout"),
      parentSignal: signal,
    });
    let redemptionMetadata: NonNullable<AdapterResult["metadata"]>;
    try {
      redemptionMetadata = await fetchMentoRedemptionMetadata(params.redemption, redemptionTimeout.signal, ctx);
    } finally {
      redemptionTimeout.dispose();
    }
    return {
      ...result,
      ...(warnings.length > 0 ? { warnings } : {}),
      metadata: { ...result.metadata, ...redemptionMetadata },
    };
  } catch (error) {
    warnings.push(reserveDegradedWarning(
      "mento-redemption-telemetry-failed",
      `Mento redemption telemetry read failed: ${toErrorMessage(error)}`,
    ));
    return { ...result, warnings };
  }
}
