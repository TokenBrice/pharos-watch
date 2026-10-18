import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { isDetailSnapshotQuery, seedStablecoinDetailQueryCache, type StablecoinDetailSnapshot } from "@/lib/api";

const key = ["supply-history", "usdt-tether", 90];
const snapshot: StablecoinDetailSnapshot = {
  version: 1, stablecoinId: "usdt-tether", generatedAt: 1_800_000_000_000,
  updatedAt: { supplyHistory: 1_700_000_000_000 }, lanes: { supplyHistory: [] },
};

describe("detail snapshot refresh provenance", () => {
  it("marks only seeded generations and never reclassifies an equal-clock settled read as a new seed", async () => {
    const client = new QueryClient();
    try {
      expect(isDetailSnapshotQuery(client, key)).toBe(false);
      seedStablecoinDetailQueryCache(client, snapshot);
      expect(isDetailSnapshotQuery(client, key)).toBe(true);
      await client.fetchQuery({ queryKey: key, queryFn: async () => ({
        data: [], meta: { updatedAt: snapshot.updatedAt.supplyHistory! / 1000, status: "stale", ageSeconds: 36000 },
      }) });
      expect(isDetailSnapshotQuery(client, key)).toBe(false);
      seedStablecoinDetailQueryCache(client, snapshot);
      expect(isDetailSnapshotQuery(client, key)).toBe(false);
      expect(client.getQueryData(key)).toMatchObject({ meta: { status: "stale" } });
    } finally {
      client.clear();
    }
  });

  it("settles failed reads permanently even though their saved generation remains in cache", async () => {
    const client = new QueryClient();
    try {
      seedStablecoinDetailQueryCache(client, snapshot);
      await expect(client.fetchQuery({ queryKey: key, retry: false, queryFn: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
      expect(isDetailSnapshotQuery(client, key)).toBe(false);
      seedStablecoinDetailQueryCache(client, snapshot);
      expect(isDetailSnapshotQuery(client, key)).toBe(false);
      expect(client.getQueryState(key)?.error).toBeInstanceOf(Error);
      expect(client.getQueryData(key)).toMatchObject({ data: [], meta: { updatedAt: snapshot.updatedAt.supplyHistory! / 1000 } });
    } finally {
      client.clear();
    }
  });
});
