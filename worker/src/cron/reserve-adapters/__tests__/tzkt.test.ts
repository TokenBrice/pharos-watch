import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTzktBigmapKeys } from "../tzkt";
import { installAdapterNetwork } from "./reserve-adapter.test-support";

afterEach(() => vi.restoreAllMocks());
const valid = { key: "vault", value: { balance: "100" } };
const firstUrl = "https://api.tzkt.io/v1/bigmaps/42/keys?active=true&level=100&limit=10000&offset=0";
const nextUrl = firstUrl.replace("offset=0", "offset=10000");

describe("TzKT complete bigmap census", () => {
  for (const size of [2, 10_000]) {
    it.each([null, 7, "bad", {}, { key: "missing-value" }, { value: {} }, { key: "array-value", value: [] }])(
      `rejects malformed member %j on a ${size === 2 ? "final" : "nonfinal"} page`, async (malformed) => {
        const page: unknown[] = Array.from({ length: size }, () => valid);
        page[1] = malformed;
        const network = installAdapterNetwork({ json: { [firstUrl]: page } });
        await expect(fetchTzktBigmapKeys("https://api.tzkt.io", 42, 100, new AbortController().signal))
          .rejects.toThrow(/bigmap 42 row 1/);
        expect(network.requests).toHaveLength(1);
      },
    );
  }
  it("preserves valid pinned pagination", async () => {
    const network = installAdapterNetwork({ json: {
      [firstUrl]: Array.from({ length: 10_000 }, () => valid), [nextUrl]: [valid],
    } });
    const result = await fetchTzktBigmapKeys("https://api.tzkt.io", 42, 100, new AbortController().signal);
    expect(result).toHaveLength(10_001);
    expect(network.requests.map((request) => request.url)).toEqual([firstUrl, nextUrl]);
  });
  it("reports absolute row indices on later pages", async () => {
    installAdapterNetwork({ json: { [firstUrl]: Array.from({ length: 10_000 }, () => valid), [nextUrl]: [null] } });
    await expect(fetchTzktBigmapKeys("https://api.tzkt.io", 42, 100, new AbortController().signal))
      .rejects.toThrow(/bigmap 42 row 10000/);
  });
});
