import { mockFetch } from "@shared/test-utils/mock-fetch";
import type { AdapterResult } from "../types";
import { fetchReservoirReserves, type ReservoirReservesResponse } from "../reservoir";

export async function runReservoir(coinId: string, payload: ReservoirReservesResponse, rejectBrowserHeaders = false) {
  const transport = mockFetch([{
    match: "https://example.com/reservoir",
    respond: (request) => {
      const browser = request.headers.get("origin") === "https://app.reservoir.xyz"
        && request.headers.get("referer") === "https://app.reservoir.xyz/reserves";
      if (browser && rejectBrowserHeaders) return { body: {}, status: 403 };
      if (!browser && request.headers.has("origin")) throw new Error("Unexpected Reservoir origin");
      return { body: payload };
    },
  }], { strictUrl: true, requireMatch: true });
  const result = await fetchReservoirReserves(
    { id: coinId } as never,
    { adapter: "reservoir", version: 1, semantics: "protocol-reserve", inputs: { primary: { kind: "http-json", url: "https://example.com/reservoir" } } },
    new AbortController().signal,
    { requestCache: new Map() },
  );
  transport.assertAllRoutesUsed();
  return { result, requests: transport.getHistory() };
}

export function reservoirSnapshot(result: AdapterResult, now: number) {
  if (!result.metadata) throw new Error("Reservoir fixture did not emit metadata");
  return {
    stablecoinId: "wsrusd-reservoir", fetchedAt: now, source: "reservoir", metadata: result.metadata,
    warningCount: 0, warnings: [], sourceModel: "dynamic-mix" as const,
    evidenceClass: "independent" as const, syncStatus: "ok" as const,
  };
}
