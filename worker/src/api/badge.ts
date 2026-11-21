import {
  renderSafetyBadgeSvg,
  type SafetyBadgeState,
  type SafetyBadgeStyle,
  type SafetyBadgeTheme,
} from "@shared/lib/safety-badge-svg";
import { WORKER_ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { errorResponse } from "../lib/api-response";
import { loadActiveSafetyScoreIndex } from "../lib/safety-score-index";
import {
  isSafetyScoreV9SnapshotFresh,
  SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
} from "../lib/safety-score-v9/consumer-freshness";

const SVG_CONTENT_TYPE = "image/svg+xml; charset=utf-8";

export function parseSafetyBadgeOptions(url: URL): {
  style: SafetyBadgeStyle;
  theme: SafetyBadgeTheme;
} {
  const rawStyle = url.searchParams.get("style")?.trim().toLowerCase();
  const rawTheme = url.searchParams.get("theme")?.trim().toLowerCase();
  return {
    style: rawStyle === "card" ? "card" : "flat",
    theme: rawTheme === "light" ? "light" : "dark",
  };
}

export function buildUnavailableSafetyBadgeResponse(options: {
  symbol?: string;
  name?: string;
  style: SafetyBadgeStyle;
  theme: SafetyBadgeTheme;
  safetyStatus: "current" | "held" | "stale" | "unavailable";
  reason: string;
  retryAfterSec?: number;
  headOnly?: boolean;
}): Response {
  const svg = renderSafetyBadgeSvg(
    { kind: "unavailable", symbol: options.symbol, name: options.name },
    { style: options.style, theme: options.theme },
  );
  const headers: Record<string, string> = {
    "Content-Type": SVG_CONTENT_TYPE,
    "Cache-Control": "no-store",
    "X-Safety-Score-Status": options.safetyStatus,
    "X-Badge-Reason": options.reason,
  };
  if (options.retryAfterSec != null) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(options.retryAfterSec)));
  }
  return new Response(options.headOnly ? null : svg, { status: 200, headers });
}

export async function handleSafetyBadge(
  db: D1Database,
  canonicalId: string,
  url: URL,
  method: string = "GET",
): Promise<Response> {
  const meta = WORKER_ACTIVE_META_BY_ID.get(canonicalId);
  if (!meta) {
    return errorResponse(404, `Unknown or inactive stablecoin: ${canonicalId}`);
  }

  const { style, theme } = parseSafetyBadgeOptions(url);
  const headOnly = method === "HEAD";
  const index = await loadActiveSafetyScoreIndex(db);

  if (index.kind === "error") {
    return buildUnavailableSafetyBadgeResponse({
      symbol: meta.symbol,
      name: meta.name,
      style,
      theme,
      safetyStatus: "unavailable",
      reason: index.reason,
      headOnly,
    });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (index.kind === "held") {
    return buildUnavailableSafetyBadgeResponse({
      symbol: meta.symbol,
      name: meta.name,
      style,
      theme,
      safetyStatus: "held",
      reason: "v9-publication-held",
      headOnly,
    });
  }

  if (!isSafetyScoreV9SnapshotFresh(index.snapshot, nowSec)) {
    return buildUnavailableSafetyBadgeResponse({
      symbol: meta.symbol,
      name: meta.name,
      style,
      theme,
      safetyStatus: "stale",
      reason: "safety-score-publication-age",
      headOnly,
    });
  }

  const card = index.snapshot.cards.find((entry) => entry.id === canonicalId);
  if (!card || card.ratingStatus === "pipeline-gap") {
    return buildUnavailableSafetyBadgeResponse({
      symbol: meta.symbol,
      name: meta.name,
      style,
      theme,
      safetyStatus: "current",
      reason: card ? "pipeline-gap" : "not-in-safety-index",
      headOnly,
    });
  }

  let badgeState: SafetyBadgeState;
  if (card.ratingStatus === "not-rated" || card.score == null || card.grade == null || card.grade === "NR") {
    badgeState = { kind: "not-rated", symbol: meta.symbol, name: meta.name };
  } else {
    badgeState = {
      kind: "rated",
      symbol: meta.symbol,
      name: meta.name,
      grade: card.grade,
      score: card.score,
    };
  }

  const remainingRunway = Math.floor(
    index.snapshot.updatedAt + SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - nowSec,
  );
  const sMaxage = remainingRunway > 1 ? Math.min(300, remainingRunway - 1) : 0;
  const maxAge = Math.min(60, sMaxage);
  const cacheControl = sMaxage > 0
    ? `public, s-maxage=${sMaxage}, max-age=${maxAge}`
    : "no-store";

  const svg = renderSafetyBadgeSvg(badgeState, { style, theme });
  const headers: Record<string, string> = {
    "Content-Type": SVG_CONTENT_TYPE,
    "Cache-Control": cacheControl,
    "X-Safety-Score-Status": "current",
    "X-Safety-Score-Generation": index.snapshot.safetyScoreIdentity.publicationGenerationId,
    "X-Data-Updated-At": String(index.snapshot.updatedAt),
    "X-Data-Freshness-Budget": String(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC),
    ...(sMaxage > 0 ? { Date: new Date(nowSec * 1000).toUTCString() } : {}),
  };

  return new Response(headOnly ? null : svg, { status: 200, headers });
}
