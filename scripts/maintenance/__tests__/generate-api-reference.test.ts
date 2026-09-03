import { readFileSync } from "node:fs";
import { join } from "node:path";
import GithubSlugger from "github-slugger";
import { describe, expect, it } from "vitest";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/data-surface-descriptors";
import {
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  CHAIN_HEALTH_METHODOLOGY_VERSION,
} from "@shared/lib/methodology-versions/constants";

import {
  END_MARKER,
  START_MARKER,
  collectOpenApiRoutes,
  loadOpenapi,
  renderGeneratedBlock,
} from "../generate-api-reference";

const PRE_SPLIT_PUBLIC_ANCHORS = [
  "pharos-api-reference", "surface-split", "public-api-auth", "stablecoin-ids", "response-headers",
  "response-body-freshness-_meta", "cache-control-profiles", "polling-guidance", "rate-limits", "per-key-limit",
  "retry-guidance", "error-response-conventions", "method-gating-policy", "public-endpoints",
  "public-endpoints-quick-reference", "get-apievents", "get-apistablecoins", "get-apistablecoinid",
  "get-apistablecoin-summaryid", "get-apinon-usd-share", "get-apichains", "get-apistablecoin-reservesid",
  "get-apistablecoin-charts", "get-apiblacklist", "get-apiblacklist-summary", "get-apidepeg-events",
  "get-apidepeg-resolver", "get-apidepeg-resolver-review", "get-apipeg-summary", "get-apiusds-status",
  "get-apibluechip-ratings", "get-apidex-liquidity", "get-apidex-liquidity-history", "get-apisupply-history",
  "get-apidaily-digest", "get-apidigest-archive", "get-apidigest-snapshot", "get-apisnapshotsindex",
  "get-apisnapshotsdatejson", "get-apisnapshotdatestablecoinid", "get-apihealth", "get-apipublic-status-history",
  "get-apitelegram-pulse", "get-apistability-index", "get-apiog", "get-apireport-cardsv9",
  "get-apiredemption-backstops", "get-apisafety-score-history", "get-apisafety-score-history-v2",
  "get-apiyield-rankings", "get-apiyield-adapter-manifest", "get-apiyield-history", "get-apimint-burn-flows",
  "get-apimint-burn-events", "get-apistress-signals", "post-apiapi-key-requests",
  "post-apiapi-key-requestsverify", "post-apifeedback", "post-apitelegram-mini-appsession",
  "post-apitelegram-mini-appmutate", "post-apitelegram-webhook", "pages-function-endpoints",
  "get-selector-snapshotsid", "post-pharoswatchbot-adoption", "post-selector-snapshot",
] as const;

function headingIds(markdown: string): string[] {
  const slugger = new GithubSlugger();
  return Array.from(markdown.matchAll(/^#{1,6}\s+(.+)$/gm), (match) => slugger.slug(match[1]?.replace(/\s+#+\s*$/, "") ?? ""));
}

describe("generate-api-reference", () => {
  it("preserves every pre-split public heading anchor", () => {
    const markdown = readFileSync(join(process.cwd(), "docs/api-reference.md"), "utf8");
    expect(headingIds(markdown)).toEqual(PRE_SPLIT_PUBLIC_ANCHORS);
  });

  it("generates route sections from OpenAPI and shared endpoint policy", () => {
    const spec = loadOpenapi();
    const routes = collectOpenApiRoutes(spec);
    const block = renderGeneratedBlock(spec);

    expect(routes).toHaveLength(39);
    expect(block.startsWith(START_MARKER)).toBe(true);
    expect(block.endsWith(END_MARKER)).toBe(true);
    expect(block).toContain("### `GET /api/stablecoins`");
    expect(block).toContain("[`StablecoinListResponse`](https://pharos.watch/openapi.json#/components/schemas/StablecoinListResponse)");
    expect(block).toContain("`cacheBypass: false`");
    expect(block.indexOf("### `GET /api/stablecoins`")).toBeLessThan(block.indexOf(END_MARKER));
    expect(block).toContain(`"currentVersion": "${BLACKLIST_TRACKER_METHODOLOGY_VERSION}"`);
    expect(block).toContain(`"healthMethodologyVersion": "${CHAIN_HEALTH_METHODOLOGY_VERSION}"`);
    expect(block).toContain(`Freshness threshold: ${API_FRESHNESS_MAX_AGE_SEC.stressSignals} s.`);
    expect(block).toContain(`"maxAge": ${CACHE_FRESHNESS_LANES.dexLiquidity.availabilityMaxAgeSec}`);
    expect(block).toContain("| `geckoId` | `string \\| null` |");
    expect(block).toContain("**Capacity-confidence vocabulary:** `live-direct`, `live-proxy`");
  });
});
