// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { useStablecoinDetailViewModel } from "../use-stablecoin-detail-view-model";
import { asMetaQueryOptions, createRegisteredApiPollingQueryOptions } from "../api-hooks";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { deriveDataHealth, mergeHealthStates } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
import { DISABLED_DETAIL_QUERY_CONTROLS } from "./use-stablecoin-detail-view-model.test-support";
import { apiFetchWithMeta } from "@/lib/api";

interface CapturedResponse {
  body: unknown;
  headers: Record<string, string>;
  revalidatedHeaders?: Record<string, string>;
  capturedAtMs: number;
}
// Exact authenticated production responses captured on 2026-10-10, including
// independent producer timestamps, edge Age/Date, and unmodified response bodies.
const captured = JSON.parse(gunzipSync(readFileSync(
  `${process.cwd()}/src/hooks/__tests__/fixtures/stablecoin-freshness-production.json.gz`,
)).toString()) as Record<"stablecoins" | "detail" | "browser-detail" | "supply-history" | "peg-summary", CapturedResponse>;

function response(name: keyof typeof captured): Response {
  return Response.json(captured[name].body, { headers: captured[name].headers });
}

describe("production stablecoin freshness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["detail", "browser-detail"] as const)("keeps the real %s producer fresh through the registered hook and dossier health entries", async (lane) => {
    const now = captured[lane].capturedAtMs;
    vi.spyOn(Date, "now").mockReturnValue(now);
    if (lane === "browser-detail") {
      vi.stubGlobal("fetch", vi.fn(async () => response(lane)));
      const before = await apiFetchWithMeta("/api/stablecoin/usdt-tether");
      expect(deriveDataHealth({
        ...DATA_HEALTH_PRESETS.stablecoins, dataUpdatedAt: now, hasData: true, meta: before.meta,
      }, now).state).toBe("stale");
    }
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/stablecoin/usdt-tether")) {
        if (lane === "detail") return response(lane);
        return Response.json(captured[lane].body, { headers: captured[lane].revalidatedHeaders });
      }
      if (url.includes("/supply-history")) return response("supply-history");
      if (url.includes("/peg-summary")) return response("peg-summary");
      throw new Error(`Unexpected production replay request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const { result, unmount } = renderHook(() => useStablecoinDetailViewModel({
      id: coin.id, coin, summary: null, supplementalQueryControls: DISABLED_DETAIL_QUERY_CONTROLS,
    }), { wrapper });
    try {
      await waitFor(() => {
        expect(result.current.status).toBe("ready");
        expect(client.getQueryState(["supply-history", coin.id, 90])?.status).toBe("success");
        expect(client.getQueryState(["peg-summary"])?.status).toBe("success");
      });
      if (result.current.status !== "ready") throw new Error("Expected a ready dossier");
      const entries = result.current.staleQueries.map((query) => deriveDataHealth({
        ...(query.preset ? DATA_HEALTH_PRESETS[query.preset] : { label: query.label!, staleTime: query.staleTime! }),
        ...query,
      }, now));
      const prices = entries.find((entry) => entry.label === "Detail snapshot")!;
      expect(prices.ageMs).toBeGreaterThan(lane === "detail" ? 12 * 60_000 : 5 * 60_000);
      expect(prices.dataUpdatedAt).toBe(Number(captured[lane].headers["x-data-updated-at"]) * 1000);
      expect(prices.state).toBe("fresh");
      expect(mergeHealthStates(entries).state).toBe("fresh");
    } finally {
      unmount();
      client.clear();
    }
  });


  it.each(["homepage", "depeg", "safety-scores", "yield"])("keeps the shared real stablecoins producer fresh on %s", async () => {
    const now = captured.stablecoins.capturedAtMs;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", vi.fn(async () => response("stablecoins")));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const options = asMetaQueryOptions(createRegisteredApiPollingQueryOptions(FRONTEND_API_QUERY_DESCRIPTORS.stablecoins));
      const result = await client.fetchQuery(options);
      const health = deriveDataHealth({
        ...DATA_HEALTH_PRESETS.stablecoins, dataUpdatedAt: now, hasData: result.data.peggedAssets.length > 0, meta: result.meta,
      }, now);
      expect(health.ageMs).toBeGreaterThan(12 * 60_000);
      expect(health.dataUpdatedAt).toBe(1791646281_000);
      expect(health.state).toBe("fresh");
    } finally {
      client.clear();
    }
  });
});
